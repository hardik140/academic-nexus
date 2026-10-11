-- ============================================================
-- Migration 053: college lifecycle — ACTIVE, MAINTENANCE, SUSPENDED
-- ============================================================
-- A college can be taken out of service and brought back without touching
-- its data. Three states:
--
--   ACTIVE       normal operation.
--   MAINTENANCE  a full operational block for every college user (student,
--                teacher, hod, finance, warden, director, admin,
--                placement_cell, gate_security, legacy parent). Users see a
--                maintenance page with the published message and the
--                expected resume time. Nothing is deleted or modified.
--   SUSPENDED    the same full block, with a suspension notice instead.
--
-- Lifecycle state is NOT data deletion. No row of any college table is
-- deleted, rewritten or archived by a lifecycle change: the only writes are
-- the colleges row's lifecycle columns, an immutable history row, an
-- audit_logs row, and (migration 054) the revocation of that college's
-- application sessions. Reactivation sets the state back to ACTIVE and every
-- record is exactly where it was.
--
-- WHO MAY CHANGE IT
--
-- super_admin only, and only through set_college_lifecycle(), which demands a
-- reason and writes the history and the audit trail in the same transaction.
-- colleges already has a write path for the college's own Admin (016's
-- colleges_admin UPDATE policy) and a FOR ALL path for super_admin (020).
-- Neither may move the lifecycle columns directly: guard_college_lifecycle()
-- refuses any change to them that set_college_lifecycle() did not sanction —
-- the same transaction-local sanction pattern 052 uses for reopen_semester().
--
-- HOW THE BLOCK IS ENFORCED — IN THE DATABASE
--
-- Browser pages and mobile screens query Supabase directly, so the block
-- cannot live only in middleware or server actions. One definition —
-- app_access_allowed(): an active profile whose college is ACTIVE
-- (super_admin is exempt from the college check; 054 adds the session
-- registry) — applied where it costs once per STATEMENT, never per row:
--
--   1. A RESTRICTIVE policy, tenant_access_gate, on every RLS table, ANDed
--      with every existing policy — including the 35 that authorize on
--      auth.uid() alone (a student's own fees, marks, attendance...). The
--      only exemptions are on profiles: a user can always read their own
--      row (routing, the maintenance page) and a pending invitee can
--      activate their own row.
--   2. guard_tenant_write_access, a statement-level trigger on every RLS
--      table: a SECURITY DEFINER function's statements bypass RLS, so its
--      WRITES are refused here instead, whichever way it authorized.
--   3. The definer functions that READ data for a caller without going
--      through RLS — the gate-security permission helpers and
--      my_gate_pass_credential() — check it themselves.
--
-- get_my_college_id() / get_my_role() are deliberately NOT changed: they
-- run once per ROW in most policies, and gating them measured 3-4x slower
-- on real PostgreSQL for no added protection (every table they guard is
-- already behind layer 1). Functions in 053/054 that make a privileged
-- decision use my_operational_role() / my_operational_college_id() instead,
-- which do include the gate.
--
-- Existing colleges: lifecycle_state is added NOT NULL DEFAULT 'ACTIVE', so
-- every existing college is ACTIVE after this migration and nothing else
-- about it changes. The Platform college can never leave ACTIVE.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. The lifecycle columns.
--
-- A NOT NULL column with a constant default is metadata-only in PostgreSQL
-- 11+: existing rows read 'ACTIVE' without a table rewrite.
-- lifecycle_changed_by is SET NULL on delete so removing a profile can never
-- be blocked by — or cascade into — a college.
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.colleges
  ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS lifecycle_message TEXT,
  ADD COLUMN IF NOT EXISTS lifecycle_expected_resume_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lifecycle_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lifecycle_changed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.colleges DROP CONSTRAINT IF EXISTS colleges_lifecycle_state_check;
ALTER TABLE public.colleges
  ADD CONSTRAINT colleges_lifecycle_state_check
  CHECK (lifecycle_state IN ('ACTIVE', 'MAINTENANCE', 'SUSPENDED'));

-- The Platform college (018) carries every super_admin profile. Blocking it
-- would lock out the only people who can unblock anything.
ALTER TABLE public.colleges DROP CONSTRAINT IF EXISTS colleges_platform_always_active;
ALTER TABLE public.colleges
  ADD CONSTRAINT colleges_platform_always_active
  CHECK (NOT is_platform OR lifecycle_state = 'ACTIVE');

-- A message and a resume time describe an outage; an ACTIVE college has
-- neither, and only MAINTENANCE has an expected end.
ALTER TABLE public.colleges DROP CONSTRAINT IF EXISTS colleges_lifecycle_detail_check;
ALTER TABLE public.colleges
  ADD CONSTRAINT colleges_lifecycle_detail_check
  CHECK (
    (lifecycle_state <> 'ACTIVE' OR (lifecycle_message IS NULL AND lifecycle_expected_resume_at IS NULL))
    AND (lifecycle_expected_resume_at IS NULL OR lifecycle_state = 'MAINTENANCE')
    AND (lifecycle_message IS NULL OR length(lifecycle_message) <= 500)
  );

-- ────────────────────────────────────────────────────────────
-- 2. Lifecycle history — immutable, super_admin-readable only.
--
-- changed_by is the actor's id WITHOUT a foreign key on purpose: a history
-- row must outlive the profile that wrote it, and an ON DELETE action would
-- have to modify an immutable row.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.college_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  previous_state TEXT NOT NULL CHECK (previous_state IN ('ACTIVE', 'MAINTENANCE', 'SUSPENDED')),
  new_state TEXT NOT NULL CHECK (new_state IN ('ACTIVE', 'MAINTENANCE', 'SUSPENDED')),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
  message TEXT CHECK (message IS NULL OR length(message) <= 500),
  expected_resume_at TIMESTAMPTZ,
  sessions_revoked INTEGER NOT NULL DEFAULT 0 CHECK (sessions_revoked >= 0),
  changed_by UUID NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_college_lifecycle_events_college
  ON public.college_lifecycle_events(college_id, changed_at DESC);

ALTER TABLE public.college_lifecycle_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "college_lifecycle_events_super_admin_read" ON public.college_lifecycle_events;
CREATE POLICY "college_lifecycle_events_super_admin_read" ON public.college_lifecycle_events
  FOR SELECT USING (public.get_my_role() = 'super_admin');

-- Written only by the trigger in §4 (SECURITY DEFINER). No session may
-- write, change or remove a history row, including super_admin.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.college_lifecycle_events FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_college_lifecycle_history_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Same escape as guard_audit_immutable (052): migrations and out-of-band
  -- maintenance run without a session and are not what this defends against.
  IF auth.uid() IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'college lifecycle: a history record cannot be changed or removed (attempted %)', TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS guard_college_lifecycle_history_immutable ON public.college_lifecycle_events;
CREATE TRIGGER guard_college_lifecycle_history_immutable
  BEFORE UPDATE OR DELETE ON public.college_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_college_lifecycle_history_immutable();

-- ────────────────────────────────────────────────────────────
-- 3. Only set_college_lifecycle() may move the lifecycle columns.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_college_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Migrations, seeds and the service role carry no session.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- A college is created ACTIVE, with no outage detail.
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle_state <> 'ACTIVE'
       OR NEW.lifecycle_message IS NOT NULL
       OR NEW.lifecycle_expected_resume_at IS NOT NULL
       OR NEW.lifecycle_changed_at IS NOT NULL
       OR NEW.lifecycle_changed_by IS NOT NULL THEN
      RAISE EXCEPTION 'college lifecycle: a new college starts ACTIVE'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.lifecycle_state, NEW.lifecycle_message, NEW.lifecycle_expected_resume_at,
      NEW.lifecycle_changed_at, NEW.lifecycle_changed_by)
     IS DISTINCT FROM
     (OLD.lifecycle_state, OLD.lifecycle_message, OLD.lifecycle_expected_resume_at,
      OLD.lifecycle_changed_at, OLD.lifecycle_changed_by) THEN

    -- The sanction is transaction-local and pinned to this college's id.
    -- PostgREST and RPC callers cannot issue SET or set_config, so it cannot
    -- be forged from outside the database.
    IF coalesce(current_setting('app.college_lifecycle', true), '') <> OLD.id::text THEN
      RAISE EXCEPTION 'college lifecycle: the lifecycle state can only be changed through set_college_lifecycle()'
        USING ERRCODE = '42501';
    END IF;

    -- A sanctioned change moves the lifecycle columns and nothing else.
    IF to_jsonb(NEW) - 'lifecycle_state' - 'lifecycle_message' - 'lifecycle_expected_resume_at'
                     - 'lifecycle_changed_at' - 'lifecycle_changed_by' - 'updated_at'
       IS DISTINCT FROM
       to_jsonb(OLD) - 'lifecycle_state' - 'lifecycle_message' - 'lifecycle_expected_resume_at'
                     - 'lifecycle_changed_at' - 'lifecycle_changed_by' - 'updated_at' THEN
      RAISE EXCEPTION 'college lifecycle: a lifecycle change may not modify other college fields'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_college_lifecycle ON public.colleges;
