-- ============================================================
-- Migration 022: invitations — missing SELECT policy for the invitee
-- ============================================================
-- Root cause of "No pending invitation found for this account" for every
-- invited role except admin/director/hod: migration 019 added
-- invitations_update_by_invitee (UPDATE, user_id = auth.uid()) so an
-- invitee can mark their own invitation accepted, but never added the
-- matching SELECT policy that acceptInvitation() (app/auth/accept-invite
-- /actions.ts) needs to find that row in the first place. The only reason
-- this wasn't caught by the 2026-08-14 invitation-flow debugging pass is
-- that the invitation tested there happened to be for the 'admin' role,
-- which passes invitations_read_college_staff by coincidence — that policy
-- only covers ('admin', 'director', 'hod'), not the other four invitable
-- roles (finance, warden, teacher, student).
--
-- Purely additive, mirrors invitations_update_by_invitee's own predicate
-- exactly — no existing policy touched, no data change.

CREATE POLICY "invitations_read_by_invitee" ON public.invitations
  FOR SELECT USING (user_id = auth.uid());
