-- ============================================================
-- Migration 042: allow invited users to read their own invitation
-- ============================================================
-- Invitation acceptance queries the row as the newly authenticated invitee.
-- Keep this migration idempotent so environments that already applied 022
-- can safely receive the same policy again during deployment.

DROP POLICY IF EXISTS "invitations_read_by_invitee" ON public.invitations;

CREATE POLICY "invitations_read_by_invitee" ON public.invitations
  FOR SELECT USING (user_id = auth.uid());