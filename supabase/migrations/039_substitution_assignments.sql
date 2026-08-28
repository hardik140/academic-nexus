-- ============================================================
-- Migration 039: substitution_assignments — Leave -> Substitution
--
-- Today, approving a teacher's leave request has zero downstream effect:
-- it doesn't identify affected classes, and there is no way for a
-- substitute teacher to actually take over those classes (attendance
-- marking is hard-locked to the course's own instructor_id). This table
-- + the app-layer changes around it close that gap: HOD approval of a
-- leave request creates one 'needed' row per affected class (computed
-- from timetable_slots), the HOD assigns a substitute (-> 'assigned'),
-- and the substitute is then permitted to mark attendance for that
-- specific course+date only.
-- ============================================================

CREATE TABLE public.substitution_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  leave_request_id UUID NOT NULL REFERENCES public.leave_requests(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id),
  timetable_slot_id UUID REFERENCES public.timetable_slots(id) ON DELETE SET NULL,
  original_teacher_id UUID NOT NULL REFERENCES public.profiles(id),
  substitute_teacher_id UUID REFERENCES public.profiles(id),
  date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'needed' CHECK (status IN ('needed', 'assigned', 'cancelled')),
  reason TEXT,
  assigned_by UUID REFERENCES public.profiles(id),
  assigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One substitution requirement per course+date — matches the same
  -- one-session-per-course-per-day invariant attendance's own
  -- UNIQUE(student_id, course_id, date) upsert key assumes.
  UNIQUE (course_id, date)
);

CREATE INDEX idx_substitution_assignments_college ON public.substitution_assignments(college_id);
CREATE INDEX idx_substitution_assignments_leave_request ON public.substitution_assignments(leave_request_id);
CREATE INDEX idx_substitution_assignments_substitute ON public.substitution_assignments(substitute_teacher_id);

ALTER TABLE public.substitution_assignments ENABLE ROW LEVEL SECURITY;

-- Original teacher and substitute can both see their own rows.
CREATE POLICY "substitution_read_own" ON public.substitution_assignments
  FOR SELECT USING (
    original_teacher_id = auth.uid() OR substitute_teacher_id = auth.uid()
  );

-- hod/admin can read college-wide; department ownership for hod is
-- enforced app-side via the course's department_id, same split as
-- attendance_correction_requests (037) and leave_requests.
CREATE POLICY "substitution_read_staff" ON public.substitution_assignments
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('hod', 'admin')
  );

-- Covers both the leave-approval bulk insert (status='needed') and the
-- HOD assigning a substitute (status='assigned') — same role-only RLS +
-- app-layer department-scope split used throughout this codebase.
CREATE POLICY "substitution_insert_staff" ON public.substitution_assignments
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('hod', 'admin')
  );

CREATE POLICY "substitution_update_staff" ON public.substitution_assignments
  FOR UPDATE USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('hod', 'admin')
  );

-- A student enrolled in the affected course can see an assigned (not just
-- 'needed') substitution — this is what makes student/schedule's "Substitute
-- today" badge a real read instead of always-empty; without this policy the
-- table's other SELECT policies (own-rows / hod+admin) leave students with
-- no path to it at all.
CREATE POLICY "substitution_read_enrolled_student" ON public.substitution_assignments
  FOR SELECT USING (
    status = 'assigned'
    AND EXISTS (
      SELECT 1 FROM public.course_enrollments ce
      WHERE ce.course_id = substitution_assignments.course_id
        AND ce.student_id = auth.uid()
        AND ce.status = 'enrolled'
    )
  );

-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- DROP TABLE IF EXISTS public.substitution_assignments;
