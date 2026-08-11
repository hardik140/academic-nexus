"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
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

  // A teacher may only mark attendance for their own course; admin can mark
  // any. RLS (attendance_teacher_mark) only checks role, not course
  // ownership — this is the layer that actually closes that gap.
  if (actor.role === "teacher" && course.instructor_id !== actor.userId) {
    throw new Error("You can only mark attendance for courses you teach.");
  }

  if (entries.length === 0) {
    return { saved: 0 };
  }

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
  const actor = await requireRole(["teacher", "admin"]);
  const supabase = await createClient();
  const result = await saveAttendanceCore(supabase, actor, params);
  revalidatePath("/teacher/attendance");
  return result;
}

/** Called by app/api/mobile/attendance/save/route.ts. */
export async function saveAttendanceViaRequest(request: Request, params: SaveAttendanceParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["teacher", "admin"]);
  return saveAttendanceCore(supabase, actor, params);
}
