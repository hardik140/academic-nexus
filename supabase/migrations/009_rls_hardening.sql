-- ============================================================
-- Migration 009: RLS Hardening — profiles over-exposure + parent read gap
--
-- profiles_read_same_college had no role condition: any authenticated
-- user in a college (including `student`) could read every other user's
-- full_name/email/phone/role/status. Replaced with four narrower policies
-- covering every access pattern actually used by the app (verified against
-- every .from("profiles") call across all portal pages):
--   1. self-read
--   2. staff roles keep full same-college directory read
--   3. student/parent can resolve instructor (teacher/hod) names only
--   4. parent can read their linked child's profile
--
-- Also adds students_read_parent: the parent portal currently has no RLS
-- read path on `students` at all (students_read_staff omits `parent`),
-- so parent/* pages return empty under RLS as written today.
--
-- Sign-off: approved as part of the Auth/RBAC Hardening Pass plan
-- (see C:\Users\91981\.claude\plans\crystalline-dancing-floyd.md).
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_my_email()
RETURNS TEXT AS $$
  SELECT email FROM public.profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

DROP POLICY IF EXISTS "profiles_read_same_college" ON public.profiles;

CREATE POLICY "profiles_read_self" ON public.profiles
  FOR SELECT USING (id = auth.uid());

CREATE POLICY "profiles_read_staff_same_college" ON public.profiles
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'teacher', 'hod', 'finance', 'director', 'warden')
  );

CREATE POLICY "profiles_read_instructors_for_students" ON public.profiles
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND role IN ('teacher', 'hod')
    AND public.get_my_role() IN ('student', 'parent')
  );

CREATE POLICY "profiles_read_child_for_parent" ON public.profiles
  FOR SELECT USING (
    public.get_my_role() = 'parent'
    AND id IN (SELECT user_id FROM public.students s WHERE s.parent_email = public.get_my_email())
  );

-- Companion fix: parent portal currently has no read path on `students` at all.
CREATE POLICY "students_read_parent" ON public.students
  FOR SELECT USING (parent_email = public.get_my_email());

-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- DROP POLICY IF EXISTS "students_read_parent" ON public.students;
-- DROP POLICY IF EXISTS "profiles_read_child_for_parent" ON public.profiles;
-- DROP POLICY IF EXISTS "profiles_read_instructors_for_students" ON public.profiles;
-- DROP POLICY IF EXISTS "profiles_read_staff_same_college" ON public.profiles;
-- DROP POLICY IF EXISTS "profiles_read_self" ON public.profiles;
-- DROP FUNCTION IF EXISTS public.get_my_email();
-- CREATE POLICY "profiles_read_same_college" ON public.profiles
--   FOR SELECT USING (college_id = public.get_my_college_id());
