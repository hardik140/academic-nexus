-- ============================================================
-- Migration 038: attendance_hod_update — HOD couldn't apply approved
-- attendance corrections
--
-- attendance_teacher_update (migration 006) only grants UPDATE to
-- marked_by = auth.uid() OR role = 'admin' — hod was never covered. This
-- silently no-opped actOnAttendanceCorrectionCore's UPDATE attendance SET
-- status = requested_status once approved: the correction request itself
-- got marked 'approved' and audit-logged correctly (those are separate
-- tables), but RLS blocked every row of the actual attendance.status
-- write with zero rows affected and NO error — confirmed via a real
-- end-to-end run (approve as HOD, re-query attendance, status unchanged).
-- Same silent-failure class already documented for leave_requests in
-- migration 012's comment.
--
-- Scope matches hod's existing attendance_read_staff breadth (college-wide
-- SELECT for teacher/hod/director/admin) rather than inventing a narrower
-- shape RLS can't easily express anyway (RLS can't see "only when there's
-- an approved correction request for this row" — that's exactly what
-- actOnAttendanceCorrectionCore's app-layer checks already gate: pending
-- status, then department ownership via departments.hod_id, before this
-- UPDATE ever runs). Same defense-in-depth split as every other
-- role-only-RLS-plus-ownership-in-app-code pair in this schema.
-- ============================================================

CREATE POLICY "attendance_hod_update" ON public.attendance
  FOR UPDATE USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'hod'
  );

-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- DROP POLICY IF EXISTS "attendance_hod_update" ON public.attendance;
