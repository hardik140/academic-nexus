"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import type { Database } from "@/types/database";
import { dbError } from "@/lib/internal-error";
import { assertRead } from "@/lib/read-result-server";

// The hand-maintained Database type's Relationships arrays are empty (see
// types/database.ts's own header comment), so supabase-js can't infer
// embedded-select shapes like `companies:company_id(...)` — every existing
// page.tsx already works around this with `row.foo as any`; these two
// local types do the same for the one place (this file) that needs to
// compute on an embedded-select result server-side, not just pass it
// through untouched.
type DriveRow = Database["public"]["Tables"]["placement_drives"]["Row"];
type DriveWithCompany = DriveRow & {
  companies: { name: string; industry: string | null; location: string | null } | null;
};

async function getOwnStudentRow(supabase: Awaited<ReturnType<typeof createClient>>, userId: string, collegeId: string) {
  const { data: student, error: studentError } = await supabase
    .from("students")
    .select("id, college_id, cgpa, batch_year, department_id")
    .eq("user_id", userId)
    .single();
  assertRead(studentError);
  if (!student || student.college_id !== collegeId) {
    throw new Error("Student profile not found.");
  }
  return student;
}

/** Published drives this student is currently eligible for, with their own application status if any. */
export async function listOpportunities() {
  const actor = await requireRole(["student"]);
  const supabase = await createClient();
  const student = await getOwnStudentRow(supabase, actor.userId, actor.collegeId);

  const { data: drivesData, error: drivesDataError } = await supabase
    .from("placement_drives")
    .select("*, companies:company_id(name, industry, location)")
    .eq("college_id", actor.collegeId)
    .eq("status", "published")
    .order("application_deadline", { ascending: true });
  assertRead(drivesDataError);
  const drives = (drivesData || []) as DriveWithCompany[];

  const driveIds = drives.map((d) => d.id);
  const { data: eligibleDeptRows, error: eligibleDeptRowsError } = driveIds.length
    ? await supabase.from("placement_drive_departments").select("drive_id, department_id").in("drive_id", driveIds)
    : { data: [], error: null };
  assertRead(eligibleDeptRowsError);
  const { data: myApplications, error: myApplicationsError } = await supabase
    .from("placement_applications")
    .select("drive_id, status")
    .eq("student_id", student.id);
  assertRead(myApplicationsError);

  const appliedMap = Object.fromEntries((myApplications || []).map((a) => [a.drive_id, a.status]));
  const deptsByDrive: Record<string, string[]> = {};
  (eligibleDeptRows || []).forEach((r) => {
    (deptsByDrive[r.drive_id] ||= []).push(r.department_id);
  });

  return drives
    .filter((d) => {
      if (d.min_cgpa != null && (student.cgpa ?? 0) < d.min_cgpa) return false;
      if (d.eligible_batch_years && d.eligible_batch_years.length > 0 && !d.eligible_batch_years.includes(student.batch_year)) {
        return false;
      }
      const depts = deptsByDrive[d.id] || [];
      if (depts.length > 0 && !depts.includes(student.department_id)) return false;
      return true;
    })
    .map((d) => ({ ...d, applicationStatus: appliedMap[d.id] || null }));
}

const ApplySchema = z.object({ driveId: z.string().guid() });

export async function applyToDrive(driveIdRaw: string) {
  const actor = await requireRole(["student"]);
  const supabase = await createClient();
  const { driveId } = ApplySchema.parse({ driveId: driveIdRaw });
  await checkRateLimit(`applyToDrive:${actor.userId}`, 20, 60);

  const student = await getOwnStudentRow(supabase, actor.userId, actor.collegeId);

  const { data: drive } = await supabase
    .from("placement_drives")
    .select("id, college_id, status, application_deadline, min_cgpa, eligible_batch_years")
    .eq("id", driveId)
    .single();
  if (!drive || drive.college_id !== actor.collegeId) {
    throw new Error("Placement drive not found.");
  }
  if (drive.status !== "published") {
    throw new Error("This drive is not open for applications.");
  }
  if (new Date(drive.application_deadline) < new Date()) {
    throw new Error("The application deadline has passed.");
  }
  if (drive.min_cgpa != null && (student.cgpa ?? 0) < drive.min_cgpa) {
    throw new Error("You do not meet the minimum CGPA requirement for this drive.");
  }
  if (drive.eligible_batch_years && drive.eligible_batch_years.length > 0 && !drive.eligible_batch_years.includes(student.batch_year)) {
    throw new Error("You are not in an eligible batch year for this drive.");
  }

  const { data: eligibleDepartments } = await supabase
    .from("placement_drive_departments")
    .select("department_id")
    .eq("drive_id", driveId);
  const deptIds = (eligibleDepartments || []).map((d) => d.department_id);
  if (deptIds.length > 0 && !deptIds.includes(student.department_id)) {
    throw new Error("Your department is not eligible for this drive.");
  }

  const { error } = await supabase
    .from("placement_applications")
    .insert({ college_id: actor.collegeId, drive_id: driveId, student_id: student.id });

  if (error) {
    if (error.code === "23505") {
      throw new Error("You have already applied to this drive.");
    }
    throw dbError(error);
  }

  await supabase
    .from("student_placement_profiles")
    .upsert(
      { college_id: actor.collegeId, student_id: student.id, placement_status: "applied", updated_by: actor.userId },
      { onConflict: "student_id" }
    );

  revalidatePath("/student/placements");
}

export async function listMyApplications() {
  const actor = await requireRole(["student"]);
  const supabase = await createClient();
  const student = await getOwnStudentRow(supabase, actor.userId, actor.collegeId);

  const { data, error: dataError } = await supabase
    .from("placement_applications")
    .select("*, placement_drives:drive_id(job_role, package_lpa, companies:company_id(name))")
    .eq("student_id", student.id)
    .order("applied_at", { ascending: false });
  assertRead(dataError);

  return data || [];
}

export async function getMyPlacementProfile() {
  const actor = await requireRole(["student"]);
  const supabase = await createClient();

  const { data, error: dataError } = await supabase
    .from("students")
    .select("id, enrollment_number, cgpa, batch_year, departments(name), student_placement_profiles(placement_status, notes)")
    .eq("user_id", actor.userId)
    .eq("college_id", actor.collegeId)
    .single();
  assertRead(dataError);

  return data;
}

/** This student's own placement-related notifications (link starts with /student/placements). */
export async function listMyPlacementNotifications() {
  const actor = await requireRole(["student"]);
  const supabase = await createClient();
  const { data, error: dataError } = await supabase
    .from("notifications")
    .select("id, title, message, link, read, created_at")
    .eq("receiver_id", actor.userId)
    .like("link", "/student/placements%")
    .order("created_at", { ascending: false })
    .limit(20);
  assertRead(dataError);
  return data || [];
}
