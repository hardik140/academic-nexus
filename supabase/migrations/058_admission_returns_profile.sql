-- 058: session admission returns the caller's own routing facts.
--
-- WHY. The middleware ran two reads of the same row on every signed-in
-- request: register_current_session() (054) loads the caller's profile to
-- decide admission, and the middleware then read that profile again for
-- role-based routing, through a 20 s Redis cache (one GET per request; a
-- GET, a database read and a SET on a miss; eight invalidation sites).
-- Returning what the function has already read removes the second read, the
-- Redis entry and its invalidation (Redis transformation Phase 2.1).
--
-- WHAT CHANGES. Only the JSON: once the profile row is found, every answer
-- also carries
--   role, college_id, profile_status
-- of the CALLER (auth.uid()) — data the caller could already read through
-- the profiles_select_own policy. An inactive profile now comes back as
-- { state: 'inactive', profile_status: … } so the middleware can still tell
-- "suspended" from "no profile" (which stays a bare { state: 'inactive' }).
-- Admission logic, locking, counting, auditing and grants are unchanged:
-- the body below is 054's, with v_who appended to its answers.
--
-- DEPLOY ORDER. Either order is safe. Code deployed before this migration
-- sees answers without `role` and reads the profile itself (uncached).
--
-- ROLLBACK: re-run 054's definition of register_current_session.

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
  v_who     jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'session: an authenticated session is required'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'inactive');
  END IF;
  -- 058: the caller's own routing facts, from the row read just above.
  v_who := jsonb_build_object(
    'role', v_profile.role,
    'college_id', v_profile.college_id,
    'profile_status', v_profile.status
  );
  IF v_profile.status <> 'active' THEN
    RETURN jsonb_build_object('state', 'inactive') || v_who;
  END IF;

  SELECT lifecycle_state INTO v_cstate FROM public.colleges WHERE id = v_profile.college_id;
  IF v_profile.role <> 'super_admin' AND v_cstate IS DISTINCT FROM 'ACTIVE' THEN
    RETURN jsonb_build_object('state', 'college_unavailable', 'college_state', v_cstate) || v_who;
  END IF;

  IF v_sid IS NULL THEN
    RETURN jsonb_build_object('state', 'no_session_claim', 'enforcement', public.session_enforcement_mode()) || v_who;
  END IF;

  -- Fast path, no lock: most calls are a session that is already admitted.
  SELECT * INTO v_row FROM public.user_sessions WHERE session_id = v_sid;
  IF FOUND THEN
    IF v_row.user_id <> v_uid THEN
      RAISE EXCEPTION 'session: this session belongs to another account'
        USING ERRCODE = '42501';
    END IF;
    IF v_row.status = 'revoked' THEN
      RETURN jsonb_build_object('state', 'revoked', 'reason', v_row.revoked_reason) || v_who;
    END IF;
    IF v_row.status = 'active' THEN
      -- last_seen_at at most every five minutes, so admission is not a write
      -- on every request.
      IF v_row.last_seen_at < now() - interval '5 minutes' THEN
        UPDATE public.user_sessions SET last_seen_at = now() WHERE session_id = v_sid;
      END IF;
      RETURN jsonb_build_object('state', 'active') || v_who;
    END IF;
  END IF;

  -- Admission. One user at a time: a second concurrent registration for the
  -- same user waits here until the first commits, then counts it.
  PERFORM pg_advisory_xact_lock(hashtextextended('user_sessions:' || v_uid::text, 0));

  SELECT * INTO v_row FROM public.user_sessions WHERE session_id = v_sid;
  IF FOUND AND v_row.status = 'revoked' THEN
    RETURN jsonb_build_object('state', 'revoked', 'reason', v_row.revoked_reason) || v_who;
  END IF;
  IF FOUND AND v_row.status = 'active' THEN
    RETURN jsonb_build_object('state', 'active') || v_who;
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
    RETURN jsonb_build_object('state', 'college_unavailable', 'college_state', v_cstate) || v_who;
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
    RETURN jsonb_build_object('state', 'active', 'active_sessions', v_count + 1, 'max_sessions', v_limit) || v_who;
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
  RETURN jsonb_build_object('state', 'rejected', 'active_sessions', v_count, 'max_sessions', v_limit) || v_who;
END;
$$;

REVOKE ALL ON FUNCTION public.register_current_session(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_current_session(text, text, text, text) TO authenticated;
