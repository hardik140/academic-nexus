"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { PERMISSIONS } from "@/lib/permissions";
import { verifyStudentsEnrolled } from "@/lib/course-enrollment";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type AttendanceStatus = Database["public"]["Tables"]["attendance"]["Row"]["status"];

const ATTENDANCE_STATUSES = ["present", "absent", "late", "excused"] as const;

const SaveAttendanceSchema = z.object({
  courseId: z.string().guid(),
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
  courseId: string;
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
  const { courseId, date, entries } = SaveAttendanceSchema.parse(params);
  await checkRateLimit(`saveAttendance:${actor.userId}`, 30, 60);

  const { data: course } = await supabase
    .from("courses")
    .select("instructor_id")
    .eq("id", courseId)
    .single();

  if (!course) {
    throw new Error("Course not found.");
  }

  // A teacher may only mark attendance for their own course, UNLESS they're
  // the substitute assigned (by their HOD, via hod/substitutions) to cover
  // this exact course on this exact date — the mechanism that makes "leave
  // -> substitution -> attendance records the actual substitute teacher"
  // real instead of decorative. admin can mark any. RLS
  // (attendance_teacher_mark) only checks role, not course ownership — this
  // is the layer that actually closes that gap.
  // `!== "admin"` rather than `=== "teacher"`: a HOD who teaches is subject to
  // exactly the same course-ownership rule as any other instructor, and admin
  // stays unrestricted as before. See the role-list widening below.
  if (actor.role !== "admin" && course.instructor_id !== actor.userId) {
    const { data: substitution } = await supabase
      .from("substitution_assignments")
      .select("id")
      .eq("course_id", courseId)
      .eq("date", date)
      .eq("substitute_teacher_id", actor.userId)
      .eq("status", "assigned")
      .maybeSingle();
    if (!substitution) {
      throw new Error("You can only mark attendance for courses you teach.");
    }
  }

  if (entries.length === 0) {
    return { saved: 0 };
  }

  // RLS (attendance_teacher_mark) only checks the actor's role + college,
  // never the student_id being written — without this, any teacher could
  // write an attendance row for an arbitrary student UUID, including one in
  // a different college. See lib/course-enrollment.ts.
  await verifyStudentsEnrolled(supabase, courseId, entries.map((e) => e.studentDbId));

  const rows = entries.map((e) => ({
    college_id: actor.collegeId,
    student_id: e.studentDbId,
    course_id: courseId,
    date,
    status: e.status,
    marked_by: actor.userId,
  }));

  const { error } = await supabase
    .from("attendance")
    .upsert(rows, { onConflict: "student_id,course_id,date" });

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

  // Cast: the hand-maintained Database type declares no Relationships, so
  // supabase-js can't infer this embedded-select shape — same workaround
  // every other actions.ts file with an embedded select already uses (see
  // placements/actions.ts's DriveWithCompany comment).
  type AttendanceWithCourse = Database["public"]["Tables"]["attendance"]["Row"] & {
    courses: { instructor_id: string | null } | null;
  };
  const { data: attendanceRaw } = await supabase
    .from("attendance")
    .select("id, college_id, student_id, course_id, date, status, courses:course_id(instructor_id)")
    .eq("id", attendanceId)
    .single();
  const attendance = attendanceRaw as AttendanceWithCourse | null;

  if (!attendance || attendance.college_id !== actor.collegeId) {
    throw new Error("Attendance record not found.");
  }
  // A teacher may only request corrections for courses they teach — same
  // ownership check saveAttendanceCore uses for marking in the first place.
  const instructorId = attendance.courses?.instructor_id;
  if (instructorId !== actor.userId) {
    throw new Error("You can only request corrections for courses you teach.");
  }

  const { error } = await supabase.from("attendance_correction_requests").insert({
    college_id: actor.collegeId,
    attendance_id: attendance.id,
    student_id: attendance.student_id,
    course_id: attendance.course_id,
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
    .select("*, courses:course_id(name, code)")
    .eq("submitted_by", actor.userId)
    .order("created_at", { ascending: false });
  return data || [];
}
