-- ============================================================
-- Migration 050: Gate Security — credential, gate, guard, movement ledger
--
-- WHAT ALREADY EXISTED (and is therefore NOT rebuilt here)
--
--   gate_passes                 004 — the request, its status vocabulary
--                                     (pending/approved/rejected/active/
--                                     returned/expired) and the
--                                     actual_exit / actual_return stamps
--   guard_gate_pass()           047 §7m — the state machine: which
--                                     transitions exist, which columns are
--                                     frozen once decided, and that a
--                                     decided pass cannot be deleted
--   audit_logs                  005 — actor, college, action, target,
--                                     before/after, timestamp
--   notifications               005 — delivery to a person
--   profiles / students         001, 003 — identity and tenancy
--
-- This migration adds the four things that were missing, and nothing else:
--
--   1. A role that is neither Warden nor Director — `gate_security`, whose
--      whole authority is "record what physically happened at a gate".
--   2. A credential the student can present and the server can verify.
--   3. A ledger of physical movements, append-only, with the gate and the
--      guard on every row.
--   4. A single write path that all three go through, so the pass's status,
--      its stamps and the ledger can never disagree.
--
-- THE ONE RULE THE SCHEMA ITSELF ENFORCES
--
--   A gate pass's MOVEMENT transitions are unreachable by every
--   authenticated role. approved -> active and active -> returned are
--   granted to nobody by any policy in this database. They happen only
--   inside record_gate_movement() / record_manual_gate_movement(), which
--   write the ledger row and the status change in one transaction and stamp
--   the time from the server clock.
--
-- That is why 006's `gate_passes_staff FOR ALL` is split up below. It let a
-- warden (and admin) move a pass through the gate directly over PostgREST,
-- with a client-chosen actual_exit, no gate, no guard and no ledger row.
-- The 047 trigger constrained the SHAPE of that write; it could not say
-- that the write should not be theirs to make at all.
--
-- A QR CODE IS A CREDENTIAL, NOT THE AUTHORITY
--
-- gate_pass_credentials stores a nonce, never a token. The scannable
-- payload is `ANGP1.<credential id>.<HMAC-SHA256(key, ...nonce...)>`,
-- assembled and verified in the application (lib/gate-security/credential.ts)
-- with a key that lives in the server environment and never in this
-- database. So:
--
--   * reading every row of this table does not let you mint a QR (no key)
--   * holding the key does not let you mint a QR (no ACTIVE row, bound to an
--     approved pass, inside its window)
--   * a signature that verifies still authorises nothing — the checks below
--     run afterwards, against the row, under a row lock
--
-- The nonce column is additionally unreadable by `authenticated` at the
-- COLUMN-privilege level, so no policy anywhere can widen it by accident.
--
-- DEPENDS ON 047 (guard_gate_pass, the composite tenant keys, the §7n
-- request-integrity policies). 047 and 049 are not yet applied; these ship
-- in the same deployment batch.
--
-- Sign-off: REQUIRED. New role, new tables, new SECURITY DEFINER functions,
-- and a narrowing of an existing FOR ALL policy on gate_passes.
-- ============================================================

-- ---------------------------------------------------------------
-- 0. Preflight: 047 has to be in place, and finished
--
-- This file calls wardens_student() (sections 13, 15 and 16) and binds to
-- the composite tenant keys 047 creates. 047 defines that function near its
-- END, so if 047 aborted anywhere earlier — and a half-applied migration is
-- the normal failure mode on a platform that commits statement by statement
-- — everything here still looks applicable right up until Postgres says
--
--   ERROR: 42883: function public.wardens_student(uuid) does not exist
--
-- That names a symptom two files away from its cause, and it arrives after
-- this migration has already created tables. Checking first turns it into
-- one sentence that says what to do, before anything has been written.
-- ---------------------------------------------------------------
DO $require_047$
BEGIN
  IF to_regprocedure('public.wardens_student(uuid)') IS NULL THEN
    RAISE EXCEPTION 'migration 050 requires 047, which has not been applied or did not finish: public.wardens_student(uuid) is missing. Re-run 047 to completion first — 047, 049 and 050 ship as one batch, in that order.'
      USING ERRCODE = 'undefined_function';
  END IF;
END $require_047$;

-- ---------------------------------------------------------------
-- 1. The role
--
-- Follows 023's exact pattern (the constraint's real name is discovered,
-- not guessed). `gate_security` is an OPERATIONAL role: it inherits nothing
-- from warden and nothing from director. Every authority it has is written
-- out below, and the list is short.
-- ---------------------------------------------------------------
DO $role_profiles$
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
END $role_profiles$;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('student', 'teacher', 'hod', 'finance', 'director', 'admin', 'warden',
                  'parent', 'super_admin', 'placement_cell', 'gate_security'));

DO $role_invitations$
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
END $role_invitations$;

ALTER TABLE public.invitations
  ADD CONSTRAINT invitations_role_check
  CHECK (role IN ('student', 'teacher', 'hod', 'finance', 'director', 'admin', 'warden',
                  'super_admin', 'placement_cell', 'gate_security'));

-- ---------------------------------------------------------------
-- 2. Gates
--
-- A physical entrance. `code` is what the guard sees and what an audit row
-- names; it is unique per college so "MAIN" means one thing inside an
-- institution and nothing across institutions.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (college_id, code),
  -- 047 §7l's pattern: a composite key so children can bind tenancy into
  -- the relationship itself rather than trusting a college_id copy.
  CONSTRAINT gates_tenant_key UNIQUE (id, college_id)
);

CREATE INDEX IF NOT EXISTS idx_gates_college ON public.gates(college_id) WHERE is_active;

