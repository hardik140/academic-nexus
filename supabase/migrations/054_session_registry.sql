-- ============================================================
-- Migration 054: application session registry and device limits
-- ============================================================
-- Supabase Auth (GoTrue) issues the sessions. Every access token it signs
-- carries a `session_id` claim that stays the same across refreshes and
-- cannot be chosen by the client. This migration keeps an APPLICATION-OWNED
-- registry keyed on that claim, and makes the database refuse a session the
-- registry has revoked or refused.
--
-- WHAT THIS DOES NOT DO
--
-- It never reads, writes or deletes auth.sessions or auth.refresh_tokens.
-- Revoking a session here does not end it inside GoTrue: the access token
-- stays cryptographically valid until it expires, and GoTrue may keep
-- refreshing it. What changes immediately is APPLICATION AUTHORIZATION —
-- every RLS policy (through 053's tenant_access_gate and the gated helpers),
-- every write (guard_tenant_write_access) and every server path refuses the
-- revoked session_id, whatever token it arrives with.
--
-- Nor does it add a session lifetime. Supabase sessions end at sign-out or
-- at a dashboard-configured time-box/inactivity limit; expires_at exists for
-- the record and is NULL — the application sets no expiry of its own.
--
-- DEVICE LIMITS — role_session_limits (owner-approved)
--
--   student 1 · parent (legacy) 1
--   teacher, hod, finance, warden, director, admin,
--   placement_cell, gate_security  2
--   super_admin  unlimited (still registered and revocable)
--
-- At the limit the NEW session is REJECTED; no existing session is evicted.
-- The count is of server-issued session ids, never of client-supplied
-- device identifiers — device_id is a label only, so forging one cannot
-- make room. Admission is serialized per user with a transaction-scoped
-- advisory lock, so two parallel logins cannot both take the last slot.
--
-- CUT-OVER — platform_settings.session_enforcement
--
--   'register' (initial)  every server path registers sessions; revoked and
--                         rejected sessions are refused at once; a session
--                         the server has NEVER seen is still tolerated, so
--                         installed mobile builds that query Supabase
--                         directly before calling the API keep working.
--   'enforce'             a session absent from the registry is refused too.
--
-- Stored as one row in platform_settings. Changed only by
-- set_session_enforcement() — super_admin only, reason required, audited.
-- session_enforcement_readiness() gives the evidence for the switch; it is
-- never switched automatically.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. The enforcement mode.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.platform_settings (
  key TEXT PRIMARY KEY CHECK (key IN ('session_enforcement')),
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID,
  CONSTRAINT platform_settings_session_enforcement_value
    CHECK (key <> 'session_enforcement' OR value IN ('register', 'enforce'))
);

INSERT INTO public.platform_settings (key, value)
VALUES ('session_enforcement', 'register')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "platform_settings_super_admin_read" ON public.platform_settings;
CREATE POLICY "platform_settings_super_admin_read" ON public.platform_settings
  FOR SELECT USING (public.get_my_role() = 'super_admin');

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.platform_settings FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_platform_settings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP <> 'UPDATE' OR coalesce(current_setting('app.platform_settings', true), '') <> 'on' THEN
    RAISE EXCEPTION 'session: platform settings change only through set_session_enforcement()'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_platform_settings ON public.platform_settings;
CREATE TRIGGER guard_platform_settings
  BEFORE INSERT OR UPDATE OR DELETE ON public.platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.guard_platform_settings();

-- A missing row reads as 'enforce': if the setting is ever lost, the
-- registry fails closed rather than open.
CREATE OR REPLACE FUNCTION public.session_enforcement_mode()
RETURNS TEXT AS $$
  SELECT coalesce(
    (SELECT value FROM public.platform_settings WHERE key = 'session_enforcement'),
    'enforce'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

REVOKE ALL ON FUNCTION public.session_enforcement_mode() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_enforcement_mode() TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────
-- 2. Per-role limits. NULL = unlimited. A role with no row is admitted
--    nowhere (fail closed), so a future role must be given a limit here.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.role_session_limits (
  role TEXT PRIMARY KEY,
  max_sessions INTEGER CHECK (max_sessions IS NULL OR max_sessions >= 1)
);

INSERT INTO public.role_session_limits (role, max_sessions) VALUES
  ('student', 1),
  ('parent', 1),
  ('teacher', 2),
  ('hod', 2),
  ('finance', 2),
  ('warden', 2),
  ('director', 2),
  ('admin', 2),
  ('placement_cell', 2),
  ('gate_security', 2),
  ('super_admin', NULL)
ON CONFLICT (role) DO NOTHING;

ALTER TABLE public.role_session_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "role_session_limits_read" ON public.role_session_limits;
CREATE POLICY "role_session_limits_read" ON public.role_session_limits
  FOR SELECT USING (auth.uid() IS NOT NULL);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.role_session_limits FROM anon, authenticated;

-- ────────────────────────────────────────────────────────────
-- 3. The registry.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_sessions (
  -- GoTrue's session_id claim. An identifier, not a credential: knowing it
  -- does not let anyone authenticate.
  session_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'rejected', 'revoked')),
  -- Which client registered it. Caller-reported, used ONLY for the cut-over
  -- readiness evidence — never for an authorization decision.
  client TEXT NOT NULL DEFAULT 'web' CHECK (client IN ('web', 'mobile', 'mobile-legacy')),
  -- Labels for the device list. Client-supplied; never counted.
  device_id TEXT CHECK (device_id IS NULL OR length(device_id) <= 100),
  device_label TEXT CHECK (device_label IS NULL OR length(device_label) <= 120),
  user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 400),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Always NULL: the application imposes no session lifetime (see header).
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID,
  revoked_reason TEXT CHECK (revoked_reason IS NULL OR revoked_reason IN (
    'signed_out', 'revoked_by_user', 'revoked_by_admin', 'revoked_by_super_admin',
    'college_maintenance', 'college_suspended'
  )),
  CONSTRAINT user_sessions_revocation_consistent
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active
  ON public.user_sessions(user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_user_sessions_college_live
  ON public.user_sessions(college_id) WHERE status <> 'revoked';
CREATE INDEX IF NOT EXISTS idx_user_sessions_client_seen
  ON public.user_sessions(client, last_seen_at DESC) WHERE status <> 'revoked';

ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;

-- Reads. Writes happen only inside the functions below.
DROP POLICY IF EXISTS "user_sessions_read_own" ON public.user_sessions;
CREATE POLICY "user_sessions_read_own" ON public.user_sessions
  FOR SELECT USING (user_id = auth.uid());

-- Whether an account is a super_admin. A College Admin cannot read every
-- profile, so the policy and revoke_session() below ask this instead of
-- joining profiles under the caller's own rights. It answers one boolean
-- about an id the caller already holds.
CREATE OR REPLACE FUNCTION public.profile_is_super_admin(p_user_id uuid)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id AND role = 'super_admin');
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

