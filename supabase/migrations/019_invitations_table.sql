-- ============================================================
-- Migration 019: invitations (bookkeeping for invitation-based onboarding)
-- ============================================================
-- IMPORTANT — read before touching this table or lib/invitations.ts:
-- Supabase Auth's admin.inviteUserByEmail() owns the actual invitation
-- token end-to-end (mints it, emails it, validates/consumes it via its own
-- exchangeCodeForSession flow) — the app never sees the raw token. This
-- table is audit/bookkeeping only: who was invited, what role/college was
-- pinned at invite time, status for a "pending invitations" list, and
-- resend/revoke UX. It is NOT the security boundary — do not treat
-- `status`/`expires_at` here as authoritative gates for anything. The real
-- check at accept time is re-validating against the live authenticated
-- Supabase session (see app/auth/accept-invite/actions.ts).

CREATE TABLE IF NOT EXISTS public.invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL
    CHECK (role IN ('student', 'teacher', 'hod', 'finance', 'director', 'admin', 'warden', 'super_admin')),
  department_id UUID REFERENCES public.departments(id),
  invited_by UUID NOT NULL REFERENCES public.profiles(id),
  -- The auth.users row inviteUserByEmail() created for this invitation.
  -- Needed so resend (delete + re-invite) and revoke (delete) can act on the
  -- right account — set right after a successful inviteUserByEmail call.
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  metadata JSONB,
  token_hash TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at TIMESTAMPTZ,
  accepted_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one pending invitation per (college, email) at a time — resend reuses
-- it, revoke frees it up, rather than accumulating duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_pending_email
  ON public.invitations (college_id, lower(email))
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_invitations_invited_by ON public.invitations(invited_by);
CREATE INDEX IF NOT EXISTS idx_invitations_college_status ON public.invitations(college_id, status);

CREATE TRIGGER set_updated_at_invitations
  BEFORE UPDATE ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

-- Keyed on invited_by = auth.uid() rather than college_id = get_my_college_id()
-- — this is what lets a super_admin inviting into a brand-new college still
-- pass (their own college_id is the platform placeholder, not the new
-- college's), since ownership rather than tenancy is the predicate here.
CREATE POLICY "invitations_read_own" ON public.invitations
  FOR SELECT USING (invited_by = auth.uid());

CREATE POLICY "invitations_update_own" ON public.invitations
  FOR UPDATE USING (invited_by = auth.uid());

CREATE POLICY "invitations_insert_own" ON public.invitations
  FOR INSERT WITH CHECK (invited_by = auth.uid());

-- Lets the invited person themselves mark their own invitation accepted at
-- accept-invite time (app/auth/accept-invite/actions.ts) — they are not
-- invited_by, so invitations_update_own alone wouldn't cover this.
CREATE POLICY "invitations_update_by_invitee" ON public.invitations
  FOR UPDATE USING (user_id = auth.uid());

-- College-scoped staff can see who's been invited into their own college,
-- regardless of which of them sent the invite.
CREATE POLICY "invitations_read_college_staff" ON public.invitations
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director', 'hod')
  );
