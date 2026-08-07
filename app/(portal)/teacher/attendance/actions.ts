"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import type { Database } from "@/types/database";

type AttendanceStatus = Database["public"]["Tables"]["attendance"]["Row"]["status"];

export interface AttendanceEntry {
  studentDbId: string;
  status: AttendanceStatus;
}

export async function saveAttendance(params: {
  courseId: string;
  date: string;
  entries: AttendanceEntry[];
}) {
  const { courseId, date, entries } = params;
  const actor = await requireRole(["teacher", "admin"]);
  const supabase = await createClient();

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

  revalidatePath("/teacher/attendance");
  return { saved: rows.length };
}