CREATE TRIGGER guard_college_lifecycle
  BEFORE INSERT OR UPDATE ON public.colleges
  FOR EACH ROW EXECUTE FUNCTION public.guard_college_lifecycle();

-- ────────────────────────────────────────────────────────────
-- 4. History and audit, written by the database in the change's transaction.
--
-- The audit row is filed under the AFFECTED college. A super_admin belongs
-- to the Platform college, so the ordinary audit_logs INSERT policy
-- (college_id = get_my_college_id()) could never accept it; SECURITY DEFINER
-- is what lets the record land where it belongs, exactly as 052's triggers do.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_college_lifecycle_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_reason  text := nullif(btrim(coalesce(current_setting('app.college_lifecycle_reason', true), '')), '');
  v_revoked integer := coalesce(nullif(current_setting('app.college_lifecycle_sessions_revoked', true), '')::integer, 0);
BEGIN
  -- No session, no actor to name (052's convention). guard_college_lifecycle
  -- only lets a session through with set_college_lifecycle()'s sanction, and
  -- that function always supplies a reason.
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.college_lifecycle_events
    (college_id, previous_state, new_state, reason, message, expected_resume_at, sessions_revoked, changed_by)
  VALUES
    (NEW.id, OLD.lifecycle_state, NEW.lifecycle_state, v_reason, NEW.lifecycle_message,
     NEW.lifecycle_expected_resume_at, v_revoked, v_actor);

  INSERT INTO public.audit_logs
    (college_id, user_id, action, table_name, record_id, old_value, new_value)
  VALUES (
    NEW.id, v_actor, 'college.lifecycle_changed', 'colleges', NEW.id::text,
    jsonb_build_object('lifecycle_state', OLD.lifecycle_state),
    jsonb_strip_nulls(jsonb_build_object(
      'lifecycle_state', NEW.lifecycle_state,
      'reason', v_reason,
      'message', NEW.lifecycle_message,
      'expected_resume_at', NEW.lifecycle_expected_resume_at,
      'sessions_revoked', v_revoked
    ))
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS record_college_lifecycle_change ON public.colleges;
CREATE TRIGGER record_college_lifecycle_change
  AFTER UPDATE ON public.colleges
  FOR EACH ROW
  WHEN (
    OLD.lifecycle_state              IS DISTINCT FROM NEW.lifecycle_state
 OR OLD.lifecycle_message            IS DISTINCT FROM NEW.lifecycle_message
 OR OLD.lifecycle_expected_resume_at IS DISTINCT FROM NEW.lifecycle_expected_resume_at
  )
  EXECUTE FUNCTION public.record_college_lifecycle_change();

REVOKE ALL ON FUNCTION public.record_college_lifecycle_change() FROM PUBLIC, anon, authenticated;

-- ────────────────────────────────────────────────────────────
-- 5. Who may use the application: app_access_allowed().
--
-- One definition of "this caller may operate on college data". Migration 054
-- replaces it to add the session registry; nothing else needs to change when
-- it does, because everything below calls this function.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.app_access_allowed()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    JOIN public.colleges c ON c.id = p.college_id
    WHERE p.id = auth.uid()
      AND p.status = 'active'
      AND (p.role = 'super_admin' OR c.lifecycle_state = 'ACTIVE')
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

REVOKE ALL ON FUNCTION public.app_access_allowed() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_access_allowed() TO authenticated, service_role;

-- The caller's role and college, but only while the caller may operate.
-- For the privileged decisions in 053/054 (who may change a lifecycle,
-- revoke a session, switch enforcement): get_my_role() alone would still
-- answer for a session the registry revoked. Not for per-row policies — see
-- the header.
CREATE OR REPLACE FUNCTION public.my_operational_role()
RETURNS TEXT AS $$
  SELECT CASE WHEN public.app_access_allowed() THEN public.get_my_role() END;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.my_operational_college_id()
RETURNS UUID AS $$
  SELECT CASE WHEN public.app_access_allowed() THEN public.get_my_college_id() END;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

REVOKE ALL ON FUNCTION public.my_operational_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_operational_role() TO authenticated;
REVOKE ALL ON FUNCTION public.my_operational_college_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_operational_college_id() TO authenticated;

-- ────────────────────────────────────────────────────────────
-- 6. set_college_lifecycle() — the one door.
--
-- Any transition between the three states, plus updating the message or the
-- expected resume time of a college that is already blocked. Refused:
-- ACTIVE → ACTIVE, an unchanged blocked state, the Platform college, a
-- reason under 10 characters, a resume time in the past or outside
-- MAINTENANCE. 054 replaces this function to revoke the college's
-- sessions when it leaves ACTIVE.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_college_lifecycle(
  p_college_id         uuid,
  p_state              text,
  p_reason             text,
  p_message            text DEFAULT NULL,
  p_expected_resume_at timestamptz DEFAULT NULL
)
RETURNS public.colleges
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_state   text := upper(btrim(coalesce(p_state, '')));
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
  v_college public.colleges;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'college lifecycle: an authenticated actor is required'
      USING ERRCODE = '42501';
  END IF;

  IF public.my_operational_role() IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'college lifecycle: only a super admin may change a college''s lifecycle state'
      USING ERRCODE = '42501';
  END IF;

  IF v_state NOT IN ('ACTIVE', 'MAINTENANCE', 'SUSPENDED') THEN
    RAISE EXCEPTION 'college lifecycle: the state must be ACTIVE, MAINTENANCE or SUSPENDED'
      USING ERRCODE = 'check_violation';
  END IF;

  IF length(v_reason) < 10 OR length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'college lifecycle: a reason of 10 to 1000 characters is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_state = 'ACTIVE' AND (v_message IS NOT NULL OR p_expected_resume_at IS NOT NULL) THEN
    RAISE EXCEPTION 'college lifecycle: an active college has no outage message or resume time'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_message IS NOT NULL AND length(v_message) > 500 THEN
    RAISE EXCEPTION 'college lifecycle: the message is limited to 500 characters'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_expected_resume_at IS NOT NULL AND v_state <> 'MAINTENANCE' THEN
    RAISE EXCEPTION 'college lifecycle: an expected resume time applies only to MAINTENANCE'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_expected_resume_at IS NOT NULL AND p_expected_resume_at <= now() THEN
    RAISE EXCEPTION 'college lifecycle: the expected resume time must be in the future'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_college FROM public.colleges WHERE id = p_college_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'college lifecycle: no such college'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_college.is_platform THEN
    RAISE EXCEPTION 'college lifecycle: the platform college is always ACTIVE'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_college.lifecycle_state = v_state
     AND v_college.lifecycle_message IS NOT DISTINCT FROM v_message
     AND v_college.lifecycle_expected_resume_at IS NOT DISTINCT FROM p_expected_resume_at THEN
    RAISE EXCEPTION 'college lifecycle: the college is already %', v_state
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.college_lifecycle', p_college_id::text, true);
  PERFORM set_config('app.college_lifecycle_reason', v_reason, true);

  UPDATE public.colleges
     SET lifecycle_state = v_state,
         lifecycle_message = CASE WHEN v_state = 'ACTIVE' THEN NULL ELSE v_message END,
         lifecycle_expected_resume_at = CASE WHEN v_state = 'MAINTENANCE' THEN p_expected_resume_at ELSE NULL END,
         lifecycle_changed_at = now(),
         lifecycle_changed_by = v_actor
   WHERE id = p_college_id
  RETURNING * INTO v_college;

  PERFORM set_config('app.college_lifecycle', '', true);
  PERFORM set_config('app.college_lifecycle_reason', '', true);

  RETURN v_college;
END;
$$;

REVOKE ALL ON FUNCTION public.set_college_lifecycle(uuid, text, text, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_college_lifecycle(uuid, text, text, text, timestamptz) TO authenticated;

-- ────────────────────────────────────────────────────────────
-- 7. my_access_state() — why the caller is (or is not) allowed in.
--
-- Middleware, the maintenance page and the mobile API need to tell
-- "maintenance" from "suspended" from "your account is inactive", and a
-- blocked user can no longer read their college row through RLS. This
-- returns only the caller's own status and the college's PUBLIC outage
-- detail (message, expected resume) — never the internal reason, which is
-- history for super_admin. 054 replaces it to add the session state.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.my_access_state()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'profile_status', p.status,
    'role', p.role,
    'college_id', p.college_id,
    'college_name', c.name,
    'college_state', c.lifecycle_state,
    'message', c.lifecycle_message,
    'expected_resume_at', c.lifecycle_expected_resume_at,
    'allowed', public.app_access_allowed()
  )
  FROM public.profiles p
  JOIN public.colleges c ON c.id = p.college_id
  WHERE p.id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.my_access_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_access_state() TO authenticated;

-- ────────────────────────────────────────────────────────────
-- 8. tenant_access_gate — a RESTRICTIVE policy on every RLS table.
--
-- `(SELECT public.app_access_allowed())` is an initplan: evaluated once per
-- statement, not once per row. TO authenticated: anon has no session to
-- gate, and service_role bypasses RLS by design.
-- ────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relrowsecurity
      AND c.relname <> 'profiles'
    ORDER BY c.relname
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_access_gate ON public.%I', r.relname);
    EXECUTE format(
      'CREATE POLICY tenant_access_gate ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING ((SELECT public.app_access_allowed())) WITH CHECK ((SELECT public.app_access_allowed()))',
      r.relname
    );
  END LOOP;
END $$;

-- profiles: the same gate, with the two exemptions the product needs.
--   SELECT  your own row, always — middleware routes on it and the
--           maintenance page reads the account it is explaining.
--   UPDATE  a PENDING invitee activating their own row (accept-invite).
--           An active user of an unavailable college matches neither arm.
DROP POLICY IF EXISTS tenant_access_gate_select ON public.profiles;
CREATE POLICY tenant_access_gate_select ON public.profiles
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING ((SELECT public.app_access_allowed()) OR id = auth.uid());

DROP POLICY IF EXISTS tenant_access_gate_update ON public.profiles;
CREATE POLICY tenant_access_gate_update ON public.profiles
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING ((SELECT public.app_access_allowed()) OR (id = auth.uid() AND status = 'pending'))
  WITH CHECK ((SELECT public.app_access_allowed()) OR id = auth.uid());

DROP POLICY IF EXISTS tenant_access_gate_insert ON public.profiles;
CREATE POLICY tenant_access_gate_insert ON public.profiles
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.app_access_allowed()));

