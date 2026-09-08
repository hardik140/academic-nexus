import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * Verifies every studentDbId (a `students.id`) is actually enrolled in
 * `courseId`, throwing otherwise. RLS on `attendance`/`marks` only checks
 * the actor's role + college, not the student_id being written — without
 * this, a teacher (or admin) could write an attendance/marks row for any
 * student UUID at all, including one in a different college.
 *
 * `course_enrollments.student_id` references `profiles(id)`, while
 * `attendance.student_id`/`marks.student_id` reference `students(id)` — two
 * different id spaces for "student" in this schema — so this resolves
 * through `students.user_id` first rather than comparing them directly.
 */
export async function verifyStudentsEnrolled(
  supabase: SupabaseClient<Database>,
  courseId: string,
  studentDbIds: string[]
): Promise<void> {
  const uniqueIds = Array.from(new Set(studentDbIds));
  if (uniqueIds.length === 0) return;

  const { data: studentRows } = await supabase.from("students").select("id, user_id").in("id", uniqueIds);
  const profileIdByStudentId = new Map((studentRows || []).map((s) => [s.id, s.user_id]));
  if (profileIdByStudentId.size !== uniqueIds.length) {
    throw new Error("One or more students could not be found.");
  }

  const { data: enrollments } = await supabase
    .from("course_enrollments")
    .select("student_id")
    .eq("course_id", courseId)
    .in("student_id", Array.from(profileIdByStudentId.values()));
  const enrolledProfileIds = new Set((enrollments || []).map((e) => e.student_id));

  const notEnrolled = uniqueIds.some((id) => !enrolledProfileIds.has(profileIdByStudentId.get(id)!));
  if (notEnrolled) {
    throw new Error("One or more students are not enrolled in this course.");
  }
}
