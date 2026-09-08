-- ============================================================
-- Migration 037: attendance_correction_requests
--
-- Teacher Command Center + Teaching plan (see
-- C:\Users\91981\.claude\plans\snug-floating-stardust.md). Purely
-- additive: a new avenue for correcting an already-recorded attendance
-- entry via HOD/admin sign-off, alongside — not replacing — the teacher's
-- existing same-day direct-edit ability (attendance_teacher_update).
--
-- RLS follows the leave_requests precedent (migrations 010/012) exactly:
-- self-scoped insert/read for the submitting teacher, role-scoped
-- read/update for hod/admin (department ownership enforced app-side in
-- actOnAttendanceCorrectionCore, same pattern as actOnLeaveRequestCore).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.attendance_correction_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  attendance_id UUID NOT NULL REFERENCES public.attendance(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  current_status TEXT NOT NULL CHECK (current_status IN ('present', 'absent', 'late', 'excused')),
  requested_status TEXT NOT NULL CHECK (requested_status IN ('present', 'absent', 'late', 'excused')),
  reason TEXT NOT NULL,
  evidence_note TEXT,
  submitted_by UUID NOT NULL REFERENCES public.profiles(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES public.profiles(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attendance_correction_submitted_by ON public.attendance_correction_requests(submitted_by);
CREATE INDEX IF NOT EXISTS idx_attendance_correction_college_status ON public.attendance_correction_requests(college_id, status);

ALTER TABLE public.attendance_correction_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "attendance_correction_read_own" ON public.attendance_correction_requests
  FOR SELECT USING (submitted_by = auth.uid());

CREATE POLICY "attendance_correction_read_staff" ON public.attendance_correction_requests
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('hod', 'admin')
  );

CREATE POLICY "attendance_correction_insert_own" ON public.attendance_correction_requests
  FOR INSERT WITH CHECK (submitted_by = auth.uid());

CREATE POLICY "attendance_correction_update_staff" ON public.attendance_correction_requests
  FOR UPDATE USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('hod', 'admin')
  );

-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- DROP TABLE IF EXISTS public.attendance_correction_requests;
