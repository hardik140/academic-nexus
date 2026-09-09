-- ============================================================
-- Migration 044: close the last three bare-college-scope read policies
--
-- hostel_allocations_read, scholarships_read and placements_read
-- (migration 006) are all plain `college_id = get_my_college_id()` with no
-- ownership condition. Any student, using the anon key that ships in the
-- browser bundle, can enumerate:
--
--   hostel_allocations -> every other student's block and room number
--   scholarships       -> every award, type and amount in the college, by name
--   placements         -> every offer and package, by name
--
-- The hostel one is a physical-safety concern as much as a privacy one:
-- it maps any named student to the room they sleep in.
--
-- This is the same bug class, and takes the same fix shape, as migration 009
-- (profiles_read_same_college) and migration 036 (course_enrollments_read).
-- Both of those were scoped to the single table that prompted them. This
-- migration sweeps the rest of the file so it is the last time this is found
-- one table at a time.
--
-- Every replacement policy was checked against the actual consumers (every
-- .from("<table>") call site in app/):
--
--   hostel_allocations  admin/users, student/hostel, warden/gatepasses (x3),
--                       warden/transfers (x3)   -> own + warden/admin/director
--   scholarships        finance/scholarships (x2)
--                       -> own + finance/admin/director
--   placements          director/placements (x2), placement-cell/drives,
--                       placement-cell/records, placement-cell/reports
--                       -> own + director/placement_cell/admin
--
-- Materialized views over these tables (mv_placement_summary_raw,
-- mv_placement_funnel_raw) are computed as the view owner and are not
-- subject to RLS, so the analytics surfaces are unaffected. The three cron
-- handlers use the service-role client and are likewise unaffected.
--
-- Students gain a genuinely new capability here as a side effect: today a
-- student can read every scholarship and placement EXCEPT via a policy that
-- names them as the owner. The *_read_own policies below give them their own
-- record properly, which is what the UI should have been able to rely on.
--
-- Sign-off: REQUIRED before applying — RLS change, per .agent/.rules §1.
-- ============================================================

-- ---------------------------------------------------------------
-- hostel_allocations
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "hostel_allocations_read" ON public.hostel_allocations;

CREATE POLICY "hostel_allocations_read_own" ON public.hostel_allocations
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.id = hostel_allocations.student_id AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "hostel_allocations_read_staff" ON public.hostel_allocations
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('warden', 'admin', 'director')
  );

-- ---------------------------------------------------------------
-- scholarships
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "scholarships_read" ON public.scholarships;

CREATE POLICY "scholarships_read_own" ON public.scholarships
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.id = scholarships.student_id AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "scholarships_read_staff" ON public.scholarships
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('finance', 'admin', 'director')
  );

-- ---------------------------------------------------------------
-- placements
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "placements_read" ON public.placements;

CREATE POLICY "placements_read_own" ON public.placements
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.id = placements.student_id AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "placements_read_staff" ON public.placements
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('director', 'placement_cell', 'admin')
  );

-- ============================================================
-- Post-apply verification — as a STUDENT session, each of these must now
-- return only that student's own rows (or none), never the whole college:
--
--   SELECT count(*) FROM public.hostel_allocations;
--   SELECT count(*) FROM public.scholarships;
--   SELECT count(*) FROM public.placements;
--
-- And as warden / finance / placement_cell respectively, each must still
-- return the college-wide set their screens depend on. This codebase's
-- documented recurring bug class is a new RLS policy that silently returns
-- nothing (see migrations 010/012/013/014/015/016/038/040) — so verify the
-- staff side by loading the actual screens, not just by reading this file.
-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- DROP POLICY IF EXISTS "placements_read_staff" ON public.placements;
-- DROP POLICY IF EXISTS "placements_read_own" ON public.placements;
-- DROP POLICY IF EXISTS "scholarships_read_staff" ON public.scholarships;
-- DROP POLICY IF EXISTS "scholarships_read_own" ON public.scholarships;
-- DROP POLICY IF EXISTS "hostel_allocations_read_staff" ON public.hostel_allocations;
-- DROP POLICY IF EXISTS "hostel_allocations_read_own" ON public.hostel_allocations;
-- CREATE POLICY "hostel_allocations_read" ON public.hostel_allocations
--   FOR SELECT USING (college_id = public.get_my_college_id());
-- CREATE POLICY "scholarships_read" ON public.scholarships
--   FOR SELECT USING (college_id = public.get_my_college_id());
-- CREATE POLICY "placements_read" ON public.placements
--   FOR SELECT USING (college_id = public.get_my_college_id());
