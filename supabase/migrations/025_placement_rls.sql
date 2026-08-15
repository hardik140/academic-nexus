-- ============================================================
-- Migration 025: RLS for Placement Cell tables
-- ============================================================
-- Enables RLS on the five tables from migration 024, following the
-- <table>_read / <table>_manage convention used since migration 006, on
-- top of the existing public.get_my_college_id() / public.get_my_role()
-- helpers (no new SQL functions needed). Also extends two pre-existing
-- policies that a placement_cell actor now needs to pass through:
-- notifications_admin_send (sending targeted placement notifications reuses
-- the existing notifications table/pattern) and placements_manage (marking
-- a student "selected"/"placed" on a drive writes an outcome row into the
-- pre-existing placements ledger, same as Director's placements page does).

-- ---------------------------------------------------------------
-- companies — belongs to the college, readable by anyone in it;
-- writable only by the people who run the placement process.
-- ---------------------------------------------------------------
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "companies_read" ON public.companies
  FOR SELECT USING (college_id = public.get_my_college_id());

CREATE POLICY "companies_manage" ON public.companies
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('placement_cell', 'admin')
  );

-- ---------------------------------------------------------------
-- placement_drives — staff (director/placement_cell/admin) see everything
-- including drafts; students only see published drives.
-- ---------------------------------------------------------------
ALTER TABLE public.placement_drives ENABLE ROW LEVEL SECURITY;

CREATE POLICY "placement_drives_read_staff" ON public.placement_drives
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('director', 'placement_cell', 'admin')
  );

CREATE POLICY "placement_drives_read_student" ON public.placement_drives
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'student'
    AND status = 'published'
  );

CREATE POLICY "placement_drives_manage" ON public.placement_drives
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('placement_cell', 'admin')
  );

-- ---------------------------------------------------------------
-- placement_drive_departments — no college_id column of its own; scoped by
-- joining back to the parent drive.
-- ---------------------------------------------------------------
ALTER TABLE public.placement_drive_departments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "placement_drive_departments_read" ON public.placement_drive_departments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.placement_drives d
      WHERE d.id = drive_id
        AND d.college_id = public.get_my_college_id()
        AND (
          public.get_my_role() IN ('director', 'placement_cell', 'admin')
          OR (public.get_my_role() = 'student' AND d.status = 'published')
        )
    )
  );

CREATE POLICY "placement_drive_departments_manage" ON public.placement_drive_departments
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.placement_drives d
      WHERE d.id = drive_id
        AND d.college_id = public.get_my_college_id()
        AND public.get_my_role() IN ('placement_cell', 'admin')
    )
  );

-- ---------------------------------------------------------------
-- placement_applications — staff see all in college; a student sees and
-- creates only their own; only staff change status (shortlist/select/
-- reject) — business-rule checks (drive published, deadline, eligibility)
-- live in the server action, RLS is the identity/tenancy backstop.
-- ---------------------------------------------------------------
ALTER TABLE public.placement_applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "placement_applications_read_staff" ON public.placement_applications
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('director', 'placement_cell', 'admin')
  );

CREATE POLICY "placement_applications_read_own" ON public.placement_applications
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.id = student_id AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "placement_applications_insert_own" ON public.placement_applications
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'student'
    AND EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.id = student_id AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "placement_applications_manage" ON public.placement_applications
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('placement_cell', 'admin')
  );

-- ---------------------------------------------------------------
-- student_placement_profiles — no student-writable columns in V1, so
-- students get read-only access to their own row; staff get full read,
-- placement_cell/admin manage.
-- ---------------------------------------------------------------
ALTER TABLE public.student_placement_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "student_placement_profiles_read_staff" ON public.student_placement_profiles
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('director', 'placement_cell', 'admin')
  );

CREATE POLICY "student_placement_profiles_read_own" ON public.student_placement_profiles
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.id = student_id AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "student_placement_profiles_manage" ON public.student_placement_profiles
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('placement_cell', 'admin')
  );

-- ---------------------------------------------------------------
-- Existing policies that a placement_cell actor now needs to pass.
-- ---------------------------------------------------------------

-- notifications: placement_cell can send targeted placement notifications,
-- reusing sendAnnouncementCore's exact pattern (see
-- app/(portal)/placement-cell/notifications/actions.ts).
DROP POLICY IF EXISTS "notifications_admin_send" ON public.notifications;
CREATE POLICY "notifications_admin_send" ON public.notifications
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'teacher', 'hod', 'finance', 'director', 'warden', 'placement_cell')
  );

-- placements: marking an applicant "selected"/"placed" on a drive writes an
-- outcome row into the pre-existing ledger (same table Director's
-- placements page already writes to), so it feeds mv_placement_summary and
-- director/analytics with zero changes to those existing surfaces.
DROP POLICY IF EXISTS "placements_manage" ON public.placements;
CREATE POLICY "placements_manage" ON public.placements
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('director', 'admin', 'placement_cell')
  );
