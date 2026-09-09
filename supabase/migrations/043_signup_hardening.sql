-- ============================================================
-- Migration 043: handle_new_user() — stop trusting client-supplied role
--
-- CRITICAL (P0). app/login/page.tsx offers signInWithOAuth({provider:"google"})
-- with no hosted-domain restriction, and handle_new_user() (migration 018)
-- reads BOTH role and status straight out of raw_user_meta_data:
--
--   role   = COALESCE(NEW.raw_user_meta_data ->> 'role',   'student')
--   status = COALESCE(NEW.raw_user_meta_data ->> 'status', 'active')
--
-- raw_user_meta_data is client-controlled on any self-service signup —
-- supabase.auth.signUp({ ..., options: { data: { role: 'admin' } } }) is a
-- plain anon-key call. Where email/password signups are enabled on the
-- project (the GoTrue default), that is direct, unauthenticated admin
-- provisioning. Even with them disabled, Google OAuth alone mints an
-- ACTIVE student profile for any Google account on earth, bypassing the
-- entire INVITE_PERMISSIONS cascade in lib/auth/invite-tiers.ts.
--
-- WHY THE TRIGGER CANNOT JUST "TRUST THE INVITE FLOW":
-- both an invitation (admin.generateLink) and a self-signup reach this
-- trigger through GoTrue itself, as the same database role, with the same
-- shape of raw_user_meta_data. There is no in-trigger signal that separates
-- them — and the `invitations` bookkeeping row is written AFTER the auth
-- user exists (lib/invitations.ts), so it cannot be checked here either.
--
-- So the trigger stops guessing. Every new profile is created inert:
--   role   = 'student'   (the least-privileged role in the schema)
--   status = 'pending'   (cannot pass middleware's active-account check)
-- and the two flows that legitimately need something else set it
-- immediately afterwards through the SERVICE-ROLE client, which migration
-- 042's trigger deliberately exempts:
--   - lib/invitations.ts          -> role + department_id (status stays pending
--                                    until the invitee accepts)
--   - scripts/bootstrap-super-admin.ts -> role + status
--
-- Net effect: a self-registered account is created, but it is a pending
-- student who cannot log in and is visible in Admin -> Users for disposal.
-- This holds even if someone re-enables signups in the dashboard later,
-- which is the point — the control lives in the database, not in a toggle.
--
-- college_id is still honoured from metadata. On its own it grants nothing
-- (the account is pending and cannot authenticate), and the invitation flow
-- needs it to place the invitee in the right tenant from the first insert.
--
-- Sign-off: REQUIRED before applying — authentication change, per
-- .agent/.rules/rules.md §1.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, college_id, full_name, email, avatar_url, role, status)
  VALUES (
    NEW.id,
    COALESCE(
      (NEW.raw_user_meta_data ->> 'college_id')::UUID,
      '00000000-0000-0000-0000-000000000001'::UUID
    ),
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', split_part(NEW.email, '@', 1)),
    NEW.email,
    NEW.raw_user_meta_data ->> 'avatar_url',
    -- Deliberately NOT read from raw_user_meta_data — see header.
    'student',
    'pending'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- ALSO DO THIS (not expressible in SQL):
-- Supabase Dashboard -> Authentication -> Sign In / Providers -> Email ->
-- turn OFF "Allow new users to sign up". This migration makes a rogue signup
-- inert; disabling signups stops it being created at all. Belt and braces —
-- neither alone is the whole fix.
--
-- Consider also restricting the Google provider to your institution's
-- hosted domain, so OAuth stops being an open door to account creation.
-- ============================================================

-- ============================================================
-- Post-apply verification
-- ============================================================
-- 1. Invite a user through the app -> profile lands role=<invited>, status='pending'.
-- 2. Accept the invitation -> status flips to 'active' (allowed by migration 042).
-- 3. Sign in with an uninvited Google account -> profile lands role='student',
--    status='pending', and middleware bounces to /login?error=account_suspended.
--
-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- CREATE OR REPLACE FUNCTION public.handle_new_user()
-- RETURNS TRIGGER AS $$
-- BEGIN
--   INSERT INTO public.profiles (id, college_id, full_name, email, avatar_url, role, status)
--   VALUES (
--     NEW.id,
--     COALESCE((NEW.raw_user_meta_data ->> 'college_id')::UUID,
--              '00000000-0000-0000-0000-000000000001'::UUID),
--     COALESCE(NEW.raw_user_meta_data ->> 'full_name', split_part(NEW.email, '@', 1)),
--     NEW.email,
--     NEW.raw_user_meta_data ->> 'avatar_url',
--     COALESCE(NEW.raw_user_meta_data ->> 'role', 'student'),
--     COALESCE(NEW.raw_user_meta_data ->> 'status', 'active')
--   );
--   RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql SECURITY DEFINER;