DROP POLICY IF EXISTS tenant_access_gate_delete ON public.profiles;
CREATE POLICY tenant_access_gate_delete ON public.profiles
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING ((SELECT public.app_access_allowed()));

-- ────────────────────────────────────────────────────────────
-- 9. guard_tenant_write_access — refuse writes that bypass RLS.
--
-- A SECURITY DEFINER function runs as the table owner, so RLS — including
-- the restrictive gate — does not apply to its statements. Most of them
-- authorize through the gated helpers, but 050's manual gate movement and
-- credential revocation read the caller's profile themselves. A trigger
-- fires regardless of who owns the statement, so this refuses ANY write by
-- a session that may not operate, whichever path it took. Statement-level:
-- one check per statement, not per row.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_tenant_write_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Migrations, seeds, the auth service and the service role.
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  IF public.app_access_allowed() THEN
    RETURN NULL;
  END IF;

  -- The accept-invite activation (see the profiles gate above).
  IF TG_TABLE_NAME = 'profiles'
     AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND status = 'pending') THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'college access: this account may not change data while its college is unavailable or its session is not authorized'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_tenant_write_access() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relrowsecurity
    ORDER BY c.relname
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS guard_tenant_write_access ON public.%I', r.relname);
    EXECUTE format(
      'CREATE TRIGGER guard_tenant_write_access BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION public.guard_tenant_write_access()',
      r.relname
    );
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────
-- 10. The auth.uid()-based read helpers of 050, gated.
--
-- These authorize a guard (and a student's own QR credential) without going
-- through get_my_role()/get_my_college_id(). Same bodies as 050, plus the
-- gate.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.my_security_personnel_id()
RETURNS UUID AS $$
  SELECT sp.id
  FROM public.security_personnel sp
  JOIN public.profiles p ON p.id = sp.profile_id
  WHERE sp.profile_id = auth.uid()
    AND sp.status = 'ACTIVE'
    AND p.status = 'active'
    AND p.role = 'gate_security'
    AND public.app_access_allowed();
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.security_has_permission(p_permission TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.security_personnel sp
    JOIN public.profiles p ON p.id = sp.profile_id
    WHERE sp.profile_id = auth.uid()
      AND sp.status = 'ACTIVE'
      AND p.status = 'active'
      AND p.role = 'gate_security'
      AND p_permission = ANY (sp.permissions)
  ) AND public.app_access_allowed();
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.my_gate_pass_credential(p_gate_pass_id UUID)
RETURNS TABLE (
  credential_id UUID,
  nonce TEXT,
  status TEXT,
  valid_from TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  version INTEGER,
  college_id UUID,
  movement_state TEXT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT c.id, c.nonce, c.status, c.valid_from, c.expires_at, c.version, c.college_id,
         CASE gp.status
           WHEN 'active'   THEN 'OUTSIDE'
           WHEN 'returned' THEN 'RETURNED'
           ELSE 'NOT_EXITED'
         END
  FROM public.gate_pass_credentials c
  JOIN public.gate_passes gp ON gp.id = c.gate_pass_id
  JOIN public.students s ON s.id = c.student_id
  WHERE c.gate_pass_id = p_gate_pass_id
    AND s.user_id = auth.uid()
    AND public.app_access_allowed()
  ORDER BY c.version DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.my_gate_pass_credential(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_gate_pass_credential(UUID) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════
-- ROLLBACK (manual, for reference — not executed)
--
-- Any college not ACTIVE must be set ACTIVE first (as super_admin, through
-- set_college_lifecycle) so no tenant is left blocked by a half-removed gate.
--
-- DO $$ DECLARE r record; BEGIN
--   FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--            WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relrowsecurity LOOP
--     EXECUTE format('DROP POLICY IF EXISTS tenant_access_gate ON public.%I', r.relname);
--     EXECUTE format('DROP TRIGGER IF EXISTS guard_tenant_write_access ON public.%I', r.relname);
--   END LOOP; END $$;
-- DROP POLICY IF EXISTS tenant_access_gate_select ON public.profiles;  -- and _update/_insert/_delete
-- Restore my_security_personnel_id(), security_has_permission(),
-- my_gate_pass_credential() from 050.
-- DROP FUNCTION IF EXISTS public.my_operational_role(), public.my_operational_college_id();
-- DROP FUNCTION IF EXISTS public.my_access_state(), public.set_college_lifecycle(uuid,text,text,text,timestamptz),
--   public.guard_tenant_write_access(), public.app_access_allowed(),
--   public.record_college_lifecycle_change(), public.guard_college_lifecycle(),
--   public.guard_college_lifecycle_history_immutable();
-- DROP TABLE IF EXISTS public.college_lifecycle_events;
-- ALTER TABLE public.colleges DROP CONSTRAINT colleges_lifecycle_detail_check,
--   DROP CONSTRAINT colleges_platform_always_active, DROP CONSTRAINT colleges_lifecycle_state_check,
--   DROP COLUMN lifecycle_changed_by, DROP COLUMN lifecycle_changed_at,
--   DROP COLUMN lifecycle_expected_resume_at, DROP COLUMN lifecycle_message,
--   DROP COLUMN lifecycle_state;
-- ════════════════════════════════════════════════════════════════════