-- ---------------------------------------------------------------
-- 3. Security personnel
--
-- The account lifecycle §12 asks for, kept SEPARATE from profiles.status.
-- Two different questions: profiles.status answers "may this person sign
-- in at all", security_personnel.status answers "may this person operate a
-- gate today". A guard stood down from gate duty during an investigation is
-- not necessarily suspended from the product.
--
-- `permissions` is the granular capability list. It is an array rather than
-- a join table because these are capability FLAGS on one subject, never
-- independently addressable objects — and the CHECK makes an unknown string
-- impossible, which a join table's FK would also have done but at the cost
-- of a table nothing else joins to.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.security_personnel (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  employee_code TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED')),
  permissions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  authorized_by UUID REFERENCES public.profiles(id),
  authorized_at TIMESTAMPTZ,
  deactivated_by UUID REFERENCES public.profiles(id),
  deactivated_at TIMESTAMPTZ,
  deactivation_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (college_id, employee_code),
  CONSTRAINT sp_tenant_key UNIQUE (id, college_id),
  -- The vocabulary is closed. A permission string that is not in this list
  -- cannot be stored, so no screen can invent one and no check can silently
  -- pass against a typo.
  CONSTRAINT sp_permissions_known CHECK (
    permissions <@ ARRAY[
      'gate_security.dashboard.view',
      'gate_security.scanner.use',
      'gate_security.pass.view',
      'gate_security.pass.validate',
      'gate_security.movement.record',
      'gate_security.movement.view',
      'gate_security.history.view',
      'gate_security.instructions.view',
      'gate_security.audit.view',
      'gate_security.gate.view'
    ]::TEXT[]
  ),
  CONSTRAINT sp_active_was_authorized CHECK (status <> 'ACTIVE' OR authorized_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_sp_college ON public.security_personnel(college_id, status);

-- ---------------------------------------------------------------
-- 4. Gate assignment
--
-- A guard operates the gates assigned to them. Revocation is a stamp, not
-- a delete: which gates someone could operate last Tuesday is part of the
-- security record.
--
-- The composite FKs are what make "same college" structural rather than
-- conventional — a College A guard cannot be assigned to a College B gate
-- even if someone writes the row directly.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.security_gate_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  security_personnel_id UUID NOT NULL REFERENCES public.security_personnel(id) ON DELETE CASCADE,
  gate_id UUID NOT NULL REFERENCES public.gates(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES public.profiles(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by UUID REFERENCES public.profiles(id),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT sga_personnel_tenant_fkey FOREIGN KEY (security_personnel_id, college_id)
    REFERENCES public.security_personnel(id, college_id) ON DELETE CASCADE,
  CONSTRAINT sga_gate_tenant_fkey FOREIGN KEY (gate_id, college_id)
    REFERENCES public.gates(id, college_id) ON DELETE CASCADE
);

-- One LIVE assignment per (guard, gate); history is unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sga_live
  ON public.security_gate_assignments(security_personnel_id, gate_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sga_gate ON public.security_gate_assignments(gate_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------
-- 4b. gate_passes gets the composite key that everything below binds to.
--
-- THREE columns, not two. 047 §7l's pattern is (id, college_id) — enough to
-- stop a child naming a parent in another tenant. Here the subject matters
-- as well: a movement row says "this student, on this pass", and those two
-- must be the same student the pass was issued to. Binding
-- (gate_pass_id, college_id, student_id) as one foreign key makes the
-- credential and the ledger structurally incapable of attributing a
-- movement to anyone but the pass holder — the §32 attack, refused by a
-- key rather than by a check the application remembers to make.
--
-- It deliberately does NOT reference students(id, college_id). That key
-- belongs to 047, which drops and recreates it on every apply; a dependency
-- from here would make 047 non-re-runnable. Tenancy still reaches students
-- transitively, through the pass.
--
-- Written drop-child-then-parent for the same reason §7l is: on a re-run
-- the dependent FKs already exist, and Postgres refuses to drop a key they
-- point at. They are re-added in section 17.
-- ---------------------------------------------------------------
DO $gate_pass_subject_key$
BEGIN
  IF to_regclass('public.gate_pass_credentials') IS NOT NULL THEN
    ALTER TABLE public.gate_pass_credentials DROP CONSTRAINT IF EXISTS gpc_pass_tenant_fkey;
  END IF;
  IF to_regclass('public.gate_movements') IS NOT NULL THEN
    ALTER TABLE public.gate_movements DROP CONSTRAINT IF EXISTS gm_pass_tenant_fkey;
  END IF;
  ALTER TABLE public.gate_passes DROP CONSTRAINT IF EXISTS gate_passes_subject_key;
  -- DROP CONSTRAINT only matches a constraint. If a previous partial run
  -- left the backing INDEX holding this name with no constraint behind it,
  -- the ADD below fails with 42P07 "relation already exists" — 047 §0b has
  -- the full account; this is the same defect, found in the field on 047.
  IF to_regclass('public.gate_passes_subject_key') IS NOT NULL THEN
    RAISE NOTICE 'migration 050: reclaiming orphaned index gate_passes_subject_key from a previous partial run';
    EXECUTE 'DROP INDEX IF EXISTS public.gate_passes_subject_key';
  END IF;
  ALTER TABLE public.gate_passes
    ADD CONSTRAINT gate_passes_subject_key UNIQUE (id, college_id, student_id);
END $gate_pass_subject_key$;

-- ---------------------------------------------------------------
-- 5. The QR credential
--
-- Issued by the DATABASE at the moment of approval (trigger, §10 below),
-- which is what makes "no QR before approval" structural rather than a rule
-- the approval screen happens to follow.
--
-- valid_from / expires_at are stored on the row rather than recomputed at
-- scan time, so the window a credential was issued under stays knowable
-- after the pass or the policy constants change.
--
-- DESIGN DECISION (registered, not invented silently): the window is
--   valid_from = exit_time  - 2 hours
--   expires_at = return_time + 12 hours
-- Nothing in the existing product states how early a student may present a
-- pass or how long after the due return it should still open a gate. These
-- two constants are declared once in section 10 and are the only place to
-- change that policy.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gate_pass_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  gate_pass_id UUID NOT NULL REFERENCES public.gate_passes(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,

  -- 128 bits of CSPRNG, hex. NOT a secret on its own and NOT the token:
  -- the signature over it is keyed by FINANCE-style server-side material
  -- that this database never holds. Column privileges below keep it away
  -- from `authenticated` regardless.
  nonce TEXT NOT NULL,

  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'CONSUMED', 'REVOKED', 'EXPIRED', 'SUPERSEDED')),
  valid_from TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by UUID REFERENCES public.profiles(id),
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  CONSTRAINT gpc_window CHECK (expires_at > valid_from)
  -- gpc_pass_tenant_fkey — (gate_pass_id, college_id, student_id) — is
  -- added in section 17; see 4b for why it is deferred.
);

-- At most ONE live credential per pass. A reissue supersedes the previous
-- one in the same statement, so two QR images can never both open a gate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gpc_one_active
  ON public.gate_pass_credentials(gate_pass_id)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_gpc_pass ON public.gate_pass_credentials(gate_pass_id);
CREATE INDEX IF NOT EXISTS idx_gpc_expiry ON public.gate_pass_credentials(expires_at) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------
-- 6. The movement ledger
--
-- Append-only. Not "conventionally append-only" — UPDATE and DELETE raise,
-- for every role including admin, and there is no policy that permits
-- either. A correction is a new row with is_override = true and a reason
-- (§35), never an edit of what was recorded at the time.
--
-- occurred_at is stamped by the BEFORE INSERT trigger from the server
-- clock and cannot be supplied. That is the whole of §28.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gate_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  gate_pass_id UUID NOT NULL REFERENCES public.gate_passes(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  gate_id UUID REFERENCES public.gates(id),
  credential_id UUID REFERENCES public.gate_pass_credentials(id),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('OUT', 'IN')),

  -- Who physically recorded it. recorded_by is always a real profile;
  -- security_personnel_id is present for a scan and absent for an override.
  recorded_by UUID NOT NULL REFERENCES public.profiles(id),
  security_personnel_id UUID REFERENCES public.security_personnel(id),
  recorded_role TEXT NOT NULL CHECK (recorded_role IN ('gate_security', 'warden', 'admin', 'director')),

  is_override BOOLEAN NOT NULL DEFAULT false,
  override_reason TEXT,

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT gm_override_has_reason CHECK (
    is_override = false OR (override_reason IS NOT NULL AND length(btrim(override_reason)) >= 10)
  ),
  CONSTRAINT gm_scan_has_gate CHECK (is_override = true OR gate_id IS NOT NULL),
  -- gm_pass_tenant_fkey — (gate_pass_id, college_id, student_id) — is
  -- added in section 17; see 4b for why it is deferred.
  CONSTRAINT gm_gate_tenant_fkey FOREIGN KEY (gate_id, college_id)
    REFERENCES public.gates(id, college_id)
);

-- One OUT and one IN per pass — the hard floor under the state machine.
-- Even if every check above it were bypassed, a pass cannot produce two
-- exits.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gm_one_per_direction
  ON public.gate_movements(gate_pass_id, movement_type);
CREATE INDEX IF NOT EXISTS idx_gm_college_time ON public.gate_movements(college_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_gm_gate_time ON public.gate_movements(gate_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_gm_student ON public.gate_movements(student_id, occurred_at DESC);

-- ---------------------------------------------------------------
-- 7. Security instructions
--
-- Deliberately NOT a second notification system. `notifications` (005) is
-- still what reaches a person; this table is the standing instruction the
-- guard's dashboard shows while it is in force, which a read-once
-- notification cannot express. The Server Action writes both: one row here,
-- one notification per recipient.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.security_instructions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'emergency')),
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'gate', 'person')),
  gate_id UUID REFERENCES public.gates(id) ON DELETE CASCADE,
  security_personnel_id UUID REFERENCES public.security_personnel(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn', 'expired')),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_until TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_by UUID REFERENCES public.profiles(id),
  withdrawn_at TIMESTAMPTZ,
  CONSTRAINT si_audience_target CHECK (
    (audience = 'all'    AND gate_id IS NULL AND security_personnel_id IS NULL)
    OR (audience = 'gate'   AND gate_id IS NOT NULL AND security_personnel_id IS NULL)
    OR (audience = 'person' AND security_personnel_id IS NOT NULL AND gate_id IS NULL)
  ),
  CONSTRAINT si_gate_tenant_fkey FOREIGN KEY (gate_id, college_id)
    REFERENCES public.gates(id, college_id) ON DELETE CASCADE,
  CONSTRAINT si_personnel_tenant_fkey FOREIGN KEY (security_personnel_id, college_id)
    REFERENCES public.security_personnel(id, college_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_si_live ON public.security_instructions(college_id, status, effective_from DESC);

-- ---------------------------------------------------------------
-- 8. Who the caller is, as the database sees it
--
-- SECURITY DEFINER + STABLE, pinned search_path, in the style of 006's
-- get_my_role() and 047 §7q's heads_programme_department(). They exist so a
-- policy can ask the question without the caller needing SELECT on
-- security_personnel.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_security_personnel_id()
RETURNS UUID AS $$
  SELECT sp.id
  FROM public.security_personnel sp
  JOIN public.profiles p ON p.id = sp.profile_id
  WHERE sp.profile_id = auth.uid()
    AND sp.status = 'ACTIVE'
    AND p.status = 'active'
    AND p.role = 'gate_security';
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
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.security_operates_gate(p_gate_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.security_gate_assignments a
    JOIN public.gates g ON g.id = a.gate_id
    WHERE a.gate_id = p_gate_id
      AND a.revoked_at IS NULL
      AND g.is_active
      AND a.security_personnel_id = public.my_security_personnel_id()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- ---------------------------------------------------------------
-- 9. State machines and append-only enforcement
-- ---------------------------------------------------------------

-- The ledger. Nothing edits it, nothing deletes from it, and the time on a
-- row is the database's, not the caller's.
CREATE OR REPLACE FUNCTION public.guard_gate_movement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'gate_movements is an immutable ledger and cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'gate_movements is an immutable ledger; record a correction, do not edit history'
      USING ERRCODE = 'check_violation';
  END IF;

  -- INSERT: the server clock is the authority (§28). A caller-supplied
  -- occurred_at is not rejected with an error that would leak which value
  -- was tried — it is simply overwritten, so no timestamp a client sends
  -- can ever reach the ledger.
  NEW.occurred_at := now();
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_gate_movement_insert ON public.gate_movements;
CREATE TRIGGER guard_gate_movement_insert
  BEFORE INSERT ON public.gate_movements
  FOR EACH ROW EXECUTE FUNCTION public.guard_gate_movement();

DROP TRIGGER IF EXISTS guard_gate_movement_change ON public.gate_movements;
CREATE TRIGGER guard_gate_movement_change
  BEFORE UPDATE OR DELETE ON public.gate_movements
  FOR EACH ROW EXECUTE FUNCTION public.guard_gate_movement();

-- Security personnel lifecycle: PENDING -> ACTIVE -> SUSPENDED <-> ACTIVE,
-- and DEACTIVATED from anywhere. DEACTIVATED is terminal — re-employing
-- someone is a new authorization, with its own audit row, not a revival of
-- the old one.
CREATE OR REPLACE FUNCTION public.guard_security_personnel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  allowed TEXT[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'PENDING' THEN
      RAISE EXCEPTION 'security_personnel: an authorized guard is part of the security record and cannot be deleted'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.college_id IS DISTINCT FROM OLD.college_id OR NEW.profile_id IS DISTINCT FROM OLD.profile_id THEN
    RAISE EXCEPTION 'security_personnel: college_id and profile_id are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.updated_at := now();

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'PENDING'     THEN ARRAY['ACTIVE', 'DEACTIVATED']
    WHEN 'ACTIVE'      THEN ARRAY['SUSPENDED', 'DEACTIVATED']
    WHEN 'SUSPENDED'   THEN ARRAY['ACTIVE', 'DEACTIVATED']
    WHEN 'DEACTIVATED' THEN ARRAY[]::TEXT[]
    ELSE ARRAY[]::TEXT[]
  END;

  IF NOT (NEW.status = ANY (allowed)) THEN
    RAISE EXCEPTION 'security_personnel: status may not move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'ACTIVE' THEN
    IF NEW.authorized_by IS NULL THEN
      RAISE EXCEPTION 'security_personnel: activation must record who authorized it'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.authorized_at := COALESCE(NEW.authorized_at, now());
  END IF;

  IF NEW.status = 'DEACTIVATED' THEN
    NEW.deactivated_at := now();
    IF NEW.deactivated_by IS NULL THEN
      RAISE EXCEPTION 'security_personnel: deactivation must record who did it'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_security_personnel_update ON public.security_personnel;
CREATE TRIGGER guard_security_personnel_update
  BEFORE UPDATE ON public.security_personnel
  FOR EACH ROW EXECUTE FUNCTION public.guard_security_personnel();

DROP TRIGGER IF EXISTS guard_security_personnel_delete ON public.security_personnel;
CREATE TRIGGER guard_security_personnel_delete
  BEFORE DELETE ON public.security_personnel
  FOR EACH ROW EXECUTE FUNCTION public.guard_security_personnel();

-- Credential lifecycle. The bindings never move: a credential belongs to
-- the pass and the student it was issued for, for its whole life. Reissue
-- means a new row.
CREATE OR REPLACE FUNCTION public.guard_gate_pass_credential()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  allowed TEXT[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'gate_pass_credentials: a credential that existed is part of the security record'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.college_id   IS DISTINCT FROM OLD.college_id
  OR NEW.gate_pass_id IS DISTINCT FROM OLD.gate_pass_id
  OR NEW.student_id   IS DISTINCT FROM OLD.student_id
  OR NEW.nonce        IS DISTINCT FROM OLD.nonce
  OR NEW.version      IS DISTINCT FROM OLD.version
  OR NEW.valid_from   IS DISTINCT FROM OLD.valid_from
  OR NEW.expires_at   IS DISTINCT FROM OLD.expires_at
  OR NEW.issued_at    IS DISTINCT FROM OLD.issued_at THEN
    RAISE EXCEPTION 'gate_pass_credentials: a credential is immutable once issued — reissue instead'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'ACTIVE'     THEN ARRAY['CONSUMED', 'REVOKED', 'EXPIRED', 'SUPERSEDED']
    ELSE ARRAY[]::TEXT[]
  END;

  IF NOT (NEW.status = ANY (allowed)) THEN
    RAISE EXCEPTION 'gate_pass_credentials: status may not move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'REVOKED' THEN
    NEW.revoked_at := COALESCE(NEW.revoked_at, now());
    IF NEW.revoked_by IS NULL THEN
      RAISE EXCEPTION 'gate_pass_credentials: a revocation must record who revoked it'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_gate_pass_credential_update ON public.gate_pass_credentials;
CREATE TRIGGER guard_gate_pass_credential_update
  BEFORE UPDATE ON public.gate_pass_credentials
  FOR EACH ROW EXECUTE FUNCTION public.guard_gate_pass_credential();

DROP TRIGGER IF EXISTS guard_gate_pass_credential_delete ON public.gate_pass_credentials;
CREATE TRIGGER guard_gate_pass_credential_delete
  BEFORE DELETE ON public.gate_pass_credentials
  FOR EACH ROW EXECUTE FUNCTION public.guard_gate_pass_credential();

-- Instructions: withdrawal is a stamp; the text of an instruction that was
-- in force is never rewritten.
CREATE OR REPLACE FUNCTION public.guard_security_instruction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'security_instructions: withdraw an instruction, do not delete it'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.college_id IS DISTINCT FROM OLD.college_id
  OR NEW.title      IS DISTINCT FROM OLD.title
  OR NEW.message    IS DISTINCT FROM OLD.message
  OR NEW.audience   IS DISTINCT FROM OLD.audience
  OR NEW.gate_id    IS DISTINCT FROM OLD.gate_id
  OR NEW.security_personnel_id IS DISTINCT FROM OLD.security_personnel_id
  OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'security_instructions: an issued instruction is immutable — withdraw it and issue another'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status <> OLD.status THEN
    IF OLD.status <> 'active' THEN
      RAISE EXCEPTION 'security_instructions: status may not move from % to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'withdrawn' THEN
      NEW.withdrawn_at := now();
      IF NEW.withdrawn_by IS NULL THEN
        RAISE EXCEPTION 'security_instructions: a withdrawal must record who withdrew it'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_security_instruction_update ON public.security_instructions;
CREATE TRIGGER guard_security_instruction_update
  BEFORE UPDATE ON public.security_instructions
  FOR EACH ROW EXECUTE FUNCTION public.guard_security_instruction();

DROP TRIGGER IF EXISTS guard_security_instruction_delete ON public.security_instructions;
CREATE TRIGGER guard_security_instruction_delete
  BEFORE DELETE ON public.security_instructions
  FOR EACH ROW EXECUTE FUNCTION public.guard_security_instruction();

-- ---------------------------------------------------------------
-- 10. The credential is issued by the approval itself
--
-- AFTER UPDATE on gate_passes, pending -> approved. Not by the warden's
-- screen, not by a Server Action: by the transition. A pass cannot end up
-- approved-without-a-credential, and a credential cannot exist for a pass
-- that was never approved, because there is no other code path.
--
-- The same trigger closes the credential down when the pass leaves the
-- states a credential is for: rejected, expired, returned.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.issue_gate_pass_credential()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  -- The two window constants. See the DESIGN DECISION note on the table.
  c_lead  CONSTANT INTERVAL := INTERVAL '2 hours';
  c_grace CONSTANT INTERVAL := INTERVAL '12 hours';
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'approved' THEN
    -- Any earlier credential for this pass stops being scannable first, so
    -- the partial unique index can never see two ACTIVE rows.
    UPDATE public.gate_pass_credentials
       SET status = 'SUPERSEDED'
     WHERE gate_pass_id = NEW.id AND status = 'ACTIVE';

    INSERT INTO public.gate_pass_credentials
      (college_id, gate_pass_id, student_id, nonce, version, valid_from, expires_at)
    SELECT
      NEW.college_id,
      NEW.id,
      NEW.student_id,
      -- Two UUIDs, dashes stripped: 64 hex characters carrying ~244 bits
      -- from pg_strong_random, which is what gen_random_uuid() has used
      -- since PostgreSQL 13. gen_random_bytes() would read better and is
      -- what this line said first, but it lives in pgcrypto and this
      -- schema creates no extensions — a migration that silently depends
      -- on one is a migration that fails on a plain cluster.
      replace(gen_random_uuid()::TEXT, '-', '') || replace(gen_random_uuid()::TEXT, '-', ''),
      1 + COALESCE((SELECT max(version) FROM public.gate_pass_credentials WHERE gate_pass_id = NEW.id), 0),
      NEW.exit_time - c_lead,
      NEW.return_time + c_grace;

  ELSIF NEW.status IN ('rejected', 'expired') AND OLD.status <> NEW.status THEN
    UPDATE public.gate_pass_credentials
       SET status = 'EXPIRED'
     WHERE gate_pass_id = NEW.id AND status = 'ACTIVE';

  ELSIF NEW.status = 'returned' AND OLD.status <> 'returned' THEN
    -- The journey is over; the QR stops opening gates the moment the
    -- student is back inside.
    UPDATE public.gate_pass_credentials
       SET status = 'CONSUMED'
     WHERE gate_pass_id = NEW.id AND status = 'ACTIVE';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS issue_gate_pass_credential ON public.gate_passes;
CREATE TRIGGER issue_gate_pass_credential
  AFTER UPDATE OF status ON public.gate_passes
  FOR EACH ROW EXECUTE FUNCTION public.issue_gate_pass_credential();

-- ---------------------------------------------------------------
-- 11. The security event log
--
-- audit_logs (005) already carries actor, college, action, target, before/
-- after and timestamp, and admin/audit already reads it. A second audit
-- table would have split the security record in two, so this is a thin
-- writer over the existing one with a reserved `action` vocabulary
-- (gate_*) and `table_name = 'gate_movements'`.
--
-- SECURITY DEFINER because it is called from inside the movement
-- recorder, on the DENY path as well as the allow path: an attempt that
-- was refused must still be recorded, and the caller being refused is
-- exactly the caller whose own INSERT we would otherwise be relying on.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_gate_security_event(
  p_college_id UUID,
  p_actor UUID,
  p_action TEXT,
  p_record_id TEXT,
  p_meta JSONB
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  INSERT INTO public.audit_logs (college_id, user_id, action, table_name, record_id, new_value)
  VALUES (p_college_id, p_actor, p_action, 'gate_movements', p_record_id, p_meta);
$$;

REVOKE ALL ON FUNCTION public.log_gate_security_event(UUID, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_gate_security_event(UUID, UUID, TEXT, TEXT, JSONB) TO service_role;

-- ---------------------------------------------------------------
-- 12. record_gate_movement() — the scan
--
-- The ONLY way a gate pass reaches 'active' or 'returned'. No policy in
-- this database grants those transitions to any authenticated role, so
-- this function is not a convenience wrapper over a write the caller could
-- also make directly: it is the write.
--
-- SECURITY DEFINER, and therefore it re-derives EVERYTHING itself rather
-- than trusting a caller who has already been let in somewhere else:
--
--   auth.uid()          the actor, never a parameter
--   security_personnel  active, role gate_security, profile active
--   permissions         gate_security.movement.record present
--   gate                exists, active, in the actor's college, assigned
--   credential          exists, ACTIVE, in window, same college
--   gate pass           locked FOR UPDATE, and IT decides the direction
--   occurred_at         now(), forced again by the ledger trigger
--
-- The client sends a credential id (proved by an HMAC the application
-- verified first), a gate id, and some device metadata. Nothing else it
-- sends is read, and none of the three is trusted as authority: the gate
-- is checked against the assignment, the credential against the row, and
-- the direction is not sent at all.
--
-- Failures RETURN an outcome rather than raising, so the audit row written
-- alongside them survives the transaction. The two exceptions are "you are
-- not a gate operator" (there is no college to file the event under) and
-- the impossible post-lock race, which should abort loudly.
--
-- IDEMPOTENT ON RETRY. Scanning a QR whose movement is already in the
-- ledger returns ALREADY_RECORDED together with that movement — its
-- direction, its server timestamp, the student it belongs to — and writes
-- nothing. A guard whose response was lost to a dropped connection scans
-- again and is told the crossing exists, which is the difference between
-- letting a recorded student walk and turning them back over a network
-- fault. The ledger row count is unchanged by any number of retries; only
-- what the guard can see changes.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_gate_movement(
  p_credential_id UUID,
  p_gate_id UUID,
  p_device JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  outcome TEXT,
  movement TEXT,
  gate_pass_id UUID,
  pass_code TEXT,
  student_name TEXT,
  enrollment_number TEXT,
  destination TEXT,
  purpose TEXT,
  expected_return TIMESTAMPTZ,
  occurred_at TIMESTAMPTZ,
  gate_name TEXT,
  detail TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  -- DESIGN DECISION (registered): two scans of the same pass closer
  -- together than this are one physical event, not two. Nothing in the
  -- existing product states a value; 2 minutes is short enough not to
  -- block a genuine quick errand and long enough to absorb a double tap,
  -- a re-scan after a slow network, and two guards at the same gate.
  c_min_interval CONSTANT INTERVAL := INTERVAL '2 minutes';

  v_actor       UUID := auth.uid();
  v_sp_id       UUID;
  v_college     UUID;
  v_perms       TEXT[];
  v_gate        RECORD;
  v_cred        RECORD;
  v_pass        RECORD;
  v_student     RECORD;
  v_prior       RECORD;
  v_movement    TEXT;
  v_last        TIMESTAMPTZ;
  v_move_id     UUID;
  v_occurred    TIMESTAMPTZ;
  v_rows        INTEGER;
  v_outcome     TEXT;
  v_detail      TEXT;
  v_meta        JSONB;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'gate security: a movement cannot be recorded without an authenticated operator'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT sp.id, sp.college_id, sp.permissions
    INTO v_sp_id, v_college, v_perms
  FROM public.security_personnel sp
  JOIN public.profiles p ON p.id = sp.profile_id
  WHERE sp.profile_id = v_actor
    AND sp.status = 'ACTIVE'
    AND p.status = 'active'
    AND p.role = 'gate_security';

  IF v_sp_id IS NULL THEN
    -- No college to file an event under, and nothing here should confirm
    -- whether the account exists, is suspended, or was never a guard.
    RAISE EXCEPTION 'gate security: this account is not an active gate security operator'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_meta := jsonb_build_object(
    'credential_id', p_credential_id,
    'gate_id', p_gate_id,
    'security_personnel_id', v_sp_id,
    'device', COALESCE(p_device, '{}'::jsonb)
  );

  IF NOT ('gate_security.movement.record' = ANY (v_perms)) THEN
    v_outcome := 'PERMISSION_DENIED';
    v_detail  := 'This account may not record gate movements.';
    PERFORM public.log_gate_security_event(v_college, v_actor, 'gate_scan_permission_denied', p_credential_id::TEXT, v_meta);
    RETURN QUERY SELECT v_outcome, NULL::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT,
                        NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, NULL::TEXT, v_detail;
    RETURN;
  END IF;

  SELECT g.* INTO v_gate
  FROM public.gates g
  WHERE g.id = p_gate_id AND g.college_id = v_college AND g.is_active;

  IF v_gate.id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.security_gate_assignments a
       WHERE a.gate_id = p_gate_id
         AND a.security_personnel_id = v_sp_id
         AND a.revoked_at IS NULL
     ) THEN
    v_outcome := 'UNAUTHORIZED_GATE';
    v_detail  := 'This pass cannot be processed at this gate.';
    PERFORM public.log_gate_security_event(v_college, v_actor, 'gate_scan_unauthorized_gate', p_credential_id::TEXT, v_meta);
    RETURN QUERY SELECT v_outcome, NULL::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT,
                        NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, NULL::TEXT, v_detail;
    RETURN;
  END IF;

  -- Find the pass behind the credential, then take the locks in a fixed
  -- order — gate pass first, credential second. Two guards scanning the
  -- same QR at the same instant therefore queue rather than deadlock, and
  -- the second one reads the status the first one already wrote.
  SELECT c.gate_pass_id, c.college_id INTO v_cred
  FROM public.gate_pass_credentials c WHERE c.id = p_credential_id;

  IF v_cred.gate_pass_id IS NULL THEN
    v_outcome := 'INVALID_QR';
    v_detail  := 'The QR credential could not be verified.';
    PERFORM public.log_gate_security_event(v_college, v_actor, 'gate_scan_invalid_qr', p_credential_id::TEXT, v_meta);
    RETURN QUERY SELECT v_outcome, NULL::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT,
                        NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, v_gate.name, v_detail;
    RETURN;
  END IF;

  IF v_cred.college_id <> v_college THEN
    -- A genuine credential from another institution. The audit row says
    -- exactly that; the guard is told only "invalid", because a scanner
    -- that distinguishes "wrong college" from "not a real pass" is an
    -- oracle for probing other tenants.
    v_outcome := 'INVALID_QR';
    v_detail  := 'The QR credential could not be verified.';
    PERFORM public.log_gate_security_event(v_college, v_actor, 'gate_scan_cross_college',
      p_credential_id::TEXT, v_meta || jsonb_build_object('credential_college_id', v_cred.college_id));
    RETURN QUERY SELECT v_outcome, NULL::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT,
                        NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, v_gate.name, v_detail;
    RETURN;
  END IF;

  SELECT gp.* INTO v_pass FROM public.gate_passes gp WHERE gp.id = v_cred.gate_pass_id FOR UPDATE;
  SELECT c.* INTO v_cred FROM public.gate_pass_credentials c WHERE c.id = p_credential_id FOR UPDATE;

  v_meta := v_meta || jsonb_build_object('gate_pass_id', v_pass.id, 'student_id', v_pass.student_id);

  IF v_cred.status <> 'ACTIVE' THEN
    v_outcome := CASE v_cred.status
      WHEN 'REVOKED'    THEN 'REVOKED'
      WHEN 'EXPIRED'    THEN 'EXPIRED'
      WHEN 'CONSUMED'   THEN 'ALREADY_RETURNED'
      WHEN 'SUPERSEDED' THEN 'INVALID_QR'
      ELSE 'INVALID_QR'
    END;
    v_detail := CASE v_outcome
      WHEN 'REVOKED'          THEN 'This gate pass has been revoked.'
      WHEN 'EXPIRED'          THEN 'This gate pass is no longer valid.'
      WHEN 'ALREADY_RETURNED' THEN 'This student has already returned on this pass.'
      ELSE 'The QR credential could not be verified.'
    END;
    PERFORM public.log_gate_security_event(v_college, v_actor, 'gate_scan_' || lower(v_outcome), v_pass.id::TEXT,
      v_meta || jsonb_build_object('credential_status', v_cred.status));
    RETURN QUERY SELECT v_outcome, NULL::TEXT, v_pass.id, NULL::TEXT, NULL::TEXT, NULL::TEXT,
                        NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, v_gate.name, v_detail;
    RETURN;
  END IF;

  IF now() < v_cred.valid_from THEN
    v_outcome := 'NOT_YET_VALID';
    v_detail  := 'This gate pass is not valid yet.';
    PERFORM public.log_gate_security_event(v_college, v_actor, 'gate_scan_not_yet_valid', v_pass.id::TEXT, v_meta);
    RETURN QUERY SELECT v_outcome, NULL::TEXT, v_pass.id, NULL::TEXT, NULL::TEXT, NULL::TEXT,
                        NULL::TEXT, NULL::TEXT, v_cred.valid_from, NULL::TIMESTAMPTZ, v_gate.name, v_detail;
    RETURN;
  END IF;

  IF now() > v_cred.expires_at THEN
    UPDATE public.gate_pass_credentials SET status = 'EXPIRED' WHERE id = v_cred.id AND status = 'ACTIVE';
    v_outcome := 'EXPIRED';
    v_detail  := 'This gate pass is no longer valid.';
    PERFORM public.log_gate_security_event(v_college, v_actor, 'gate_scan_expired', v_pass.id::TEXT, v_meta);
    RETURN QUERY SELECT v_outcome, NULL::TEXT, v_pass.id, NULL::TEXT, NULL::TEXT, NULL::TEXT,
                        NULL::TEXT, NULL::TEXT, v_cred.expires_at, NULL::TIMESTAMPTZ, v_gate.name, v_detail;
    RETURN;
  END IF;

  -- The DATABASE decides the direction, from the state it holds. The
  -- client never sends one.
  v_movement := CASE v_pass.status
    WHEN 'approved' THEN 'OUT'
    WHEN 'active'   THEN 'IN'
    ELSE NULL
  END;

  IF v_movement IS NULL THEN
    v_outcome := CASE v_pass.status
      WHEN 'pending'  THEN 'NOT_APPROVED'
      WHEN 'rejected' THEN 'PASS_REJECTED'
      WHEN 'returned' THEN 'ALREADY_RETURNED'
      WHEN 'expired'  THEN 'EXPIRED'
      ELSE 'INVALID_MOVEMENT'
    END;
    v_detail := CASE v_outcome
      WHEN 'NOT_APPROVED'     THEN 'This gate pass is still awaiting warden approval.'
      WHEN 'PASS_REJECTED'    THEN 'This gate pass was rejected.'
      WHEN 'ALREADY_RETURNED' THEN 'This student has already returned on this pass.'
      WHEN 'EXPIRED'          THEN 'This gate pass is no longer valid.'
      ELSE 'This pass cannot be used for a movement right now.'
    END;
    PERFORM public.log_gate_security_event(v_college, v_actor, 'gate_scan_' || lower(v_outcome), v_pass.id::TEXT,
      v_meta || jsonb_build_object('pass_status', v_pass.status));
    RETURN QUERY SELECT v_outcome, NULL::TEXT, v_pass.id, NULL::TEXT, NULL::TEXT, NULL::TEXT,
                        NULL::TEXT, NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, v_gate.name, v_detail;
    RETURN;
  END IF;

  -- Duplicate scan: the same pass moving twice inside the window is one
  -- physical event. Without this, a double tap would record an exit and an
  -- immediate return, and the student would read as back inside while
  -- standing outside the gate.
  --
  -- It is also where a RETRY lands, and that is the case worth getting
  -- right. A guard whose network drops between the INSERT and the response
  -- has no way to know the movement was recorded, so they scan again. The
  -- honest answer to that second scan is not "refused" — it is "already
  -- done, and here it is". Answering with a bare refusal is what makes a
  -- guard either wave the student through unrecorded or turn them back for
  -- a movement that is sitting in the ledger.
  --
  -- So the duplicate path REPLAYS the stored movement in full. The ledger
  -- still gets exactly one row; the difference is entirely in what the
  -- person at the gate is able to see. Nothing new is disclosed: this is
  -- the same projection a successful scan of this credential at this gate
  -- would have returned, to a guard who has already cleared every check
  -- above.
  SELECT m.* INTO v_prior
  FROM public.gate_movements m
  WHERE m.gate_pass_id = v_pass.id
  ORDER BY m.occurred_at DESC
  LIMIT 1;
  v_last := v_prior.occurred_at;

  IF v_last IS NOT NULL AND now() - v_last < c_min_interval THEN
    SELECT s.enrollment_number, pr.full_name INTO v_student
    FROM public.students s
    JOIN public.profiles pr ON pr.id = s.user_id
    WHERE s.id = v_pass.student_id;

    PERFORM public.log_gate_security_event(v_college, v_actor, 'gate_scan_duplicate', v_pass.id::TEXT,
      v_meta || jsonb_build_object('last_movement_at', v_last, 'replayed_movement_id', v_prior.id));

    RETURN QUERY SELECT
      'ALREADY_RECORDED'::TEXT,
      v_prior.movement_type,
      v_pass.id,
      'GP-' || upper(substr(replace(v_pass.id::TEXT, '-', ''), 1, 8)),
      v_student.full_name,
      v_student.enrollment_number,
      v_pass.destination,
      v_pass.reason,
      v_pass.return_time,
      v_prior.occurred_at,
      v_gate.name,
      CASE v_prior.movement_type
        WHEN 'OUT' THEN 'Exit was already recorded for this pass. No second movement was created.'
        ELSE 'Return was already recorded for this pass. No second movement was created.'
      END;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.gate_movements
      (college_id, gate_pass_id, student_id, gate_id, credential_id, movement_type,
       recorded_by, security_personnel_id, recorded_role, device_info)
    VALUES
      (v_college, v_pass.id, v_pass.student_id, v_gate.id, v_cred.id, v_movement,
       v_actor, v_sp_id, 'gate_security', COALESCE(p_device, '{}'::jsonb))
    RETURNING id, gate_movements.occurred_at INTO v_move_id, v_occurred;
  EXCEPTION WHEN unique_violation THEN
    -- idx_gm_one_per_direction. Under the row lock above this should be
    -- unreachable; it is the floor that holds if it ever is reached — and
    -- like the duplicate window, it answers with the movement that already
    -- exists rather than with a bare refusal, because a retry that arrives
    -- after the 2-minute window has drained is still a retry.
    SELECT m.* INTO v_prior
    FROM public.gate_movements m
    WHERE m.gate_pass_id = v_pass.id AND m.movement_type = v_movement;

    SELECT s.enrollment_number, pr.full_name INTO v_student
    FROM public.students s
    JOIN public.profiles pr ON pr.id = s.user_id
    WHERE s.id = v_pass.student_id;

    PERFORM public.log_gate_security_event(v_college, v_actor, 'gate_scan_duplicate', v_pass.id::TEXT,
      v_meta || jsonb_build_object('replayed_movement_id', v_prior.id, 'via', 'unique_index'));

    RETURN QUERY SELECT
      'ALREADY_RECORDED'::TEXT,
      v_movement,
      v_pass.id,
      'GP-' || upper(substr(replace(v_pass.id::TEXT, '-', ''), 1, 8)),
      v_student.full_name,
      v_student.enrollment_number,
      v_pass.destination,
      v_pass.reason,
      v_pass.return_time,
      v_prior.occurred_at,
      v_gate.name,
      CASE WHEN v_movement = 'OUT'
        THEN 'Exit was already recorded for this pass. No second movement was created.'
        ELSE 'Return was already recorded for this pass. No second movement was created.'
      END;
    RETURN;
  END;

  -- Compare-and-swap against the status this function read under the lock.
  -- The stamps are now(), never anything a caller supplied.
  UPDATE public.gate_passes
     SET status        = CASE WHEN v_movement = 'OUT' THEN 'active' ELSE 'returned' END,
         actual_exit   = CASE WHEN v_movement = 'OUT' THEN now() ELSE actual_exit END,
         actual_return = CASE WHEN v_movement = 'IN'  THEN now() ELSE actual_return END
   WHERE id = v_pass.id
     AND status = v_pass.status;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'gate security: the gate pass changed while the movement was being recorded'
      USING ERRCODE = 'serialization_failure';
  END IF;

  SELECT s.enrollment_number, pr.full_name INTO v_student
  FROM public.students s
  JOIN public.profiles pr ON pr.id = s.user_id
  WHERE s.id = v_pass.student_id;

  PERFORM public.log_gate_security_event(v_college, v_actor, 'gate_movement_' || lower(v_movement), v_move_id::TEXT,
    v_meta || jsonb_build_object('movement_id', v_move_id, 'movement_type', v_movement, 'occurred_at', v_occurred));

  RETURN QUERY SELECT
    'RECORDED'::TEXT,
    v_movement,
    v_pass.id,
    'GP-' || upper(substr(replace(v_pass.id::TEXT, '-', ''), 1, 8)),
    v_student.full_name,
    v_student.enrollment_number,
    v_pass.destination,
    v_pass.reason,
    v_pass.return_time,
    v_occurred,
    v_gate.name,
    CASE WHEN v_movement = 'OUT' THEN 'Exit recorded.' ELSE 'Return recorded.' END;
END;
$$;

REVOKE ALL ON FUNCTION public.record_gate_movement(UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_gate_movement(UUID, UUID, JSONB) TO authenticated, service_role;

-- ---------------------------------------------------------------
-- 13. record_manual_gate_movement() — the override
--
-- Warden and admin could already move a pass through the gate directly
-- (047's gate_passes_staff was FOR ALL, and warden/gatepasses/actions.ts
-- exposes "Verify exit"/"Verify return" buttons over it). Section 16
-- removes that. This replaces it with the shape §35 asks for: an explicit,
-- separately-named path that demands a reason, names the actor, stamps the
-- server clock, and lands in the same ledger every scan lands in.
--
-- It is NOT a bypass of the state machine — a pass still has to be in the
-- right state, a return still has to follow an exit, and the ledger still
-- refuses a second exit. What it bypasses is the QR and the gate, which is
-- the whole point: a phone with a flat battery is a real event at a real
-- gate, and the alternative to recording it honestly is a guard waving the
-- student through with nothing written down at all.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_manual_gate_movement(
  p_gate_pass_id UUID,
  p_movement TEXT,
  p_gate_id UUID,
  p_reason TEXT
)
RETURNS TABLE (
  outcome TEXT,
  movement TEXT,
  gate_pass_id UUID,
  occurred_at TIMESTAMPTZ,
  detail TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_actor    UUID := auth.uid();
  v_role     TEXT;
  v_college  UUID;
  v_pass     RECORD;
  v_expected TEXT;
  v_move_id  UUID;
  v_occurred TIMESTAMPTZ;
  v_rows     INTEGER;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'gate security: an override cannot be recorded without an authenticated actor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_movement NOT IN ('OUT', 'IN') THEN
    RAISE EXCEPTION 'gate security: movement must be OUT or IN' USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'gate security: an override must record why it was necessary'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT p.role, p.college_id INTO v_role, v_college
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  IF v_role IS NULL OR v_role NOT IN ('warden', 'admin') THEN
    RAISE EXCEPTION 'gate security: only a warden or an administrator may record a manual movement'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT gp.* INTO v_pass FROM public.gate_passes gp
  WHERE gp.id = p_gate_pass_id AND gp.college_id = v_college
  FOR UPDATE;

  IF v_pass.id IS NULL THEN
    RAISE EXCEPTION 'gate security: gate pass not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- The same block ownership warden/gatepasses/actions.ts enforces in app
  -- code, enforced here too — this function runs as its owner, so the RLS
  -- that would otherwise have scoped the read does not apply.
  IF v_role = 'warden' AND NOT public.wardens_student(v_pass.student_id) THEN
    RAISE EXCEPTION 'gate security: this student is not in your hostel block'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_gate_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.gates g WHERE g.id = p_gate_id AND g.college_id = v_college
  ) THEN
    RAISE EXCEPTION 'gate security: unknown gate' USING ERRCODE = 'no_data_found';
  END IF;

  v_expected := CASE p_movement WHEN 'OUT' THEN 'approved' ELSE 'active' END;
  IF v_pass.status <> v_expected THEN
    RETURN QUERY SELECT
      CASE p_movement WHEN 'OUT' THEN 'INVALID_MOVEMENT' ELSE 'INVALID_MOVEMENT' END,
      p_movement, v_pass.id, NULL::TIMESTAMPTZ,
      CASE p_movement
        WHEN 'OUT' THEN 'Only an approved gate pass can be recorded as an exit.'
        ELSE 'Only a pass with a recorded exit can be recorded as a return.'
      END;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.gate_movements
      (college_id, gate_pass_id, student_id, gate_id, credential_id, movement_type,
       recorded_by, security_personnel_id, recorded_role, is_override, override_reason)
    VALUES
      (v_college, v_pass.id, v_pass.student_id, p_gate_id, NULL, p_movement,
       v_actor, NULL, v_role, true, btrim(p_reason))
    RETURNING id, gate_movements.occurred_at INTO v_move_id, v_occurred;
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT 'DUPLICATE_SCAN'::TEXT, p_movement, v_pass.id, NULL::TIMESTAMPTZ,
      'This movement has already been recorded for this gate pass.';
    RETURN;
  END;

  UPDATE public.gate_passes
     SET status        = CASE WHEN p_movement = 'OUT' THEN 'active' ELSE 'returned' END,
         actual_exit   = CASE WHEN p_movement = 'OUT' THEN now() ELSE actual_exit END,
         actual_return = CASE WHEN p_movement = 'IN'  THEN now() ELSE actual_return END
   WHERE id = v_pass.id AND status = v_expected;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'gate security: the gate pass changed while the movement was being recorded'
      USING ERRCODE = 'serialization_failure';
  END IF;

  PERFORM public.log_gate_security_event(v_college, v_actor, 'gate_movement_override_' || lower(p_movement),
    v_move_id::TEXT,
    jsonb_build_object(
      'movement_id', v_move_id, 'movement_type', p_movement, 'gate_pass_id', v_pass.id,
      'student_id', v_pass.student_id, 'gate_id', p_gate_id, 'reason', btrim(p_reason),
      'actor_role', v_role, 'occurred_at', v_occurred
    ));

  RETURN QUERY SELECT 'RECORDED'::TEXT, p_movement, v_pass.id, v_occurred,
    CASE WHEN p_movement = 'OUT' THEN 'Exit recorded manually.' ELSE 'Return recorded manually.' END;
END;
$$;

REVOKE ALL ON FUNCTION public.record_manual_gate_movement(UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_manual_gate_movement(UUID, TEXT, UUID, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------
-- 14. Read projections
--
-- A guard has NO policy on gate_passes, students or profiles, deliberately
-- (§33): the scanner needs a name and an enrollment number, not a student
-- record. These three functions are the entire read surface, and each one
-- returns a fixed projection rather than a row.
-- ---------------------------------------------------------------

-- The student's own credential, for rendering their QR. Returns the nonce,
-- which is the one place in the system it leaves the database — to the
-- SERVER, which signs it with a key the browser never sees.
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
  ORDER BY c.version DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.my_gate_pass_credential(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_gate_pass_credential(UUID) TO authenticated, service_role;

-- Recent scans at a gate the caller operates.
CREATE OR REPLACE FUNCTION public.security_scan_feed(p_gate_id UUID, p_limit INTEGER DEFAULT 20)
RETURNS TABLE (
  movement_id UUID,
  movement_type TEXT,
  occurred_at TIMESTAMPTZ,
  student_name TEXT,
  enrollment_number TEXT,
  pass_code TEXT,
  destination TEXT,
  gate_name TEXT,
  is_override BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT m.id, m.movement_type, m.occurred_at, pr.full_name, s.enrollment_number,
         'GP-' || upper(substr(replace(gp.id::TEXT, '-', ''), 1, 8)),
         gp.destination, g.name, m.is_override
  FROM public.gate_movements m
  JOIN public.gate_passes gp ON gp.id = m.gate_pass_id
  JOIN public.students s ON s.id = m.student_id
  JOIN public.profiles pr ON pr.id = s.user_id
  LEFT JOIN public.gates g ON g.id = m.gate_id
  WHERE m.gate_id = p_gate_id
    AND public.security_operates_gate(p_gate_id)
    AND public.security_has_permission('gate_security.movement.view')
  ORDER BY m.occurred_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
$$;

REVOKE ALL ON FUNCTION public.security_scan_feed(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.security_scan_feed(UUID, INTEGER) TO authenticated, service_role;

-- Who is outside right now, for the caller's college. A student can leave
-- by one gate and come back through another, so this is college-scoped
-- rather than gate-scoped — it is the question a guard actually has to
-- answer at a gate they were not standing at when the student left.
CREATE OR REPLACE FUNCTION public.security_outside_now()
RETURNS TABLE (
  gate_pass_id UUID,
  pass_code TEXT,
  student_name TEXT,
  enrollment_number TEXT,
  destination TEXT,
  exited_at TIMESTAMPTZ,
  due_back TIMESTAMPTZ,
  overdue BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT gp.id,
         'GP-' || upper(substr(replace(gp.id::TEXT, '-', ''), 1, 8)),
         pr.full_name, s.enrollment_number, gp.destination,
         gp.actual_exit, gp.return_time, now() > gp.return_time
  FROM public.gate_passes gp
  JOIN public.students s ON s.id = gp.student_id
  JOIN public.profiles pr ON pr.id = s.user_id
  WHERE gp.status = 'active'
    AND gp.college_id = (
      SELECT sp.college_id FROM public.security_personnel sp
      WHERE sp.id = public.my_security_personnel_id()
    )
    AND public.security_has_permission('gate_security.movement.view')
  ORDER BY gp.actual_exit DESC NULLS LAST
  LIMIT 200;
$$;

REVOKE ALL ON FUNCTION public.security_outside_now() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.security_outside_now() TO authenticated, service_role;

-- ---------------------------------------------------------------
-- 15. Revocation and expiry
-- ---------------------------------------------------------------

-- A warden or administrator can pull a credential back without touching
-- the pass — the decision to let the student out stands, the QR simply
-- stops opening gates. Used for a lost phone or a shared screenshot.
CREATE OR REPLACE FUNCTION public.revoke_gate_pass_credential(p_gate_pass_id UUID, p_reason TEXT)
RETURNS TABLE (revoked INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_actor   UUID := auth.uid();
  v_role    TEXT;
  v_college UUID;
  v_student UUID;
  v_count   INTEGER;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'gate security: not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'gate security: a revocation must record a reason' USING ERRCODE = 'check_violation';
  END IF;

  SELECT p.role, p.college_id INTO v_role, v_college
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  IF v_role IS NULL OR v_role NOT IN ('warden', 'admin', 'director') THEN
    RAISE EXCEPTION 'gate security: only a warden, administrator or director may revoke a credential'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT gp.student_id INTO v_student FROM public.gate_passes gp
  WHERE gp.id = p_gate_pass_id AND gp.college_id = v_college;
  IF v_student IS NULL THEN
    RAISE EXCEPTION 'gate security: gate pass not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_role = 'warden' AND NOT public.wardens_student(v_student) THEN
    RAISE EXCEPTION 'gate security: this student is not in your hostel block'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.gate_pass_credentials
     SET status = 'REVOKED', revoked_by = v_actor, revoked_at = now(), revocation_reason = btrim(p_reason)
   WHERE gate_pass_id = p_gate_pass_id AND status = 'ACTIVE';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 0 THEN
    PERFORM public.log_gate_security_event(v_college, v_actor, 'gate_credential_revoked', p_gate_pass_id::TEXT,
      jsonb_build_object('reason', btrim(p_reason), 'actor_role', v_role, 'credentials', v_count));
  END IF;

  RETURN QUERY SELECT v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_gate_pass_credential(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_gate_pass_credential(UUID, TEXT) TO authenticated, service_role;

-- Housekeeping, for the scheduled worker only. Expires credentials past
-- their window and the approved passes behind them (047 permits
-- approved -> expired and nothing else; a pass whose student is still
-- OUTSIDE is deliberately left alone — they have not come back, and
-- relabelling that as "expired" would erase the one fact that matters).
CREATE OR REPLACE FUNCTION public.expire_stale_gate_credentials()
RETURNS TABLE (credentials_expired INTEGER, passes_expired INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_creds  INTEGER;
  v_passes INTEGER;
BEGIN
  UPDATE public.gate_pass_credentials
     SET status = 'EXPIRED'
   WHERE status = 'ACTIVE' AND expires_at < now();
  GET DIAGNOSTICS v_creds = ROW_COUNT;

  UPDATE public.gate_passes gp
     SET status = 'expired'
   WHERE gp.status = 'approved'
     AND gp.return_time < now() - INTERVAL '12 hours';
  GET DIAGNOSTICS v_passes = ROW_COUNT;

  RETURN QUERY SELECT v_creds, v_passes;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_stale_gate_credentials() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_gate_credentials() TO service_role;

-- ---------------------------------------------------------------
-- 16. Row level security
--
-- Read the WRITE side of this section first, because it is mostly absent
-- and that is the design: `authenticated` holds no INSERT, UPDATE or
-- DELETE on gate_movements or gate_pass_credentials at all — not by policy
-- and not by table privilege. The functions in sections 12-15 are the only
-- writers, and they run as this migration's owner.
-- ---------------------------------------------------------------
ALTER TABLE public.gates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_personnel ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_gate_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gate_pass_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gate_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_instructions ENABLE ROW LEVEL SECURITY;

-- ── gates ───────────────────────────────────────────────────────
-- A gate list is operational, not sensitive; a guard needs to see the one
-- they are standing at. Creating and retiring gates is institution
-- configuration, so director and admin, matching academic_period_manage.
DROP POLICY IF EXISTS "gates_read" ON public.gates;
CREATE POLICY "gates_read" ON public.gates
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director', 'warden', 'gate_security')
  );

DROP POLICY IF EXISTS "gates_manage" ON public.gates;
CREATE POLICY "gates_manage" ON public.gates
  FOR ALL
  USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director')
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director')
  );

-- ── security_personnel ──────────────────────────────────────────
-- A guard reads their own row (status, gate, permissions) and no one
-- else's. Directors and admins manage the roster. Wardens are absent on
-- purpose: approving a pass and authorising the person who checks it at
-- the gate are different jobs, and this is the separation §6 asks for.
DROP POLICY IF EXISTS "security_personnel_read_self" ON public.security_personnel;
CREATE POLICY "security_personnel_read_self" ON public.security_personnel
  FOR SELECT USING (profile_id = auth.uid());

DROP POLICY IF EXISTS "security_personnel_read_staff" ON public.security_personnel;
CREATE POLICY "security_personnel_read_staff" ON public.security_personnel
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director')
  );

DROP POLICY IF EXISTS "security_personnel_manage" ON public.security_personnel;
CREATE POLICY "security_personnel_manage" ON public.security_personnel
  FOR ALL
  USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director')
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director')
  );

-- ── security_gate_assignments ───────────────────────────────────
DROP POLICY IF EXISTS "sga_read_self" ON public.security_gate_assignments;
CREATE POLICY "sga_read_self" ON public.security_gate_assignments
  FOR SELECT USING (security_personnel_id = public.my_security_personnel_id());

DROP POLICY IF EXISTS "sga_read_staff" ON public.security_gate_assignments;
CREATE POLICY "sga_read_staff" ON public.security_gate_assignments
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director')
  );

DROP POLICY IF EXISTS "sga_manage" ON public.security_gate_assignments;
CREATE POLICY "sga_manage" ON public.security_gate_assignments
  FOR ALL
  USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director')
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director')
  );

-- ── gate_pass_credentials ───────────────────────────────────────
-- SELECT only, for the two roles that supervise the credential's life.
-- The student does NOT get a policy here: their QR comes from
-- my_gate_pass_credential(), which hands the nonce to the server and
-- never to the browser. The guard does not get one either — a scanner
-- that can enumerate credentials is a scanner that can be used to find
-- one. The `nonce` column is unreadable by `authenticated` regardless
-- (section 17).
DROP POLICY IF EXISTS "gate_pass_credentials_read_staff" ON public.gate_pass_credentials;
CREATE POLICY "gate_pass_credentials_read_staff" ON public.gate_pass_credentials
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND (
      public.get_my_role() IN ('admin', 'director')
      OR (public.get_my_role() = 'warden' AND public.wardens_student(student_id))
    )
  );

-- ── gate_movements ──────────────────────────────────────────────
-- Read only, for everyone. The ledger is written by the recorder
-- functions and by nothing else.
DROP POLICY IF EXISTS "gate_movements_read_staff" ON public.gate_movements;
CREATE POLICY "gate_movements_read_staff" ON public.gate_movements
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND (
      public.get_my_role() IN ('admin', 'director')
      OR (public.get_my_role() = 'warden' AND public.wardens_student(student_id))
    )
  );

-- A guard sees the movements they recorded and the movements at the gates
-- they operate — enough for the day's counts and the recent-scan list,
-- and nothing about a gate they are not standing at.
DROP POLICY IF EXISTS "gate_movements_read_security" ON public.gate_movements;
CREATE POLICY "gate_movements_read_security" ON public.gate_movements
  FOR SELECT USING (
    public.security_has_permission('gate_security.movement.view')
    AND (
      recorded_by = auth.uid()
      OR public.security_operates_gate(gate_id)
    )
  );

-- A student sees their own movement history, and only their own.
DROP POLICY IF EXISTS "gate_movements_read_own" ON public.gate_movements;
CREATE POLICY "gate_movements_read_own" ON public.gate_movements
  FOR SELECT USING (
    student_id IN (SELECT s.id FROM public.students s WHERE s.user_id = auth.uid())
  );

-- ── security_instructions ───────────────────────────────────────
DROP POLICY IF EXISTS "security_instructions_manage" ON public.security_instructions;
CREATE POLICY "security_instructions_manage" ON public.security_instructions
  FOR ALL
  USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director')
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director')
    AND created_by = auth.uid()
  );

DROP POLICY IF EXISTS "security_instructions_read_security" ON public.security_instructions;
CREATE POLICY "security_instructions_read_security" ON public.security_instructions
  FOR SELECT USING (
    public.security_has_permission('gate_security.instructions.view')
    AND status = 'active'
    AND (
      audience = 'all'
      OR (audience = 'person' AND security_personnel_id = public.my_security_personnel_id())
      OR (audience = 'gate' AND public.security_operates_gate(gate_id))
    )
  );

-- ── audit_logs: the security record, read by the people who need it ──
--
-- Reusing audit_logs (005) rather than adding a security_audit_events table
-- means the read side needs widening, because its policies are narrow by
-- design: admin reads everything (006), and 035 gave the director exactly
-- two table_names. Both additions below are SELECT-only and both are
-- scoped to the rows this module writes.
DROP POLICY IF EXISTS "audit_logs_director_security_read" ON public.audit_logs;
CREATE POLICY "audit_logs_director_security_read" ON public.audit_logs
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'director'
    AND table_name IN ('gate_movements', 'gate_pass_credentials', 'security_personnel')
  );

-- A guard reads back their OWN scans and nobody else's — enough to answer
-- "did that go through", never enough to review a colleague's shift.
DROP POLICY IF EXISTS "audit_logs_security_own_read" ON public.audit_logs;
CREATE POLICY "audit_logs_security_own_read" ON public.audit_logs
  FOR SELECT USING (
    user_id = auth.uid()
    AND table_name = 'gate_movements'
    AND public.security_has_permission('gate_security.audit.view')
  );

-- ---------------------------------------------------------------
-- 16b. gate_passes: the decision and the movement are different authorities
--
-- 047 §7g left one policy, FOR ALL, covering admin and (block-scoped)
-- warden. Under it a warden could reach PostgREST and write
--
--   status = 'active', actual_exit = '2026-01-01T03:00:00Z'
--
-- on a pass they had themselves just approved: a movement with no gate, no
-- guard, no credential, no ledger row, and a time of their choosing. The
-- 047 trigger accepted it because the SHAPE was legal.
--
-- Split into what each role actually needs:
--
--   SELECT   admin, block-scoped warden          (unchanged reach)
--   UPDATE   pending -> approved | rejected      (the decision, §16)
--   DELETE   admin/warden, pending only          (047's trigger still)
--   INSERT   nobody — a pass is a student's request (§14), and no staff
--            screen has ever created one
--
-- approved -> active and active -> returned are now granted to NO role.
-- They exist only inside record_gate_movement() and
-- record_manual_gate_movement(), which is what makes the ledger complete
-- by construction rather than by discipline.
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "gate_passes_staff" ON public.gate_passes;

DROP POLICY IF EXISTS "gate_passes_staff_read" ON public.gate_passes;
CREATE POLICY "gate_passes_staff_read" ON public.gate_passes
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND (
      public.get_my_role() = 'admin'
      OR (public.get_my_role() = 'warden' AND public.wardens_student(student_id))
    )
  );

DROP POLICY IF EXISTS "gate_passes_staff_decide" ON public.gate_passes;
CREATE POLICY "gate_passes_staff_decide" ON public.gate_passes
  FOR UPDATE
  USING (
    college_id = public.get_my_college_id()
    AND status = 'pending'
    AND (
      public.get_my_role() = 'admin'
      OR (public.get_my_role() = 'warden' AND public.wardens_student(student_id))
    )
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    -- 'pending' belongs here as well as the two decisions: 047's trigger
    -- deliberately lets a warden correct the request (a mistyped
    -- destination, a wrong return time) while it is still pending, and a
    -- WITH CHECK listing only the outcomes would have silently taken that
    -- away. What it excludes is what it is here to exclude: 'active',
    -- 'returned' and 'expired' — the movement states.
    AND status IN ('pending', 'approved', 'rejected')
    AND (
      public.get_my_role() = 'admin'
      OR (public.get_my_role() = 'warden' AND public.wardens_student(student_id))
    )
  );

DROP POLICY IF EXISTS "gate_passes_staff_delete" ON public.gate_passes;
CREATE POLICY "gate_passes_staff_delete" ON public.gate_passes
  FOR DELETE USING (
    college_id = public.get_my_college_id()
    AND (
      public.get_my_role() = 'admin'
      OR (public.get_my_role() = 'warden' AND public.wardens_student(student_id))
    )
  );

-- ---------------------------------------------------------------
-- 17. Table privileges, and the composite FKs deferred from 4b
--
-- RLS decides which ROWS a policy admits. These decide which STATEMENTS
-- and which COLUMNS are available at all — a second, independent layer, so
-- a future policy written too widely still cannot reach the nonce or write
-- the ledger.
-- ---------------------------------------------------------------
REVOKE ALL ON TABLE public.gates FROM anon;
REVOKE ALL ON TABLE public.security_personnel FROM anon;
REVOKE ALL ON TABLE public.security_gate_assignments FROM anon;
REVOKE ALL ON TABLE public.security_instructions FROM anon;
REVOKE ALL ON TABLE public.gate_pass_credentials FROM anon, authenticated;
REVOKE ALL ON TABLE public.gate_movements FROM anon, authenticated;

-- The ledger is readable and nothing else, for every signed-in role.
GRANT SELECT ON TABLE public.gate_movements TO authenticated;

-- Credentials: SELECT on the metadata only. `nonce` is deliberately absent
-- from this list, so no role reachable over PostgREST can read it whatever
-- the policies say.
GRANT SELECT (
  id, college_id, gate_pass_id, student_id, version, status,
  valid_from, expires_at, issued_at, revoked_by, revoked_at, revocation_reason
) ON TABLE public.gate_pass_credentials TO authenticated;

-- Deferred from 4b so the parent key could be (re)created first. Three
-- columns: the tenant AND the subject, so neither table can record a
-- movement or issue a credential against a student the pass is not for.
ALTER TABLE public.gate_pass_credentials DROP CONSTRAINT IF EXISTS gpc_pass_tenant_fkey;
ALTER TABLE public.gate_pass_credentials
  ADD CONSTRAINT gpc_pass_tenant_fkey FOREIGN KEY (gate_pass_id, college_id, student_id)
  REFERENCES public.gate_passes(id, college_id, student_id) ON DELETE CASCADE;

ALTER TABLE public.gate_movements DROP CONSTRAINT IF EXISTS gm_pass_tenant_fkey;
ALTER TABLE public.gate_movements
  ADD CONSTRAINT gm_pass_tenant_fkey FOREIGN KEY (gate_pass_id, college_id, student_id)
  REFERENCES public.gate_passes(id, college_id, student_id) ON DELETE CASCADE;

-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- DROP POLICY IF EXISTS "gate_passes_staff_delete" ON public.gate_passes;
-- DROP POLICY IF EXISTS "gate_passes_staff_decide" ON public.gate_passes;
-- DROP POLICY IF EXISTS "gate_passes_staff_read" ON public.gate_passes;
-- CREATE POLICY "gate_passes_staff" ON public.gate_passes FOR ALL
--   USING (college_id = public.get_my_college_id() AND (public.get_my_role() = 'admin'
--     OR (public.get_my_role() = 'warden' AND public.wardens_student(student_id))))
--   WITH CHECK (college_id = public.get_my_college_id() AND (public.get_my_role() = 'admin'
--     OR (public.get_my_role() = 'warden' AND public.wardens_student(student_id))));
-- DROP FUNCTION IF EXISTS public.expire_stale_gate_credentials();
-- DROP FUNCTION IF EXISTS public.revoke_gate_pass_credential(UUID, TEXT);
-- DROP FUNCTION IF EXISTS public.security_outside_now();
-- DROP FUNCTION IF EXISTS public.security_scan_feed(UUID, INTEGER);
-- DROP FUNCTION IF EXISTS public.my_gate_pass_credential(UUID);
-- DROP FUNCTION IF EXISTS public.record_manual_gate_movement(UUID, TEXT, UUID, TEXT);
-- DROP FUNCTION IF EXISTS public.record_gate_movement(UUID, UUID, JSONB);
-- DROP FUNCTION IF EXISTS public.log_gate_security_event(UUID, UUID, TEXT, TEXT, JSONB);
-- DROP TRIGGER IF EXISTS issue_gate_pass_credential ON public.gate_passes;
-- DROP FUNCTION IF EXISTS public.issue_gate_pass_credential();
-- DROP TABLE IF EXISTS public.security_instructions;
-- DROP TABLE IF EXISTS public.gate_movements;
-- DROP TABLE IF EXISTS public.gate_pass_credentials;
-- DROP TABLE IF EXISTS public.security_gate_assignments;
-- DROP TABLE IF EXISTS public.security_personnel;
-- DROP TABLE IF EXISTS public.gates;
-- DROP FUNCTION IF EXISTS public.security_operates_gate(UUID);
-- DROP FUNCTION IF EXISTS public.security_has_permission(TEXT);
-- DROP FUNCTION IF EXISTS public.my_security_personnel_id();
-- ALTER TABLE public.gate_passes DROP CONSTRAINT IF EXISTS gate_passes_subject_key;
