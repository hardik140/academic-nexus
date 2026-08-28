"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { computeAffectedClasses } from "@/lib/leave-impact";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const ActOnLeaveRequestSchema = z.object({
  requestId: z.string().guid(),
  action: z.enum(["approved", "rejected"]),
});

const PROCESSED_LIMIT = 20;

function hodApprovalsCacheKey(hodUserId: string) {
  return `hod-approvals:${hodUserId}`;
}

/**
 * Department-scoped, not just college-scoped — keyed by the HOD's own
 * user id (two HODs in the same college must never share a cache entry,
 * unlike everything else in Phase 3 which is safely college-scoped).
 * Returns {pending, processed} together in one cache entry, same
 * "simpler than coordinating two caches" call as director/faculty.
 */
export async function listHodApprovals() {
  const actor = await requireRole(["hod"]);
  const supabase = await createClient();

  return getCached(hodApprovalsCacheKey(actor.userId), 30, async () => {
    const { data: department } = await supabase.from("departments").select("id").eq("hod_id", actor.userId).single();
    if (!department) {
      return { pending: [], processed: [] };
    }

    const { data: deptStaff } = await supabase
      .from("profiles")
      .select("id")
      .eq("department_id", department.id);
    const staffIds = (deptStaff || []).map((s) => s.id);
    if (staffIds.length === 0) {
      return { pending: [], processed: [] };
    }

    const baseQuery = () =>
      supabase
        .from("leave_requests")
        .select("*, profiles:requested_by(full_name, email, role)")
        .in("requested_by", staffIds);

    const [pendingRes, processedRes] = await Promise.all([
      baseQuery().eq("status", "pending").order("created_at", { ascending: false }),
      baseQuery().neq("status", "pending").order("created_at", { ascending: false }).limit(PROCESSED_LIMIT),
    ]);
    return { pending: pendingRes.data || [], processed: processedRes.data || [] };
  });
}

/**
 * Read-only — shows affected classes BEFORE the HOD clicks Approve, per the
 * spec's "Leave Impact Preview." Same department-ownership rule as
 * actOnLeaveRequestCore, and the same computeAffectedClasses function
 * createSubstitutionNeeds uses on actual approval, so the preview can never
 * drift from what approval will actually create.
 */
export async function previewLeaveImpact(requestId: string) {
  const actor = await requireRole(["hod", "admin"]);
  const supabase = await createClient();

  const { data: requestData } = await supabase
    .from("leave_requests")
    .select("requested_by, start_date, end_date, profiles:requested_by(full_name, department_id)")
    .eq("id", requestId)
    .single();
  const request = requestData as any;
  if (!request) {
    throw new Error("Leave request not found.");
  }

  if (actor.role === "hod") {
    const { data: department } = await supabase.from("departments").select("id").eq("hod_id", actor.userId).single();
    if (!department?.id || request.profiles?.department_id !== department.id) {
      throw new Error("You can only preview leave requests from your own department.");
    }
  }

  const { data: slots } = await supabase
    .from("timetable_slots")
    .select("id, course_id, day_of_week, start_time, end_time, courses:course_id(name, code)")
    .eq("instructor_id", request.requested_by);

  const affected = computeAffectedClasses(request.start_date, request.end_date, (slots as any[]) || []);
  const courseById = new Map(((slots as any[]) || []).map((s) => [s.course_id, s.courses]));

  return {
    teacherName: request.profiles?.full_name || "Unknown",
    affectedClasses: affected.map((c) => ({
      ...c,
      courseCode: courseById.get(c.courseId)?.code || "",
      courseName: courseById.get(c.courseId)?.name || "",
    })),
  };
}

/**
 * Shared by the web Server Action below and app/api/mobile/leave/act's
 * Route Handler — same guarded logic either way, just a different transport.
 */
