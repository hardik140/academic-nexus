import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * Verifies every studentDbId (a `students.id`) is actually enrolled in
 * `offeringId`, throwing otherwise.
 *
 * RLS on `attendance`/`marks` only checks the actor's role + college, not the
 * student_id being written — without this, a teacher (or admin) could write
 * an attendance or marks row for any student UUID at all, including one in a
 * different college. This is the layer that actually closes that gap; the
 * mobile test suite covers both directions as an IDOR regression.
 *
 * Enrollment is now scoped to the OFFERING rather than the course. A student
 * enrolled in section A of CS301 is not thereby enrolled in section B, and a
 * student who took CS301 last semester is not enrolled in this semester's
 * offering — both were indistinguishable under the old course-level check.
 *
 * The double id-space hop this function used to perform is gone: migration
 * 047 repointed course_enrollments.student_id from profiles(id) to
 * students(id), so it now compares like with like. That mismatch was the
 * schema's most persistent trap — a wrong join returned zero rows rather than
 * an error, which is why three separate places carried comments explaining it.
 */
export async function verifyStudentsEnrolled(
  supabase: SupabaseClient<Database>,
  offeringId: string,
  studentDbIds: string[]
): Promise<void> {
  const uniqueIds = Array.from(new Set(studentDbIds));
  if (uniqueIds.length === 0) return;

  const { data: enrollments } = await supabase
    .from("course_enrollments")
    .select("student_id")
    .eq("offering_id", offeringId)
    .eq("status", "enrolled")
    .in("student_id", uniqueIds);

  const enrolled = new Set((enrollments || []).map((e) => e.student_id));
  if (uniqueIds.some((id) => !enrolled.has(id))) {
    throw new Error("One or more students are not enrolled in this course offering.");
  }
}
