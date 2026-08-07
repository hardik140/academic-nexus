-- ============================================================
-- Migration 010: leave_requests missing INSERT policy
--
-- supabase/migrations/006_rls_policies.sql only ever added a SELECT
-- policy for leave_requests ("leave_requests_read"). Under RLS
-- default-deny, this means the leave-apply feature (teacher/leave,
-- and any other role's leave application) has been completely
-- non-functional — every insert is silently rejected by RLS, and the
-- calling pages never checked the insert's error response, so the
-- failure was invisible.
--
-- Sign-off: approved as part of the Teacher Portal Stitch Redesign +
-- API Hardening pass (see C:\Users\91981\.claude\plans\crystalline-dancing-floyd.md).
-- ============================================================

CREATE POLICY "leave_requests_insert_self" ON public.leave_requests
  FOR INSERT WITH CHECK (requested_by = auth.uid());

-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- DROP POLICY IF EXISTS "leave_requests_insert_self" ON public.leave_requests;