export async function actOnLeaveRequestCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  requestId: string,
  action: "approved" | "rejected"
) {
  ({ requestId, action } = ActOnLeaveRequestSchema.parse({ requestId, action }));
  await checkRateLimit(`actOnLeaveRequest:${actor.userId}`, 30, 60);

  // Fetched unconditionally now (previously only inside the hod branch) —
  // approving needs requested_by/start_date/end_date/status to compute
  // substitution needs and write a real audit diff, for both hod and admin.
  const { data: requestData } = await supabase
    .from("leave_requests")
    .select("requested_by, start_date, end_date, status, profiles:requested_by(department_id)")
    .eq("id", requestId)
    .single();

  // Cast to any: this hand-maintained types file doesn't declare table
  // Relationships, so embedded joins like profiles:requested_by(...)
  // can't be inferred — same pattern used throughout the rest of the app.
  const request = requestData as any;
  if (!request || request.status !== "pending") {
    throw new Error("Leave request not found or already processed.");
  }

  // A HOD may only act on leave requests from staff in their own
  // department; admin is unrestricted. leave_requests_read (RLS) is
  // college-wide for hod, not department-scoped, so this app-layer check
  // is what actually closes it — same technique as the course-ownership
  // checks in teacher/grading and teacher/attendance.
  if (actor.role === "hod") {
    // Resolved via departments.hod_id, same as hod/dashboard and
    // hod/reports — NOT via this HOD's own profiles.department_id, which
    // assigning someone as HOD doesn't set (see the comment in
    // hod/faculty/page.tsx for the full explanation).
    const { data: department } = await supabase.from("departments").select("id").eq("hod_id", actor.userId).single();
    const requesterDeptId = request.profiles?.department_id;
    if (!department?.id || requesterDeptId !== department.id) {
      throw new Error("You can only act on leave requests from your own department.");
    }
  }

  const { error } = await supabase
    .from("leave_requests")
    .update({
      status: action,
      approved_by: actor.userId,
      approved_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .eq("college_id", actor.collegeId);

  if (error) {
    throw new Error(error.message);
  }

  await logAudit(supabase, actor, action === "approved" ? "leave_approved" : "leave_rejected", "leave_requests", requestId, {
    oldValue: { status: request.status },
    newValue: { status: action },
  });

  if (action === "approved") {
    await createSubstitutionNeeds(supabase, actor, requestId, request.requested_by, request.start_date, request.end_date);
  }
}

/**
 * Called after a leave request is approved — computes affected classes from
 * the requester's own timetable_slots (lib/leave-impact.ts, same function
 * previewLeaveImpact uses) and creates one 'needed' substitution_assignments
 * row per affected class. Purely additive: teachers keep marking their own
 * attendance as before, this only opens a new avenue for a HOD-assigned
 * substitute to cover specific already-identified classes.
 */
async function createSubstitutionNeeds(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  leaveRequestId: string,
  requestedBy: string,
  startDate: string,
  endDate: string
) {
  const { data: slots } = await supabase
    .from("timetable_slots")
    .select("id, course_id, day_of_week, start_time, end_time")
    .eq("instructor_id", requestedBy);
  if (!slots || slots.length === 0) return;

  const affected = computeAffectedClasses(startDate, endDate, slots);
  if (affected.length === 0) return;

  const rows = affected.map((c) => ({
    college_id: actor.collegeId,
    leave_request_id: leaveRequestId,
    course_id: c.courseId,
    timetable_slot_id: c.slotId,
    original_teacher_id: requestedBy,
    date: c.date,
    status: "needed" as const,
  }));

  // ON CONFLICT DO NOTHING via ignoreDuplicates — the same (course_id, date)
  // pair can't get two 'needed' rows even if this ran twice. Non-fatal: the
  // leave approval itself (the primary effect, already committed above) is
  // more important than substitution tracking — but a failure here must not
  // be silent, or a HOD would see leave approved with no visible reason
  // "Substitution Management" then shows nothing for it.
  const { error } = await supabase.from("substitution_assignments").upsert(rows, { onConflict: "course_id,date", ignoreDuplicates: true });
  if (error) {
    console.error(`createSubstitutionNeeds failed for leave request ${leaveRequestId}:`, error.message);
  }
}

export async function actOnLeaveRequest(
  requestId: string,
  action: "approved" | "rejected"
) {
  const actor = await requireRole(["hod", "admin"]);
  const supabase = await createClient();
  await actOnLeaveRequestCore(supabase, actor, requestId, action);
  revalidatePath("/hod/approvals");
  if (actor.role === "hod") {
    await invalidateCache(hodApprovalsCacheKey(actor.userId));
  }
  // else: admin acting on a HOD-owned request (the unrestricted branch in
  // actOnLeaveRequestCore above) — that HOD's cache isn't invalidated here,
  // it just rides out the 30s TTL. Rare path (admin bypassing the normal
  // per-department UI), not worth an extra query to resolve whose cache
  // to bust.
}

/** Called by app/api/mobile/leave/act/route.ts. */
export async function actOnLeaveRequestViaRequest(
  request: Request,
  requestId: string,
  action: "approved" | "rejected"
) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["hod", "admin"]);
  await actOnLeaveRequestCore(supabase, actor, requestId, action);
}

function correctionsCacheKey(hodUserId: string) {
  return `hod-corrections:${hodUserId}`;
}

