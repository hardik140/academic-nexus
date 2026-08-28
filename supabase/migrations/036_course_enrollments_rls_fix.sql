-- ============================================================
-- Migration 036: course_enrollments RLS fix — cross-student grade exposure
--
-- course_enrollments_read had no student-ownership condition: any
-- authenticated user in a college (including `student`) could read every
-- other student's grade/grade_points/status in that college. The sibling
-- `marks` table already gets this right (marks_read_student scopes to
-- student_id IN (own students row)) — course_enrollments never got the
-- same treatment. Same class of bug, same fix shape, as migration 009's
-- profiles_read_same_college hardening.
--
-- course_enrollments.student_id references profiles(id) directly (not
-- students(id) — see migration 002/032's own comment on this), so
-- student_id = auth.uid() is the correct self-check, no join needed.
--
-- Sign-off: approved as part of the Student Command Center + Academic
-- Intelligence plan (see C:\Users\91981\.claude\plans\snug-floating-stardust.md).
-- ============================================================

DROP POLICY IF EXISTS "course_enrollments_read" ON public.course_enrollments;

CREATE POLICY "course_enrollments_read_own" ON public.course_enrollments
  FOR SELECT USING (student_id = auth.uid());

CREATE POLICY "course_enrollments_read_staff" ON public.course_enrollments
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('teacher', 'hod', 'director', 'admin')
  );

-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- DROP POLICY IF EXISTS "course_enrollments_read_staff" ON public.course_enrollments;
-- DROP POLICY IF EXISTS "course_enrollments_read_own" ON public.course_enrollments;
-- CREATE POLICY "course_enrollments_read" ON public.course_enrollments
--   FOR SELECT USING (college_id = public.get_my_college_id());