REVOKE ALL ON FUNCTION public.profile_is_super_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profile_is_super_admin(uuid) TO authenticated;

-- A College Admin sees the sessions of its own college — never a
-- super_admin's. Super admins normally belong to the Platform college (018),
-- but that is a convention of the invite path, not a constraint, so it is
-- stated here rather than assumed.
DROP POLICY IF EXISTS "user_sessions_read_college_admin" ON public.user_sessions;
CREATE POLICY "user_sessions_read_college_admin" ON public.user_sessions
  FOR SELECT USING (
    public.get_my_role() = 'admin'
    AND college_id = public.get_my_college_id()
    AND NOT public.profile_is_super_admin(user_id)
  );

-- super_admin keeps 020's scope: its own sessions and those of Admin
-- accounts — not every user of every college.
DROP POLICY IF EXISTS "user_sessions_read_super_admin" ON public.user_sessions;
CREATE POLICY "user_sessions_read_super_admin" ON public.user_sessions
  FOR SELECT USING (
    public.get_my_role() = 'super_admin'
    AND (
      user_id = auth.uid()
      OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = user_sessions.user_id AND p.role = 'admin')
    )
  );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.user_sessions FROM anon, authenticated;

-- A revoked session stays revoked; identity columns never move; rows are
-- not deleted by any session.
CREATE OR REPLACE FUNCTION public.guard_user_sessions()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'session: a session record cannot be deleted'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'session: a revoked session cannot be changed'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.college_id IS DISTINCT FROM OLD.college_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'session: a session''s identity is immutable'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_user_sessions ON public.user_sessions;
CREATE TRIGGER guard_user_sessions
  BEFORE UPDATE OR DELETE ON public.user_sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_user_sessions();

