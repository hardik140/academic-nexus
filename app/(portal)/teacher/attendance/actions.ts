"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { PERMISSIONS } from "@/lib/permissions";
import { verifyStudentsEnrolled } from "@/lib/course-enrollment";
import { assertCanRecordAttendance, assertCanWriteOfferingRecords } from "@/lib/offerings";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type AttendanceStatus = Database["public"]["Tables"]["attendance"]["Row"]["status"];

const ATTENDANCE_STATUSES = ["present", "absent", "late", "excused"] as const;

const SaveAttendanceSchema = z.object({
  offeringId: z.string().guid(),
  date: z.string().min(1),
  entries: z
    .array(
      z.object({
        studentDbId: z.string().guid(),
        status: z.enum(ATTENDANCE_STATUSES),
      })
    )
    .max(500),
});

export interface AttendanceEntry {
  studentDbId: string;
  status: AttendanceStatus;
}

export interface SaveAttendanceParams {
  /** A course_offerings.id — semester + course + section + instructor. */
  offeringId: string;
  date: string;
  entries: AttendanceEntry[];
}

/**
 * Shared by the web Server Action below and app/api/mobile/attendance/save's
 * Route Handler — same guarded logic either way, just a different transport.
 */
export async function saveAttendanceCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: SaveAttendanceParams
) {
  const { offeringId, date, entries } = SaveAttendanceSchema.parse(params);
  await checkRateLimit(`saveAttendance:${actor.userId}`, 30, 60);

  // Authority is derived from the OFFERING, never from anything the caller
  // sent: the server re-reads course_offerings and allows only the assigned
  // instructor (a teaching HOD included), an admin, or a substitute assigned
  // to this offering on this date. A request carrying someone else's
  // offeringId proves nothing. The rule itself lives in lib/offerings.ts so
  // this Server Action and the mobile route cannot drift apart.
  const offering = await assertCanRecordAttendance(supabase, actor, offeringId, date);

  if (entries.length === 0) {
    return { saved: 0 };
  }

  // RLS (attendance_teacher_mark) only checks the actor's role + college,
  // never the student_id being written — without this, any teacher could
  // write an attendance row for an arbitrary student UUID, including one in
  // a different college. See lib/course-enrollment.ts.
  await verifyStudentsEnrolled(supabase, offering.id, entries.map((e) => e.studentDbId));

  const rows = entries.map((e) => ({
    college_id: actor.collegeId,
    student_id: e.studentDbId,
    offering_id: offering.id,
    date,
    status: e.status,
    marked_by: actor.userId,
  }));

  const { error } = await supabase
    .from("attendance")
    .upsert(rows, { onConflict: "offering_id,student_id,date" });

  if (error) {
    throw new Error(error.message);
  }

  return { saved: rows.length };
}

export async function saveAttendance(params: SaveAttendanceParams) {
  // 'hod' included because in a real college HODs teach — profiles.role is a
  // single column with no composition, so a teaching HOD previously had no way
  // to mark their own class. The instructor_id check above is what actually
  // enforces the boundary, and it applies to hod identically; this widening
  // grants no access to a course the actor doesn't instruct.
  const actor = await requireRole(["teacher", "hod", "admin"]);
  const supabase = await createClient();
  const result = await saveAttendanceCore(supabase, actor, params);
  revalidatePath("/teacher/attendance");
  return result;
}

/** Called by app/api/mobile/attendance/save/route.ts. */
export async function saveAttendanceViaRequest(request: Request, params: SaveAttendanceParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["teacher", "hod", "admin"]);
  return saveAttendanceCore(supabase, actor, params);
}

const RequestCorrectionSchema = z.object({
  attendanceId: z.string().guid(),
  requestedStatus: z.enum(ATTENDANCE_STATUSES),
  reason: z.string().trim().min(1).max(1000),
  evidenceNote: z.string().trim().max(1000).optional(),
});

export interface RequestCorrectionParams {
  attendanceId: string;
  requestedStatus: AttendanceStatus;
  reason: string;
  evidenceNote?: string;
}

/**
 * Purely additive to the teacher's existing same-day direct-edit ability
 * (attendance_teacher_update RLS) — this is the request/approve path for
 * correcting an already-past record, reviewed by hod/admin in
 * hod/approvals rather than silently re-editable by the teacher alone.
 */
export async function requestAttendanceCorrection(paramsRaw: RequestCorrectionParams) {
  const actor = await requireRole(PERMISSIONS.attendance_correction_create);
  const supabase = await createClient();
  const { attendanceId, requestedStatus, reason, evidenceNote } = RequestCorrectionSchema.parse(paramsRaw);
  await checkRateLimit(`requestAttendanceCorrection:${actor.userId}`, 20, 60);

  const { data: attendance } = await supabase
    .from("attendance")
    .select("id, college_id, student_id, offering_id, date, status")
    .eq("id", attendanceId)
    .single();

  if (!attendance || attendance.college_id !== actor.collegeId) {
    throw new Error("Attendance record not found.");
  }

  // Ownership resolves through the OFFERING, re-read server-side, rather than
  // through the attendance row's old course_id -> courses.instructor_id hop.
  // That hop asked "who owns this course institution-wide", which was the
  // wrong question the moment two sections could have different teachers.
  const offering = await assertCanWriteOfferingRecords(supabase, actor, attendance.offering_id);

  const { error } = await supabase.from("attendance_correction_requests").insert({
    college_id: actor.collegeId,
    attendance_id: attendance.id,
    student_id: attendance.student_id,
    offering_id: offering.id,
    date: attendance.date,
    current_status: attendance.status,
    requested_status: requestedStatus,
    reason,
    evidence_note: evidenceNote || null,
    submitted_by: actor.userId,
  });

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath("/teacher/attendance");
}

/** This teacher's own submitted correction requests, most recent first. */
export async function listMyCorrectionRequests() {
  const actor = await requireRole(PERMISSIONS.attendance_correction_create);
  const supabase = await createClient();
  const { data } = await supabase
    .from("attendance_correction_requests")
    .select("*, course_offerings:offering_id(courses:course_id(name, code), sections:section_id(name))")
    .eq("submitted_by", actor.userId)
    .order("created_at", { ascending: false });
  return data || [];
}
