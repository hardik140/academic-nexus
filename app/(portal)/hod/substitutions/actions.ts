"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { assertClaimed } from "@/lib/concurrent-claim";
import { PERMISSIONS } from "@/lib/permissions";

function substitutionsCacheKey(hodUserId: string) {
  return `hod-substitutions:${hodUserId}`;
}

/** Resolves the department a HOD actor owns, via departments.hod_id — same as hod/approvals. */
async function resolveHodDepartmentId(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { data } = await supabase.from("departments").select("id").eq("hod_id", userId).single();
  return data?.id ?? null;
}

// The course, section and semester all hang off the OFFERING now —
// substitution_assignments.course_id was dropped by 047, and a substitution
// covers one delivery of a course, not the catalog entry.
const SELECT_COLS =
  "*, course_offerings:offering_id(id, courses:course_id(name, code, department_id), sections:section_id(name), semesters:semester_id(name)), original:original_teacher_id(full_name), substitute:substitute_teacher_id(full_name)";

/**
 * Department-scoped by the *course's* department, same as
 * listCorrectionApprovals — a substitution requirement is a claim about a
 * specific course's class, so the course's own department is the right
 * approval boundary.
 */
export async function listSubstitutionNeeds() {
  const actor = await requireRole(PERMISSIONS.substitution_manage);
  const supabase = await createClient();

  return getCached(substitutionsCacheKey(actor.userId), 30, async () => {
    if (actor.role === "admin") {
      const baseQuery = () => supabase.from("substitution_assignments").select(SELECT_COLS);
      const [neededRes, assignedRes] = await Promise.all([
        baseQuery().eq("status", "needed").order("date", { ascending: true }),
        baseQuery().eq("status", "assigned").order("date", { ascending: true }),
      ]);
      return { needed: neededRes.data || [], assigned: assignedRes.data || [] };
    }

    const departmentId = await resolveHodDepartmentId(supabase, actor.userId);
    if (!departmentId) return { needed: [], assigned: [] };

    // Department scope resolves through the offering's course. Two hops now
    // (offerings of this department's courses, then substitutions on those
    // offerings) because substitution_assignments no longer carries a course.
    const { data: deptOfferings } = await supabase
      .from("course_offerings")
      .select("id, courses:course_id!inner(department_id)")
      .eq("courses.department_id", departmentId);
    const offeringIds = ((deptOfferings as unknown as { id: string }[]) || []).map((o) => o.id);
    if (offeringIds.length === 0) return { needed: [], assigned: [] };

    const baseQuery = () => supabase.from("substitution_assignments").select(SELECT_COLS).in("offering_id", offeringIds);
    const [neededRes, assignedRes] = await Promise.all([
      baseQuery().eq("status", "needed").order("date", { ascending: true }),
      baseQuery().eq("status", "assigned").order("date", { ascending: true }),
    ]);
    return { needed: neededRes.data || [], assigned: assignedRes.data || [] };
  });
}

/** Populates the substitute picker — department teachers, any role='teacher' or 'hod' account. */
export async function listDepartmentTeachers() {
  const actor = await requireRole(PERMISSIONS.substitution_manage);
  const supabase = await createClient();

  if (actor.role === "admin") {
    const { data } = await supabase.from("profiles").select("id, full_name").in("role", ["teacher", "hod"]).order("full_name");
    return data || [];
  }

  const departmentId = await resolveHodDepartmentId(supabase, actor.userId);
  if (!departmentId) return [];
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("department_id", departmentId)
    .in("role", ["teacher", "hod"])
    .order("full_name");
  return data || [];
}

const AssignSchema = z.object({
  id: z.string().guid(),
  substituteTeacherId: z.string().guid(),
});

export async function assignSubstitute(idRaw: string, substituteTeacherIdRaw: string) {
  const actor = await requireRole(PERMISSIONS.substitution_manage);
  const { id, substituteTeacherId } = AssignSchema.parse({ id: idRaw, substituteTeacherId: substituteTeacherIdRaw });
  await checkRateLimit(`assignSubstitute:${actor.userId}`, 30, 60);
  const supabase = await createClient();

  type RowWithCourse = {
    status: string;
    offering_id: string;
    date: string;
    original_teacher_id: string;
    course_offerings: {
      courses: { department_id: string; name: string; code: string } | null;
      sections: { name: string } | null;
    } | null;
  };
  const { data: rowRaw } = await supabase
    .from("substitution_assignments")
    .select("status, offering_id, date, original_teacher_id, course_offerings:offering_id(courses:course_id(department_id, name, code), sections:section_id(name))")
    .eq("id", id)
    .eq("college_id", actor.collegeId)
    .single();
  const row = rowRaw as unknown as RowWithCourse | null;

  if (!row || row.status !== "needed") {
    throw new Error("Substitution requirement not found or already resolved.");
  }
  if (row.original_teacher_id === substituteTeacherId) {
    throw new Error("The substitute cannot be the same as the original teacher.");
  }

  if (actor.role === "hod") {
    const departmentId = await resolveHodDepartmentId(supabase, actor.userId);
    if (!departmentId || row.course_offerings?.courses?.department_id !== departmentId) {
      throw new Error("You can only assign substitutes for courses in your own department.");
    }
  }

  // Compare-and-swap on 'needed' — two HODs assigning different substitutes
  // to the same slot at once would otherwise both "succeed", with the loser's
  // teacher still receiving the "assigned to you" notification below for a
  // class they aren't actually covering. See lib/concurrent-claim.ts.
  const { data: claimed, error } = await supabase
    .from("substitution_assignments")
    .update({ status: "assigned", substitute_teacher_id: substituteTeacherId, assigned_by: actor.userId, assigned_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "needed")
    .select("id");
  if (error) {
    throw new Error(error.message);
  }
  assertClaimed(claimed, "substitution requirement");

  await logAudit(supabase, actor, "substitution_assigned", "substitution_assignments", id, {
    oldValue: { status: "needed" },
    newValue: { status: "assigned", substitute_teacher_id: substituteTeacherId },
  });

  await supabase.from("notifications").insert({
    college_id: actor.collegeId,
    title: "Substitution assigned to you",
    // Names the SECTION too: "cover CS201" is ambiguous when a course runs
    // in three sections, and the substitute needs to know which class.
    message: `Cover ${row.course_offerings?.courses?.code || "a class"}${
      row.course_offerings?.sections?.name ? ` (${row.course_offerings.sections.name})` : ""
    } — ${row.course_offerings?.courses?.name || ""} on ${new Date(row.date).toLocaleDateString()}.`,
    receiver_id: substituteTeacherId,
    sender_id: actor.userId,
    type: "action_required",
    link: `/teacher/attendance?offering=${row.offering_id}`,
  });

  await invalidateCache(substitutionsCacheKey(actor.userId));
  revalidatePath("/hod/substitutions");
  revalidatePath("/hod/dashboard");
}