-- ────────────────────────────────────────────────────────────
-- 4. The caller's session, and whether it may act.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.current_session_id()
RETURNS UUID AS $$
  SELECT CASE
    WHEN (auth.jwt() ->> 'session_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (auth.jwt() ->> 'session_id')::uuid
  END;
$$ LANGUAGE sql STABLE SET search_path = public, pg_catalog;

REVOKE ALL ON FUNCTION public.current_session_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_session_id() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.current_session_permitted()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_sid    uuid := public.current_session_id();
  v_status text;
  v_owner  uuid;
BEGIN
  IF v_sid IS NOT NULL THEN
    SELECT status, user_id INTO v_status, v_owner
    FROM public.user_sessions WHERE session_id = v_sid;
    IF FOUND THEN
      RETURN v_status = 'active' AND v_owner = auth.uid();
    END IF;
  END IF;
  -- Never registered (or no claim at all): tolerated only during cut-over.
  RETURN public.session_enforcement_mode() = 'register';
END;
$$;

REVOKE ALL ON FUNCTION public.current_session_permitted() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_session_permitted() TO authenticated, service_role;

-- 053's definition plus the session. Every gate calls this one function.
CREATE OR REPLACE FUNCTION public.app_access_allowed()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    JOIN public.colleges c ON c.id = p.college_id
    WHERE p.id = auth.uid()
      AND p.status = 'active'
      AND (p.role = 'super_admin' OR c.lifecycle_state = 'ACTIVE')
  ) AND public.current_session_permitted();
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

REVOKE ALL ON FUNCTION public.app_access_allowed() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_access_allowed() TO authenticated, service_role;

-- 053's write gate, plus one sanctioned channel: the session functions below
-- must be able to record a refusal or a revocation made BY a session that is
-- itself refused (a rejected login revoking one of the user's other devices
-- from the limit page). The flag is transaction-local and set only inside
-- those functions; no PostgREST caller can set it.
CREATE OR REPLACE FUNCTION public.guard_tenant_write_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  IF public.app_access_allowed() THEN
    RETURN NULL;
  END IF;

  IF coalesce(current_setting('app.session_service', true), '') = 'on' THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'profiles'
     AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND status = 'pending') THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'college access: this account may not change data while its college is unavailable or its session is not authorized'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_tenant_write_access() FROM PUBLIC, anon, authenticated;

-- ────────────────────────────────────────────────────────────
-- 5. my_access_state() — 053's, plus the session.
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
    'session_state', CASE
      WHEN public.current_session_id() IS NULL THEN 'no_claim'
      WHEN s.session_id IS NULL THEN 'unregistered'
      ELSE s.status
    END,
    'revoked_reason', s.revoked_reason,
    'enforcement', public.session_enforcement_mode(),
    'active_sessions', (SELECT count(*) FROM public.user_sessions a WHERE a.user_id = p.id AND a.status = 'active'),
    'max_sessions', (SELECT l.max_sessions FROM public.role_session_limits l WHERE l.role = p.role),
    'allowed', public.app_access_allowed()
  )
  FROM public.profiles p
  JOIN public.colleges c ON c.id = p.college_id
  LEFT JOIN public.user_sessions s
    ON s.session_id = public.current_session_id() AND s.user_id = p.id
  WHERE p.id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.my_access_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_access_state() TO authenticated;

