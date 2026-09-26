-- ════════════════════════════════════════════════════════════════════
-- 052 — CONTROLLED SEMESTER REOPENING (§6/§7) AND DURABLE AUDIT (§15)
--
-- Phase 3 left three Definition-of-Done boxes open. Two of them are here.
--
-- §6 — "Reopening requires authorization / Reopening is audited".
--   After 047, semesters.status = 'closed' was ABSOLUTELY immutable:
--   guard_academic_period() raises on any UPDATE of a closed row, and
--   semesters_update_manage's USING clause does not even select one. That is
--   stricter than §6 asks for, and the strictness is the problem — a mark
--   entered wrongly before a term closed had no lawful correction path at
--   all, so the pressure lands on someone doing it out of band with service
--   credentials, unaudited. §6 is explicit: "Prefer a controlled correction
--   mechanism instead of broad unrestricted reopening."
--
--   The generic UPDATE stays impossible. Exactly one sanctioned path opens:
--   public.reopen_semester(), which checks the actor, demands a reason, and
--   leaves an audit record.
--
-- §7 — why 'reopened' is a new state rather than a return to 'active'.
--   idx_semesters_one_active (046) permits ONE active semester per college,
--   and that is correct: "active" means the term now running. A term reopened
--   for a correction is not the running term, and making it 'active' would
--   either collide with that index or force the live term closed to make
--   room. §7 anticipates exactly this and lists REOPENED as a legitimate
--   richer state. 'reopened' is therefore a narrow correction window:
--
--       planned ─→ active ─→ closed ⇄ reopened
--                               ↑         │
--                               └─────────┘
--
--   Academic writes flow again because guard_closed_semester (051) freezes on
--   status = 'closed' and 'reopened' is not that. is_current stays false
--   throughout, so nothing treats a reopened term as the current one.
--
-- §15 — "Academic sensitive actions audited / Role changes audited /
--   Semester reopen audited", and "Audit records should themselves be
--   protected against ordinary modification/deletion".
--   lib/audit.ts's logAudit() writes from the application AFTER the mutation
--   commits, so a crash in between loses the record while keeping the change
--   (finding A-002). The triggers below write the record inside the same
--   transaction as the mutation it describes: either both land or neither
--   does. They complement logAudit rather than replacing it — the
--   application still records intent and request context that the database
--   cannot see.
--
-- Depends on: 046 (period foundation), 047 (guard_academic_period,
-- audit_logs_insert), 051 (get_my_role/get_my_college_id active gate,
-- guard_closed_semester).
-- ════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────
-- 1. §7 — admit the 'reopened' state.
--
-- The CHECK is an inline, auto-named constraint from 046 and its name differs
-- depending on whether the table was created or altered into shape, so find
-- it by definition rather than guessing at a name.
-- ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_name text;
BEGIN
  SELECT conname INTO v_name
  FROM pg_constraint
  WHERE conrelid = 'public.semesters'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%planned%'
    AND pg_get_constraintdef(oid) LIKE '%status%'
  LIMIT 1;

  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.semesters DROP CONSTRAINT %I', v_name);
  END IF;

  ALTER TABLE public.semesters
    ADD CONSTRAINT semesters_status_check
    CHECK (status IN ('planned', 'active', 'closed', 'reopened'));
END $$;

-- academic_years is deliberately NOT given this state. A year is reopened by
-- reopening a semester inside it; the year itself stays sealed.

