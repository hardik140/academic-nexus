-- ============================================================
-- Migration 042: profiles — lock the privilege-bearing columns
--
-- CRITICAL (P0). `profiles_update_self` (migration 006) is
--   FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid())
-- — a ROW predicate with no column restriction, and no REVOKE UPDATE(col)
-- exists anywhere in migrations 001-041. Since the anon key ships in the
-- browser bundle, any authenticated user can call PostgREST directly:
--
--   PATCH /rest/v1/profiles?id=eq.<self>   {"role": "admin"}
--
-- That defeats the entire authorization stack at once, because both layers
-- read the row the attacker just wrote: requireRole() (lib/rbac.ts)
-- re-reads profiles.role, and the RLS helpers get_my_role() /
-- get_my_college_id() read the same row. Writing college_id instead breaks
-- multi-tenant isolation; writing status un-suspends a suspended account.
--
-- WHY A TRIGGER AND NOT `REVOKE UPDATE (role, ...) FROM authenticated`:
-- the legitimate role/status writes in this app all run through the
-- CALLER'S OWN client (lib/supabase/server.ts -> `authenticated`), not the
-- service-role client — admin/users' updateUserProfile and updateUserStatus,
-- director/placement-cell's promote/revoke/reactivate, and lib/invitations'
-- department_id fix-up. A column REVOKE would break every one of them.
-- A trigger can tell those apart from self-escalation; a grant cannot.
--
-- Enumerated from the code, this is the complete set of legitimate writers
-- (verified by grepping every `from("profiles")` write in app/, lib/, scripts/):
--
--   admin/users/actions.ts:146     admin      -> role, full_name, phone
--   admin/users/actions.ts:208     admin      -> status
--   admin/users/actions.ts:331     admin      -> status (graduated -> alumni)
--   director/placement-cell:80     director   -> role='placement_cell', status
--   director/placement-cell:150    director   -> status='suspended'
--   director/placement-cell:180    director   -> status='active'
--   lib/invitations.ts:131         inviter    -> department_id
--   app/auth/accept-invite:67      THE USER   -> status 'pending' -> 'active'
--
-- That last one is the reason this is a narrow trigger rather than a blanket
-- "never touch your own row": accepting an invitation is a self-write, and it
-- is legitimate. It is allowed here ONLY as the exact pending->active
-- transition with no other privileged column changing — and the application
-- additionally requires a matching pending `invitations` row before it runs.
--
-- Sign-off: REQUIRED before applying. Per .agent/.rules/rules.md §1 this is
-- an RLS/authorization change and must not be applied autonomously.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_profile_privileged_columns()
RETURNS TRIGGER AS $$
DECLARE
  actor_role text;
BEGIN
  -- Fast path: this UPDATE doesn't touch a privileged column at all
  -- (name/phone/avatar/address edits, and the set_updated_at trigger's own
  -- rewrite, all land here and are unaffected).
  IF NEW.role          IS NOT DISTINCT FROM OLD.role
 AND NEW.college_id    IS NOT DISTINCT FROM OLD.college_id
 AND NEW.status        IS NOT DISTINCT FROM OLD.status
 AND NEW.department_id IS NOT DISTINCT FROM OLD.department_id THEN
    RETURN NEW;
  END IF;

  -- No JWT on the session: the service-role client (lib/supabase/admin.ts),
  -- the SQL console, a migration, or the on_auth_user_created trigger.
  -- Every service-role call site in this app already performs its own
  -- explicit requireRole() check first — that is this codebase's documented
  -- contract for the service-role client — so this is not a hole, it is the
  -- break-glass path that keeps support operations possible.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- college_id is never writable by ANY authenticated caller, including an
  -- admin. Moving a profile between tenants is a support operation with no
  -- product surface; allowing it through the API would make every
  -- college_id = get_my_college_id() policy in the schema bypassable.
  IF NEW.college_id IS DISTINCT FROM OLD.college_id THEN
    RAISE EXCEPTION 'A profile cannot be moved between colleges through the API.'
      USING ERRCODE = '42501';
  END IF;

  actor_role := public.get_my_role();

  -- ---- Self-writes ----------------------------------------------------
  IF NEW.id = auth.uid() THEN
    -- The one legitimate self-write: accepting an invitation.
    IF OLD.status = 'pending'
   AND NEW.status = 'active'
   AND NEW.role          IS NOT DISTINCT FROM OLD.role
   AND NEW.department_id IS NOT DISTINCT FROM OLD.department_id THEN
      RETURN NEW;
    END IF;

    -- Everything else — including the P0 this migration exists to close.
    RAISE EXCEPTION 'You cannot change your own role, status or department.'
      USING ERRCODE = '42501';
  END IF;

  -- ---- Writes on someone else's profile -------------------------------
  IF NEW.role IS DISTINCT FROM OLD.role OR NEW.status IS DISTINCT FROM OLD.status THEN
    IF actor_role NOT IN ('admin', 'super_admin', 'director') THEN
      RAISE EXCEPTION 'Your role cannot change another user''s role or status.'
        USING ERRCODE = '42501';
    END IF;

    -- Director's only legitimate role write is the Placement Cell lifecycle
    -- (director/placement-cell/actions.ts). Without this, migration 042
    -- would hand every Director the ability to mint an admin.
    IF NEW.role IS DISTINCT FROM OLD.role
   AND actor_role = 'director'
   AND NEW.role <> 'placement_cell' THEN
      RAISE EXCEPTION 'A director may only assign the placement_cell role.'
        USING ERRCODE = '42501';
    END IF;

    -- super_admin is a platform role above the college tenant. A college
    -- admin must not be able to mint one. (admin/users/actions.ts's
    -- USER_ROLES already omits it in app code; this is the DB-level twin,
    -- so the rule survives a change to that array.)
    IF NEW.role = 'super_admin' AND actor_role <> 'super_admin' THEN
      RAISE EXCEPTION 'Only a super_admin may grant the super_admin role.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- department_id additionally allows hod, because the invitation flow
  -- (lib/invitations.ts) sets it on the invitee, and a HOD may invite
  -- teachers and students into their own department.
  IF NEW.department_id IS DISTINCT FROM OLD.department_id
 AND actor_role NOT IN ('admin', 'super_admin', 'director', 'hod') THEN
    RAISE EXCEPTION 'Your role cannot change another user''s department.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS enforce_profile_privileged_columns ON public.profiles;
CREATE TRIGGER enforce_profile_privileged_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_privileged_columns();

-- ============================================================
-- Post-apply verification (run as a normal authenticated user, NOT service
-- role — service role is deliberately exempt above and will succeed):
--
--   -- must fail with 42501:
--   UPDATE public.profiles SET role = 'admin' WHERE id = auth.uid();
--   UPDATE public.profiles SET status = 'active' WHERE id = auth.uid();
--   UPDATE public.profiles
--     SET college_id = '00000000-0000-0000-0000-000000000001' WHERE id = auth.uid();
--
--   -- must still succeed:
--   UPDATE public.profiles SET full_name = full_name WHERE id = auth.uid();
--
-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- DROP TRIGGER IF EXISTS enforce_profile_privileged_columns ON public.profiles;
-- DROP FUNCTION IF EXISTS public.enforce_profile_privileged_columns();