-- ────────────────────────────────────────────────────────────
-- 6. register_current_session() — admission.
--
-- Called by middleware (web), by the mobile API guard, and by the mobile
-- app at sign-in. Returns {state, ...}:
--   active              admitted (or already admitted)
--   rejected            at the role's limit — nothing was evicted
--   revoked             this session was revoked; sign in again
--   college_unavailable the college is in MAINTENANCE or SUSPENDED
--   inactive            the account is not active
--   no_session_claim    the token carries no session_id (not a GoTrue
--                       user token); nothing can be registered
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.register_current_session(
  p_client       text DEFAULT 'web',
  p_device_id    text DEFAULT NULL,
  p_device_label text DEFAULT NULL,
  p_user_agent   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_sid     uuid := public.current_session_id();
  v_client  text := CASE WHEN p_client IN ('web', 'mobile', 'mobile-legacy') THEN p_client ELSE 'web' END;
  v_device  text := left(nullif(btrim(coalesce(p_device_id, '')), ''), 100);
  v_label   text := left(nullif(btrim(coalesce(p_device_label, '')), ''), 120);
  v_agent   text := left(nullif(btrim(coalesce(p_user_agent, '')), ''), 400);
  v_profile public.profiles;
  v_cstate  text;
  v_row     public.user_sessions;
  v_known   boolean;
  v_limit   integer;
  v_count   integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'session: an authenticated session is required'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = v_uid;
  IF NOT FOUND OR v_profile.status <> 'active' THEN
    RETURN jsonb_build_object('state', 'inactive');
  END IF;

  SELECT lifecycle_state INTO v_cstate FROM public.colleges WHERE id = v_profile.college_id;
  IF v_profile.role <> 'super_admin' AND v_cstate IS DISTINCT FROM 'ACTIVE' THEN
    RETURN jsonb_build_object('state', 'college_unavailable', 'college_state', v_cstate);
  END IF;

  IF v_sid IS NULL THEN
    RETURN jsonb_build_object('state', 'no_session_claim', 'enforcement', public.session_enforcement_mode());
  END IF;

  -- Fast path, no lock: most calls are a session that is already admitted.
  SELECT * INTO v_row FROM public.user_sessions WHERE session_id = v_sid;
  IF FOUND THEN
    IF v_row.user_id <> v_uid THEN
      RAISE EXCEPTION 'session: this session belongs to another account'
        USING ERRCODE = '42501';
    END IF;
    IF v_row.status = 'revoked' THEN
      RETURN jsonb_build_object('state', 'revoked', 'reason', v_row.revoked_reason);
    END IF;
    IF v_row.status = 'active' THEN
      -- last_seen_at at most every five minutes, so admission is not a write
      -- on every request.
      IF v_row.last_seen_at < now() - interval '5 minutes' THEN
        UPDATE public.user_sessions SET last_seen_at = now() WHERE session_id = v_sid;
      END IF;
      RETURN jsonb_build_object('state', 'active');
    END IF;
  END IF;

  -- Admission. One user at a time: a second concurrent registration for the
  -- same user waits here until the first commits, then counts it.
  PERFORM pg_advisory_xact_lock(hashtextextended('user_sessions:' || v_uid::text, 0));

  SELECT * INTO v_row FROM public.user_sessions WHERE session_id = v_sid;
  IF FOUND AND v_row.status = 'revoked' THEN
    RETURN jsonb_build_object('state', 'revoked', 'reason', v_row.revoked_reason);
  END IF;
  IF FOUND AND v_row.status = 'active' THEN
    RETURN jsonb_build_object('state', 'active');
  END IF;
  v_known := FOUND; -- an earlier rejection of this same session, re-evaluated

  -- Re-read the college state under a SHARE lock. set_college_lifecycle()
  -- holds the row FOR UPDATE while it revokes the college's sessions, so an
  -- admission either finishes before that sweep (and is swept) or waits for
  -- it and sees the new state. Without this, a login racing a suspension
  -- could commit an active session the sweep never saw, which would regain
  -- access the moment the college was reactivated.
  SELECT lifecycle_state INTO v_cstate FROM public.colleges WHERE id = v_profile.college_id FOR SHARE;
  IF v_profile.role <> 'super_admin' AND v_cstate IS DISTINCT FROM 'ACTIVE' THEN
    RETURN jsonb_build_object('state', 'college_unavailable', 'college_state', v_cstate);
  END IF;

  SELECT l.max_sessions INTO v_limit FROM public.role_session_limits l WHERE l.role = v_profile.role;
  IF NOT FOUND THEN
    v_limit := 0; -- a role with no configured limit is admitted nowhere
  END IF;

  SELECT count(*) INTO v_count
  FROM public.user_sessions
  WHERE user_id = v_uid AND status = 'active' AND session_id <> v_sid;

  PERFORM set_config('app.session_service', 'on', true);

  IF v_limit IS NULL OR v_count < v_limit THEN
    INSERT INTO public.user_sessions
      (session_id, user_id, college_id, status, client, device_id, device_label, user_agent)
    VALUES
      (v_sid, v_uid, v_profile.college_id, 'active', v_client, v_device, v_label, v_agent)
    ON CONFLICT (session_id) DO UPDATE
      SET status = 'active', last_seen_at = now(), client = EXCLUDED.client,
          device_id = EXCLUDED.device_id, device_label = EXCLUDED.device_label,
          user_agent = EXCLUDED.user_agent;
    PERFORM set_config('app.session_service', '', true);
    RETURN jsonb_build_object('state', 'active', 'active_sessions', v_count + 1, 'max_sessions', v_limit);
  END IF;

  INSERT INTO public.user_sessions
    (session_id, user_id, college_id, status, client, device_id, device_label, user_agent)
  VALUES
    (v_sid, v_uid, v_profile.college_id, 'rejected', v_client, v_device, v_label, v_agent)
  ON CONFLICT (session_id) DO UPDATE SET last_seen_at = now();

  -- Audited once per session, not on every retry.
  IF NOT v_known THEN
    INSERT INTO public.audit_logs
      (college_id, user_id, action, table_name, record_id, new_value)
    VALUES (
      v_profile.college_id, v_uid, 'session.rejected', 'user_sessions', v_sid::text,
      jsonb_build_object('active_sessions', v_count, 'max_sessions', v_limit, 'client', v_client)
    );
  END IF;

  PERFORM set_config('app.session_service', '', true);
  RETURN jsonb_build_object('state', 'rejected', 'active_sessions', v_count, 'max_sessions', v_limit);
END;
$$;

REVOKE ALL ON FUNCTION public.register_current_session(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_current_session(text, text, text, text) TO authenticated;

-- ────────────────────────────────────────────────────────────
-- 7. Self-service. A session the limit REJECTED may still list and revoke
--    the user's other sessions — that is how a user at the limit makes room
--    without an administrator — but a REVOKED session, an inactive account
--    or an unavailable college may not.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.session_self_service_allowed()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    JOIN public.colleges c ON c.id = p.college_id
    WHERE p.id = auth.uid()
      AND p.status = 'active'
      AND (p.role = 'super_admin' OR c.lifecycle_state = 'ACTIVE')
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.user_sessions s
    WHERE s.session_id = public.current_session_id() AND s.status = 'revoked'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

REVOKE ALL ON FUNCTION public.session_self_service_allowed() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_self_service_allowed() TO authenticated;

CREATE OR REPLACE FUNCTION public.list_my_sessions()
RETURNS TABLE (
  session_id UUID,
  client TEXT,
  device_label TEXT,
  user_agent TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  is_current BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT s.session_id, s.client, s.device_label, s.user_agent, s.status,
         s.created_at, s.last_seen_at, s.session_id = public.current_session_id()
  FROM public.user_sessions s
  WHERE s.user_id = auth.uid()
    AND (s.status = 'active' OR s.session_id = public.current_session_id())
    AND public.session_self_service_allowed()
  ORDER BY s.last_seen_at DESC;
$$;

REVOKE ALL ON FUNCTION public.list_my_sessions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_my_sessions() TO authenticated;

-- ────────────────────────────────────────────────────────────
-- 8. revoke_session() — yourself, your college's Admin, or super_admin for
--    Admin accounts. Every revocation is audited, filed under the college
--    the session belongs to.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revoke_session(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_target public.user_sessions;
  v_reason text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'session: an authenticated session is required'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_target FROM public.user_sessions WHERE session_id = p_session_id FOR UPDATE;

  -- One message for "does not exist" and "not yours to revoke", so session
  -- ids elsewhere cannot be probed.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session: no such session'
      USING ERRCODE = '42501';
  END IF;

  IF v_target.user_id = v_actor THEN
    IF NOT public.session_self_service_allowed() THEN
      RAISE EXCEPTION 'session: no such session'
        USING ERRCODE = '42501';
    END IF;
    v_reason := CASE WHEN p_session_id = public.current_session_id() THEN 'signed_out' ELSE 'revoked_by_user' END;
  ELSIF public.my_operational_role() = 'admin'
        AND v_target.college_id = public.my_operational_college_id()
        AND NOT public.profile_is_super_admin(v_target.user_id) THEN
    v_reason := 'revoked_by_admin';
  ELSIF public.my_operational_role() = 'super_admin'
        AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_target.user_id AND p.role = 'admin') THEN
    v_reason := 'revoked_by_super_admin';
  ELSE
    RAISE EXCEPTION 'session: no such session'
      USING ERRCODE = '42501';
  END IF;

  IF v_target.status = 'revoked' THEN
    RETURN jsonb_build_object('revoked', false, 'already_revoked', true);
  END IF;

  PERFORM set_config('app.session_service', 'on', true);

  UPDATE public.user_sessions
     SET status = 'revoked', revoked_at = now(), revoked_by = v_actor, revoked_reason = v_reason
   WHERE session_id = p_session_id;

  INSERT INTO public.audit_logs
    (college_id, user_id, action, table_name, record_id, old_value, new_value)
  VALUES (
    v_target.college_id, v_actor, 'session.revoked', 'user_sessions', p_session_id::text,
    jsonb_build_object('status', v_target.status),
    jsonb_build_object('status', 'revoked', 'reason', v_reason, 'session_user_id', v_target.user_id)
  );

  PERFORM set_config('app.session_service', '', true);
  RETURN jsonb_build_object('revoked', true, 'reason', v_reason);
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_session(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_session(uuid) TO authenticated;

-- ────────────────────────────────────────────────────────────
-- 9. end_my_sessions() — sign-out.
--
-- supabase-js signOut() defaults to the GLOBAL scope: GoTrue ends every
-- session of the user. The registry mirrors the scope the client used, so a
-- device signed out elsewhere does not keep occupying a slot.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.end_my_sessions(p_scope text DEFAULT 'global')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_sid     uuid := public.current_session_id();
  v_college uuid;
  v_count   integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'session: an authenticated session is required'
      USING ERRCODE = '42501';
  END IF;
  IF p_scope NOT IN ('global', 'local') THEN
    RAISE EXCEPTION 'session: the scope must be global or local'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.session_service', 'on', true);

  UPDATE public.user_sessions
     SET status = 'revoked', revoked_at = now(), revoked_by = v_actor, revoked_reason = 'signed_out'
   WHERE user_id = v_actor
     AND status <> 'revoked'
     AND (p_scope = 'global' OR session_id = v_sid);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  SELECT college_id INTO v_college FROM public.profiles WHERE id = v_actor;
  IF v_count > 0 AND v_college IS NOT NULL THEN
    INSERT INTO public.audit_logs
      (college_id, user_id, action, table_name, record_id, new_value)
    VALUES (
      v_college, v_actor, 'session.signed_out', 'user_sessions', coalesce(v_sid::text, ''),
      jsonb_build_object('scope', p_scope, 'sessions_ended', v_count)
    );
  END IF;

  PERFORM set_config('app.session_service', '', true);
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.end_my_sessions(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_my_sessions(text) TO authenticated;

-- ────────────────────────────────────────────────────────────
-- 10. set_college_lifecycle() — 053's, plus: leaving ACTIVE revokes every
--     registered session of the college in the same transaction, and the
--     count lands in the history row.
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
  v_revoked integer := 0;
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

  IF v_state <> 'ACTIVE' THEN
    PERFORM set_config('app.session_service', 'on', true);
    UPDATE public.user_sessions
       SET status = 'revoked', revoked_at = now(), revoked_by = v_actor,
           revoked_reason = CASE v_state WHEN 'MAINTENANCE' THEN 'college_maintenance' ELSE 'college_suspended' END
     WHERE college_id = p_college_id
       AND status <> 'revoked';
    GET DIAGNOSTICS v_revoked = ROW_COUNT;
    PERFORM set_config('app.session_service', '', true);
  END IF;

  PERFORM set_config('app.college_lifecycle', p_college_id::text, true);
  PERFORM set_config('app.college_lifecycle_reason', v_reason, true);
  PERFORM set_config('app.college_lifecycle_sessions_revoked', v_revoked::text, true);

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
  PERFORM set_config('app.college_lifecycle_sessions_revoked', '', true);

  RETURN v_college;
END;
$$;

REVOKE ALL ON FUNCTION public.set_college_lifecycle(uuid, text, text, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_college_lifecycle(uuid, text, text, text, timestamptz) TO authenticated;

-- ────────────────────────────────────────────────────────────
-- 11. The cut-over switch and its evidence. super_admin only.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_session_enforcement(p_mode text, p_reason text)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_mode     text := lower(btrim(coalesce(p_mode, '')));
  v_reason   text := btrim(coalesce(p_reason, ''));
  v_previous text;
  v_platform uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'session: an authenticated actor is required'
      USING ERRCODE = '42501';
  END IF;
  IF public.my_operational_role() IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'session: only a super admin may change session enforcement'
      USING ERRCODE = '42501';
  END IF;
  IF v_mode NOT IN ('register', 'enforce') THEN
    RAISE EXCEPTION 'session: the mode must be register or enforce'
      USING ERRCODE = 'check_violation';
  END IF;
  IF length(v_reason) < 10 OR length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'session: a reason of 10 to 1000 characters is required'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Enforcing from a session the registry has never admitted would lock the
  -- caller out in this very transaction (its own audit write would be
  -- refused). Sign in again — which registers — first.
  IF v_mode = 'enforce' AND NOT EXISTS (
    SELECT 1 FROM public.user_sessions
    WHERE session_id = public.current_session_id() AND user_id = v_actor AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'session: this session is not registered; sign in again before enforcing registration'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT value INTO v_previous FROM public.platform_settings WHERE key = 'session_enforcement' FOR UPDATE;
  IF v_previous = v_mode THEN
    RAISE EXCEPTION 'session: session enforcement is already %', v_mode
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.platform_settings', 'on', true);
  UPDATE public.platform_settings
     SET value = v_mode, updated_at = now(), updated_by = v_actor
   WHERE key = 'session_enforcement';
  PERFORM set_config('app.platform_settings', '', true);

  SELECT id INTO v_platform FROM public.colleges WHERE is_platform ORDER BY created_at LIMIT 1;
  INSERT INTO public.audit_logs
    (college_id, user_id, action, table_name, record_id, old_value, new_value)
  VALUES (
    v_platform, v_actor, 'platform.session_enforcement_changed', 'platform_settings', 'session_enforcement',
    jsonb_build_object('value', v_previous),
    jsonb_build_object('value', v_mode, 'reason', v_reason)
  );

  RETURN v_mode;
END;
$$;

REVOKE ALL ON FUNCTION public.set_session_enforcement(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_session_enforcement(text, text) TO authenticated;

-- The evidence for switching to 'enforce'. A legacy mobile build (one that
-- does not register at sign-in) is registered as 'mobile-legacy' the first
-- time it calls the mobile API. `ready` is true when no such session has
-- been seen for seven days and the updated app has registered at least one
-- session — see the operational procedure in the PR and the Obsidian log.
CREATE OR REPLACE FUNCTION public.session_enforcement_readiness()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_legacy_7d   integer;
  v_mobile      integer;
  v_result      jsonb;
BEGIN
  IF public.my_operational_role() IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'session: only a super admin may read session enforcement readiness'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_legacy_7d FROM public.user_sessions
   WHERE client = 'mobile-legacy' AND last_seen_at > now() - interval '7 days';
  SELECT count(*) INTO v_mobile FROM public.user_sessions WHERE client = 'mobile';

  SELECT jsonb_build_object(
    'mode', public.session_enforcement_mode(),
    'active_sessions', (SELECT count(*) FROM public.user_sessions WHERE status = 'active'),
    'active_web', (SELECT count(*) FROM public.user_sessions WHERE status = 'active' AND client = 'web'),
    'active_mobile', (SELECT count(*) FROM public.user_sessions WHERE status = 'active' AND client = 'mobile'),
    'active_mobile_legacy', (SELECT count(*) FROM public.user_sessions WHERE status = 'active' AND client = 'mobile-legacy'),
    'mobile_registered_total', v_mobile,
    'legacy_seen_last_7_days', v_legacy_7d,
    'legacy_last_seen_at', (SELECT max(last_seen_at) FROM public.user_sessions WHERE client = 'mobile-legacy'),
    'ready', v_legacy_7d = 0 AND v_mobile > 0
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.session_enforcement_readiness() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_enforcement_readiness() TO authenticated;

-- ────────────────────────────────────────────────────────────
-- 12. The new tables join 053's gates. user_sessions takes the restrictive
--     read gate but NOT the write gate: it is written only by the functions
--     above, which must work for a rejected session.
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS tenant_access_gate ON public.platform_settings;
CREATE POLICY tenant_access_gate ON public.platform_settings AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.app_access_allowed())) WITH CHECK ((SELECT public.app_access_allowed()));
DROP POLICY IF EXISTS tenant_access_gate ON public.role_session_limits;
CREATE POLICY tenant_access_gate ON public.role_session_limits AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.app_access_allowed())) WITH CHECK ((SELECT public.app_access_allowed()));
DROP POLICY IF EXISTS tenant_access_gate ON public.user_sessions;
CREATE POLICY tenant_access_gate ON public.user_sessions AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.app_access_allowed())) WITH CHECK ((SELECT public.app_access_allowed()));

DROP TRIGGER IF EXISTS guard_tenant_write_access ON public.platform_settings;
CREATE TRIGGER guard_tenant_write_access BEFORE INSERT OR UPDATE OR DELETE ON public.platform_settings
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_tenant_write_access();
DROP TRIGGER IF EXISTS guard_tenant_write_access ON public.role_session_limits;
CREATE TRIGGER guard_tenant_write_access BEFORE INSERT OR UPDATE OR DELETE ON public.role_session_limits
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_tenant_write_access();

-- ════════════════════════════════════════════════════════════════════
-- ROLLBACK (manual, for reference — not executed)
--
-- Re-apply 053's app_access_allowed(), my_access_state(),
-- set_college_lifecycle() and guard_tenant_write_access() bodies, then:
-- DROP FUNCTION IF EXISTS public.session_enforcement_readiness(), public.set_session_enforcement(text,text),
--   public.end_my_sessions(text), public.revoke_session(uuid), public.list_my_sessions(),
--   public.session_self_service_allowed(), public.register_current_session(text,text,text,text),
--   public.current_session_permitted(), public.current_session_id(), public.session_enforcement_mode(),
--   public.guard_user_sessions(), public.guard_platform_settings();
-- DROP TABLE IF EXISTS public.user_sessions, public.role_session_limits, public.platform_settings;
-- ════════════════════════════════════════════════════════════════════
