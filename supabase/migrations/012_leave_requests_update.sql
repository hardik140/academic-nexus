-- ============================================================
-- Migration 012: leave_requests missing UPDATE policy
--
-- supabase/migrations/006_rls_policies.sql only ever added a SELECT
-- policy for leave_requests; migration 010 added INSERT. No UPDATE
-- policy has ever existed. Under RLS default-deny, this means
-- actOnLeaveRequest (app/(portal)/hod/approvals/actions.ts, used since
-- the original Auth/RBAC Hardening Pass) has been silently doing
-- nothing this entire time: Supabase's .update().eq(...) call, when
-- RLS blocks every row, returns zero affected rows with NO error —
-- so the Server Action "succeeds," the page reloads, and the request
-- just sits there still pending. This went undetected because no
-- previous E2E pass actually clicked Approve/Reject; earlier runs
-- only smoke-tested that /hod/approvals rendered without crashing.
--
-- Confirmed via a real E2E run in the HOD Portal pass: clicking
-- Approve through the actual UI left the request status unchanged
-- in the database, with no error surfaced anywhere.
--
-- Department-level ownership (a HOD may only act on requests from
-- their own department) is enforced at the app layer in
-- actOnLeaveRequest itself, not here — same pattern as
-- attendance_teacher_mark/marks_teacher_manage, which also only check
-- role at the RLS level.
--
-- Sign-off: approved as part of the HOD Portal Stitch Redesign + Real
-- DB/API Fixes pass (see C:\Users\91981\.claude\plans\crystalline-dancing-floyd.md).
-- ============================================================

CREATE POLICY "leave_requests_update_hod_admin" ON public.leave_requests
  FOR UPDATE USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('hod', 'admin')
  );

-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- DROP POLICY IF EXISTS "leave_requests_update_hod_admin" ON public.leave_requests;
