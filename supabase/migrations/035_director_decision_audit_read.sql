-- ============================================================
-- Migration 035: Director read access to decision/risk-flag audit entries
-- ============================================================
-- Bug found during Decision Inbox smoke-testing: lib/audit.ts writes are
-- gated by audit_logs_insert (unrestricted by role, migration 006), but the
-- only SELECT policy — audit_logs_admin — is admin-only. The new
-- listDecisionAuditTrail action (app/(portal)/director/decisions/actions.ts)
-- passes its app-layer requireRole(PERMISSIONS.decision_audit_read) check
-- (director-only) but RLS then silently filters every row, so the Decision
-- Inbox's "Audit Trail" section never renders anything despite the insert
-- having actually succeeded — the exact "app-layer gate updated, RLS not"
-- failure mode already called out in this migration's own audit findings.
--
-- Deliberately narrower than admin/audit's full log access: scoped to
-- table_name IN ('decisions', 'risk_flags') only, not every audit_logs row
-- — Director should see the trail for decisions/escalations, not unrelated
-- admin/system actions (invitations, user management, etc.).

CREATE POLICY "audit_logs_director_decisions_read" ON public.audit_logs
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'director'
    AND table_name IN ('decisions', 'risk_flags')
  );