-- ────────────────────────────────────────────────────────────
-- 2. §6/§7 — the period guard learns the two new transitions.
--
-- Everything 047 enforced is preserved verbatim. What is added:
--   closed   → reopened   only via the transaction-local flag (see §3)
--   reopened → closed     ordinary re-close, admin/director through RLS
--   reopened → anything else, and any column edit while reopened, refused.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_academic_period()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_sanctioned boolean;
BEGIN
  IF NEW.college_id IS DISTINCT FROM OLD.college_id THEN
    RAISE EXCEPTION '%: college_id is immutable', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'closed' THEN
    -- The ONE exception to "a closed period is immutable". The flag is
    -- transaction-local and only reopen_semester() can set it: a PostgREST or
    -- RPC caller cannot issue SET or set_config, so it cannot be forged from
    -- outside the database. Pinning it to OLD.id means a reopen sanctioned
    -- for one semester cannot carry a second one along in the same statement.
    v_sanctioned := TG_TABLE_NAME = 'semesters'
                AND NEW.status = 'reopened'
                AND coalesce(current_setting('app.semester_reopen', true), '') = OLD.id::text;

    IF NOT v_sanctioned THEN
      RAISE EXCEPTION '%: a closed period is immutable', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;

    -- A reopen moves the status and touches nothing else. Subtracting the
    -- keys rather than listing the columns keeps this correct when a column
    -- is added to semesters later.
    IF to_jsonb(NEW) - 'status' - 'is_current' - 'updated_at'
       IS DISTINCT FROM
       to_jsonb(OLD) - 'status' - 'is_current' - 'updated_at' THEN
      RAISE EXCEPTION 'semesters: a controlled reopen may change only status'
        USING ERRCODE = 'check_violation';
    END IF;

    NEW.is_current := false;
    RETURN NEW;
  END IF;

  -- The correction window is narrow: a reopened semester goes back to closed
  -- and does nothing else. Its dates, name and academic year stay sealed —
  -- reopening exists to correct academic RECORDS, not to re-plan the term.
  IF TG_TABLE_NAME = 'semesters' AND OLD.status = 'reopened' THEN
    -- Only judge the TRANSITION when there is one. Without the first
    -- condition an UPDATE that touches no status at all — an attempt to
    -- rewrite the term's dates mid-correction — trips this branch and is
    -- refused with a message about a transition that was never attempted,
    -- which also leaves the column freeze below unreachable. (Found by the
    -- column-freeze mutation in tests/staging-mutations-052.test.ts, which
    -- could not make its attack succeed because this check answered first.)
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IS DISTINCT FROM 'closed' THEN
      RAISE EXCEPTION 'semesters: a reopened semester may only be closed again, not moved to %', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;

    IF to_jsonb(NEW) - 'status' - 'is_current' - 'updated_at'
       IS DISTINCT FROM
       to_jsonb(OLD) - 'status' - 'is_current' - 'updated_at' THEN
      RAISE EXCEPTION 'semesters: a reopened semester may change only status'
        USING ERRCODE = 'check_violation';
    END IF;

    NEW.is_current := false;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'planned' AND NEW.status = 'active')
      OR (OLD.status = 'active' AND NEW.status = 'closed')
    ) THEN
      RAISE EXCEPTION '%: status may not move from % to %', TG_TABLE_NAME, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'semesters' THEN
    IF OLD.status <> 'planned' AND NEW.academic_year_id IS DISTINCT FROM OLD.academic_year_id THEN
      RAISE EXCEPTION 'semesters: academic_year_id is immutable once the semester is active'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status = 'active' AND OLD.status = 'planned' THEN
      IF NEW.academic_year_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.academic_years ay
        WHERE ay.id = NEW.academic_year_id AND ay.status = 'active'
      ) THEN
        RAISE EXCEPTION 'semesters: the academic year must be active before a semester in it can be'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    NEW.is_current := (NEW.status = 'active');
  ELSIF TG_TABLE_NAME = 'academic_years' THEN
    -- 047 blocked closing a year that still has an ACTIVE semester. A
    -- reopened one is an open correction window and must block it too,
    -- otherwise closing the year would strand a semester mid-correction.
    IF NEW.status = 'closed' AND OLD.status = 'active' AND EXISTS (
      SELECT 1 FROM public.semesters s
      WHERE s.academic_year_id = NEW.id AND s.status IN ('active', 'reopened')
    ) THEN
      RAISE EXCEPTION 'academic_years: close the active semester before closing the year'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ────────────────────────────────────────────────────────────
-- 3. §6 — the sanctioned reopen.
--
-- SECURITY DEFINER because semesters_update_manage's USING clause excludes a
-- closed row outright, so no amount of role authority reaches it through
-- ordinary RLS. That makes this function the whole attack surface, so it does
-- its own authorization rather than inheriting any.
--
-- Authority: admin and super_admin. NOT director, and not because a director
-- is untrusted — a director manages the periods that are open (see
-- semesters_update_manage), whereas reopening reaches back into sealed
-- history, which §6 frames as a separate, approved act. Widening this to
-- director is a one-word change if that is the intended policy; it is called
-- out here so the choice is visible rather than buried.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reopen_semester(
  p_semester_id uuid,
  p_reason      text
)
RETURNS public.semesters
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_role    text;
  v_college uuid;
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_sem     public.semesters;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'reopen_semester: an authenticated actor is required'
      USING ERRCODE = '42501';
  END IF;

  -- Both helpers were gated on status = 'active' by 051, so a pending or
  -- suspended account resolves neither a role nor a college here.
  v_role    := public.get_my_role();
  v_college := public.get_my_college_id();

  IF v_role IS NULL OR v_role NOT IN ('admin', 'super_admin') THEN
    RAISE EXCEPTION 'reopen_semester: your role may not reopen a closed semester'
      USING ERRCODE = '42501';
  END IF;

  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'reopen_semester: a reason of at least 10 characters is required'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_sem FROM public.semesters WHERE id = p_semester_id;

  -- One message for "does not exist" and for "belongs to another college", so
  -- this cannot be used to probe which semester ids exist elsewhere.
  IF NOT FOUND OR v_sem.college_id IS DISTINCT FROM v_college THEN
    RAISE EXCEPTION 'reopen_semester: no such semester in your college'
      USING ERRCODE = '42501';
  END IF;

  IF v_sem.status <> 'closed' THEN
    RAISE EXCEPTION 'reopen_semester: only a closed semester can be reopened (this one is %)', v_sem.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- A sealed year stays sealed. Reopen the year first if that is really the
  -- intent; this function will not do it as a side effect.
  IF EXISTS (
    SELECT 1 FROM public.academic_years ay
    WHERE ay.id = v_sem.academic_year_id AND ay.status = 'closed'
  ) THEN
    RAISE EXCEPTION 'reopen_semester: the academic year is closed; a semester inside it cannot be reopened'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Transaction-local (the third argument), so the sanction dies with this
  -- statement's transaction and cannot leak into a later one on a pooled
  -- connection. The reason rides alongside for the audit trigger in §5.
  PERFORM set_config('app.semester_reopen', p_semester_id::text, true);
  PERFORM set_config('app.semester_reopen_reason', v_reason, true);

  UPDATE public.semesters
     SET status = 'reopened'
   WHERE id = p_semester_id
  RETURNING * INTO v_sem;

  -- Withdraw the sanction immediately. Anything later in this transaction
  -- faces the ordinary "a closed period is immutable" rule again.
  PERFORM set_config('app.semester_reopen', '', true);
  PERFORM set_config('app.semester_reopen_reason', '', true);

  RETURN v_sem;
