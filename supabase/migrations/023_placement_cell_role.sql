-- ============================================================
-- Migration 023: placement_cell role
-- ============================================================
-- Part of the Placement Cell module. Adds a new college-scoped role,
-- `placement_cell`, alongside the existing hod/finance/warden/director
-- roles — a Director-controlled functional role that runs the placement
-- process for its college. See lib/permissions.ts (assign_placement_cell /
-- revoke_placement_cell) and lib/auth/invite-tiers.ts (director-only
-- invite cascade) for the app-layer half of this.
--
-- Follows migration 018's exact pattern: the CHECK constraint's exact name
-- isn't assumed (this session has no live DB connection to confirm it) —
-- discovered dynamically instead of guessing, for both tables that carry a
-- role CHECK constraint.

-- 1. profiles.role
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
  CHECK (role IN ('student', 'teacher', 'hod', 'finance', 'director', 'admin', 'warden', 'parent', 'super_admin', 'placement_cell'));

-- 2. invitations.role — a Director must be able to invite a placement_cell
-- email through the existing invitation flow (lib/invitations.ts).
DO $$
DECLARE
  role_check_name text;
BEGIN
  SELECT conname INTO role_check_name
  FROM pg_constraint
  WHERE conrelid = 'public.invitations'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%role%IN%';

  IF role_check_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.invitations DROP CONSTRAINT %I', role_check_name);
  END IF;
END $$;

ALTER TABLE public.invitations
  ADD CONSTRAINT invitations_role_check
  CHECK (role IN ('student', 'teacher', 'hod', 'finance', 'director', 'admin', 'warden', 'super_admin', 'placement_cell'));