/**
 * Department-scoped by the *course's* department, not the submitting
 * teacher's own profile.department_id (unlike listHodApprovals' leave
 * scoping) — a correction is a claim about a specific course's records, so
 * the course's own department is the correct approval boundary even in the
 * (currently rare, schema-permitted) case a teacher's home department
 * differs from a course they teach.
 */
const CORRECTIONS_PROCESSED_LIMIT = 20;

export async function listCorrectionApprovals() {
  const actor = await requireRole(PERMISSIONS.attendance_correction_review);
  const supabase = await createClient();

  return getCached(correctionsCacheKey(actor.userId), 30, async () => {
    const selectCols = "*, courses:course_id(name, code), profiles:submitted_by(full_name), students:student_id(enrollment_number)";

    if (actor.role === "admin") {
      const baseQuery = () => supabase.from("attendance_correction_requests").select(selectCols);
      const [pendingRes, processedRes] = await Promise.all([
        baseQuery().eq("status", "pending").order("created_at", { ascending: false }),
        baseQuery().neq("status", "pending").order("created_at", { ascending: false }).limit(CORRECTIONS_PROCESSED_LIMIT),
      ]);
      return { pending: pendingRes.data || [], processed: processedRes.data || [] };
    }

    const { data: department } = await supabase.from("departments").select("id").eq("hod_id", actor.userId).single();
    if (!department) return { pending: [], processed: [] };

    const { data: deptCourses } = await supabase.from("courses").select("id").eq("department_id", department.id);
    const courseIds = (deptCourses || []).map((c) => c.id);
    if (courseIds.length === 0) return { pending: [], processed: [] };

    const baseQuery = () =>
      supabase.from("attendance_correction_requests").select(selectCols).in("course_id", courseIds);
    const [pendingRes, processedRes] = await Promise.all([
      baseQuery().eq("status", "pending").order("created_at", { ascending: false }),
      baseQuery().neq("status", "pending").order("created_at", { ascending: false }).limit(CORRECTIONS_PROCESSED_LIMIT),
    ]);
    return { pending: pendingRes.data || [], processed: processedRes.data || [] };
  });
}

const ActOnCorrectionSchema = z.object({
  requestId: z.string().guid(),
  action: z.enum(["approved", "rejected"]),
});

export async function actOnAttendanceCorrectionCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  requestIdRaw: string,
  actionRaw: "approved" | "rejected"
) {
  const { requestId, action } = ActOnCorrectionSchema.parse({ requestId: requestIdRaw, action: actionRaw });
  await checkRateLimit(`actOnAttendanceCorrection:${actor.userId}`, 30, 60);

  // Cast: same embedded-select workaround as requestAttendanceCorrection.
  type CorrectionWithCourse = Database["public"]["Tables"]["attendance_correction_requests"]["Row"] & {
    courses: { department_id: string } | null;
  };
  const { data: requestRaw } = await supabase
    .from("attendance_correction_requests")
    .select("*, courses:course_id(department_id)")
    .eq("id", requestId)
    .eq("college_id", actor.collegeId)
    .single();
  const request = requestRaw as CorrectionWithCourse | null;

  if (!request || request.status !== "pending") {
    throw new Error("Correction request not found or already processed.");
  }

  if (actor.role === "hod") {
    const { data: department } = await supabase.from("departments").select("id").eq("hod_id", actor.userId).single();
    const courseDeptId = request.courses?.department_id;
    if (!department?.id || courseDeptId !== department.id) {
      throw new Error("You can only act on correction requests for courses in your own department.");
    }
  }

  const { error: updateRequestError } = await supabase
    .from("attendance_correction_requests")
    .update({ status: action, reviewed_by: actor.userId, reviewed_at: new Date().toISOString() })
    .eq("id", requestId);
  if (updateRequestError) {
    throw new Error(updateRequestError.message);
  }

  if (action === "approved") {
    const { error: updateAttendanceError } = await supabase
      .from("attendance")
      .update({ status: request.requested_status })
      .eq("id", request.attendance_id);
    if (updateAttendanceError) {
      throw new Error(updateAttendanceError.message);
    }
    await logAudit(supabase, actor, "attendance_correction_approved", "attendance", request.attendance_id, {
      oldValue: request.current_status,
      newValue: request.requested_status,
    });
  }
}

export async function actOnAttendanceCorrection(requestId: string, action: "approved" | "rejected") {
  const actor = await requireRole(PERMISSIONS.attendance_correction_review);
  const supabase = await createClient();
  await actOnAttendanceCorrectionCore(supabase, actor, requestId, action);
  revalidatePath("/hod/approvals");
  revalidatePath("/teacher/attendance");
  if (actor.role === "hod") {
    await invalidateCache(correctionsCacheKey(actor.userId));
  }
}