END;
$$;

-- `FROM PUBLIC, anon` — not PUBLIC alone. Supabase (and tests/staging/
-- platform.sql, which mirrors it) sets ALTER DEFAULT PRIVILEGES ... GRANT
-- EXECUTE ON FUNCTIONS TO anon, so a new function arrives with an EXPLICIT
-- grant to anon that revoking PUBLIC does not touch. An earlier draft here
-- revoked only PUBLIC, and anon could still call this — it was refused, but
-- by the actor check inside the function rather than by not being callable.
-- Same form as 050's record_gate_movement and friends.
REVOKE ALL ON FUNCTION public.reopen_semester(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_semester(uuid, text) TO authenticated;

-- ────────────────────────────────────────────────────────────
-- 4. §15 — an audit record is write-once.
--
-- audit_logs had no UPDATE or DELETE policy, so under RLS those already
-- affected zero rows. Two reasons that is not enough. It fails SILENTLY — a
-- caller deleting its own tracks gets a success with no rows touched and no
-- signal anywhere. And it depends on the continued ABSENCE of a policy: one
-- careless FOR ALL policy added later reopens it. A trigger states the rule
-- once, in the table, where a future policy cannot undo it.
--
-- The auth.uid() IS NULL escape is the same one guard_closed_semester and the
-- fee guards use: migrations, seeds and out-of-band maintenance run without a
-- session and are not what this defends against.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION 'audit_logs: an audit record cannot be changed or removed once written (attempted %)', TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS guard_audit_immutable ON public.audit_logs;
CREATE TRIGGER guard_audit_immutable
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.guard_audit_immutable();

-- ────────────────────────────────────────────────────────────
-- 5. §15 — audit written by the database, in the mutation's transaction.
--
-- Shared shape. Each of these returns without writing when there is no
-- session: audit_logs.user_id is NOT NULL and references profiles, so a
-- seed or migration has no actor to name, and inventing one would be worse
-- than recording nothing.
-- ────────────────────────────────────────────────────────────

-- 5a. Semester and academic-year state transitions, including the reopen.
CREATE OR REPLACE FUNCTION public.audit_academic_period_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_reason text;
  v_action text;
BEGIN
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  v_reason := nullif(btrim(coalesce(current_setting('app.semester_reopen_reason', true), '')), '');

  v_action := TG_TABLE_NAME || '.' || CASE
    WHEN NEW.status = 'reopened'                          THEN 'reopened'
    WHEN NEW.status = 'closed' AND OLD.status = 'reopened' THEN 'reclosed'
    WHEN NEW.status = 'active'                            THEN 'opened'
    ELSE NEW.status
  END;

  INSERT INTO public.audit_logs
    (college_id, user_id, action, table_name, record_id, old_value, new_value)
  VALUES (
    NEW.college_id, v_actor, v_action, TG_TABLE_NAME, NEW.id::text,
    jsonb_build_object('status', OLD.status),
    jsonb_strip_nulls(jsonb_build_object('status', NEW.status, 'reason', v_reason))
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_period_status ON public.semesters;
CREATE TRIGGER audit_period_status
  AFTER UPDATE ON public.semesters
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.audit_academic_period_status();

DROP TRIGGER IF EXISTS audit_period_status ON public.academic_years;
CREATE TRIGGER audit_period_status
  AFTER UPDATE ON public.academic_years
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.audit_academic_period_status();

-- 5b. Role, status and department changes on a profile — §15's "role changed"
-- and §30's "Role changes audited". enforce_profile_privileged_columns (051)
-- decides whether the change is ALLOWED; this records the ones that are.
CREATE OR REPLACE FUNCTION public.audit_profile_privilege()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  -- A profile with no college yet (a pending signup) has no tenant to file
  -- the record under, and audit_logs.college_id is NOT NULL.
  IF v_actor IS NULL OR NEW.college_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.audit_logs
    (college_id, user_id, action, table_name, record_id, old_value, new_value)
  VALUES (
    NEW.college_id, v_actor, 'profiles.privilege_changed', 'profiles', NEW.id::text,
    jsonb_build_object('role', OLD.role, 'status', OLD.status, 'department_id', OLD.department_id),
    jsonb_build_object('role', NEW.role, 'status', NEW.status, 'department_id', NEW.department_id)
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_profile_privilege ON public.profiles;
CREATE TRIGGER audit_profile_privilege
  AFTER UPDATE ON public.profiles
  FOR EACH ROW
  WHEN (
    OLD.role          IS DISTINCT FROM NEW.role
 OR OLD.status        IS DISTINCT FROM NEW.status
 OR OLD.department_id IS DISTINCT FROM NEW.department_id
  )
  EXECUTE FUNCTION public.audit_profile_privilege();

-- 5c. Marks CHANGED after the fact — §15's "marks modified" and "grade
-- changed".
--
-- UPDATE and DELETE only, deliberately. §25 warns against making every
-- academic write cost more, and marks arrive in bulk: a teacher saving one
-- class writes dozens of rows at once, and auditing each INSERT would double
-- that for no security gain, since the row itself already carries entered_by
-- and created_at. What is NOT self-evident from the row is a later edit or
-- removal — a grade that changed after it was recorded — and that is exactly
-- what this captures.
CREATE OR REPLACE FUNCTION public.audit_marks_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_row   public.marks := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
BEGIN
  IF v_actor IS NULL THEN
    RETURN v_row;
  END IF;

  INSERT INTO public.audit_logs
    (college_id, user_id, action, table_name, record_id, old_value, new_value)
  VALUES (
    v_row.college_id, v_actor,
    CASE WHEN TG_OP = 'DELETE' THEN 'marks.deleted' ELSE 'marks.updated' END,
    'marks', v_row.id::text,
    jsonb_build_object(
      'student_id',     OLD.student_id,
      'exam_type',      OLD.exam_type,
      'obtained_marks', OLD.obtained_marks,
      'max_marks',      OLD.max_marks
    ),
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE jsonb_build_object(
      'student_id',     NEW.student_id,
      'exam_type',      NEW.exam_type,
      'obtained_marks', NEW.obtained_marks,
      'max_marks',      NEW.max_marks
    ) END
  );

  RETURN v_row;
END;
$$;

DROP TRIGGER IF EXISTS audit_marks_change ON public.marks;
CREATE TRIGGER audit_marks_change
  AFTER UPDATE OR DELETE ON public.marks
  FOR EACH ROW EXECUTE FUNCTION public.audit_marks_change();

-- ────────────────────────────────────────────────────────────
-- 6. §25 — the triggers above must not turn an academic write into a scan.
--
-- Every lookup they perform is a single-row primary-key fetch, except the
-- academic_years close check, which needs semesters by year. 046 already
-- indexes that (idx_semesters_academic_year). audit_logs is insert-only here,
-- so the writes cost an index append and nothing more. The read path that
-- these records feed — "show me what happened to this record" — is the one
-- that needs help.
-- ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_logs_record
  ON public.audit_logs(table_name, record_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_college_action
  ON public.audit_logs(college_id, action, created_at DESC);

-- ════════════════════════════════════════════════════════════════════
-- ROLLBACK (manual, for reference — not executed)
--
-- DROP TRIGGER IF EXISTS audit_marks_change ON public.marks;
-- DROP TRIGGER IF EXISTS audit_profile_privilege ON public.profiles;
-- DROP TRIGGER IF EXISTS audit_period_status ON public.academic_years;
-- DROP TRIGGER IF EXISTS audit_period_status ON public.semesters;
-- DROP TRIGGER IF EXISTS guard_audit_immutable ON public.audit_logs;
-- DROP FUNCTION IF EXISTS public.reopen_semester(uuid, text);
-- ... and restore guard_academic_period() from 047.
-- Note: any semester left in 'reopened' must be closed before the CHECK
-- constraint can be narrowed back to three states.
-- ════════════════════════════════════════════════════════════════════
