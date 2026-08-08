-- ============================================================
-- Migration 018: super_admin role + colleges provisioning columns
-- ============================================================
-- Part of the invitation-based onboarding redesign. Adds a new
-- platform-level role above the existing college-scoped `admin`, without
-- renaming or otherwise touching `admin` itself. See the plan at
-- C:\Users\91981\.claude\plans\crystalline-dancing-floyd.md for the full
-- design — this migration only covers the schema half.

-- 1. Add 'super_admin' to profiles.role's CHECK constraint.
-- The constraint's exact name isn't assumed (this session has no live DB
-- connection to confirm it) — discovered dynamically instead of guessing.
DO $$
DECLARE
  role_check_name text;
BEGIN
  SELECT conname INTO role_check_name
  FROM pg_constraint
  WHERE conrelid = 'public.profiles'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%role%IN%';

  IF role_check_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', role_check_name);
  END IF;
END $$;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('student', 'teacher', 'hod', 'finance', 'director', 'admin', 'warden', 'parent', 'super_admin'));

-- 2. colleges: provisioning metadata for the super_admin-creates-a-college flow.
ALTER TABLE public.colleges
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS is_platform BOOLEAN NOT NULL DEFAULT false;

-- 3. One placeholder non-tenant college so super_admin profiles can satisfy
-- profiles.college_id NOT NULL without making that column nullable —
-- nullable would touch every .eq("college_id", actor.collegeId) call across
-- all 18 existing actions.ts files. super_admin is never scoped to this
-- college's data; RLS grants it access via role checks, not college_id
-- matching (see migration 020).
INSERT INTO public.colleges (id, name, code, country, is_platform)
VALUES ('00000000-0000-0000-0000-000000000000', 'Platform', '__PLATFORM__', 'India', true)
ON CONFLICT (id) DO NOTHING;

-- 4. handle_new_user(): previously hardcoded status='active' unconditionally.
-- Invited users must land as 'pending' until they accept and set a password
-- (see lib/invitations.ts / app/auth/accept-invite). Defaults to 'active'
-- when raw_user_meta_data doesn't specify a status, preserving current
-- behavior for any account created without that field.
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
    COALESCE(NEW.raw_user_meta_data ->> 'role', 'student'),
    COALESCE(NEW.raw_user_meta_data ->> 'status', 'active')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
