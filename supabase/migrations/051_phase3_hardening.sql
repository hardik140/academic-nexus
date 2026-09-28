-- ============================================================
-- Migration 051: Phase 3 hardening — close the Phase-2 findings at the
--                database layer, where a direct PostgREST/API call cannot
--                escape them.
--
-- CONVENTIONS REUSED FROM THIS REPO (not invented here):
--   * Behavioural guards exempt the service-role / seed path with
--     `IF auth.uid() IS NULL THEN RETURN ...` — the same exemption migration
--     042's enforce_profile_privileged_columns() uses, so bootstrap,
--     lib/invitations.ts's service-role writes, and the QA/seed fixtures
--     (which insert historical closed-semester rows on purpose) keep working.
--     Every real application call carries an auth.uid(), so every real call
--     is guarded.
--   * SECURITY DEFINER helpers pin search_path, as 047 established.
--
-- Findings addressed: P1-1, P1-2, P2-3, P2-4, P2-5, P2-6, P3-7, P3-8, P3-9.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- P2-4 — active-membership gate on tenant resolution.
--
-- get_my_college_id()/get_my_role() previously resolved for ANY profile row,
-- so a self-registered 'pending' account (which middleware bounces, but a
-- direct API call does not) still resolved a college and read every
-- college-wide policy. Gating both helpers on status='active' makes a pending
-- or suspended account resolve to NULL — i.e. no tenant — everywhere at once,
-- without touching a single policy. The accept-invite flow does not depend on
-- these helpers (profiles_update_self is id=auth.uid(); the invitee reads its
-- row via user_id=auth.uid()), so onboarding is unaffected.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_college_id()
RETURNS UUID AS $$
  SELECT college_id FROM public.profiles
  WHERE id = auth.uid() AND status = 'active';
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT AS $$
  SELECT role FROM public.profiles
  WHERE id = auth.uid() AND status = 'active';
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- NOTE on the signup path: handle_new_user() (043) still records the
-- metadata college_id, but that is now inert. A self-registered account is
-- role='student', status='pending', and the active-gate above makes
-- get_my_college_id()/get_my_role() return NULL for it, so it resolves to no
-- tenant and reads nothing until an admin activates it or the service-role
-- invitation path takes over. Rewriting handle_new_user to drop the metadata
-- college_id was reverted: the seed/onboarding flow depends on it to place a
-- user in their college, and it grants nothing while the account is pending.

-- ────────────────────────────────────────────────────────────
-- P1-1 — cross-tenant security instructions.
-- The read policy checked the guard's permission and audience but not the
-- instruction's college. Any active guard read any college's audience='all'
-- rows. Add the tenant predicate.
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "security_instructions_read_security" ON public.security_instructions;
CREATE POLICY "security_instructions_read_security" ON public.security_instructions
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.security_has_permission('gate_security.instructions.view')
    AND status = 'active'
    AND (
      audience = 'all'
      OR (audience = 'person' AND security_personnel_id = public.my_security_personnel_id())
      OR (audience = 'gate' AND public.security_operates_gate(gate_id))
    )
  );

-- ────────────────────────────────────────────────────────────
-- P3-7 — the permissions catalog was world-readable (USING (true)),
-- including anon. It is reference data, but nothing here is public. Restrict
-- to authenticated sessions; role_permissions gets the same treatment.
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "permissions_read" ON public.permissions;
CREATE POLICY "permissions_read" ON public.permissions
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- ────────────────────────────────────────────────────────────
-- P2-6 — invariants that lived only in application code become CHECK /
-- partial-unique constraints. NOT VALID first, then VALIDATE, so a populated
-- database is not rejected outright: existing violations are reported by
-- VALIDATE rather than silently accepted, and the constraint still guards
-- every future write immediately. (On this repo's empty transactional tables
-- the VALIDATE is a no-op.)
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.marks
  DROP CONSTRAINT IF EXISTS marks_obtained_range;
ALTER TABLE public.marks
  ADD CONSTRAINT marks_obtained_range
  CHECK (max_marks > 0 AND obtained_marks >= 0 AND obtained_marks <= max_marks) NOT VALID;
ALTER TABLE public.marks VALIDATE CONSTRAINT marks_obtained_range;

ALTER TABLE public.fees
  DROP CONSTRAINT IF EXISTS fees_amount_paid_sane;
ALTER TABLE public.fees
  ADD CONSTRAINT fees_amount_paid_sane
  CHECK (amount >= 0 AND paid_amount >= 0 AND paid_amount <= amount) NOT VALID;
ALTER TABLE public.fees VALIDATE CONSTRAINT fees_amount_paid_sane;

ALTER TABLE public.gate_passes
  DROP CONSTRAINT IF EXISTS gate_passes_window_sane;
ALTER TABLE public.gate_passes
  ADD CONSTRAINT gate_passes_window_sane
  CHECK (return_time > exit_time) NOT VALID;
ALTER TABLE public.gate_passes VALIDATE CONSTRAINT gate_passes_window_sane;

ALTER TABLE public.semesters
  DROP CONSTRAINT IF EXISTS semesters_dates_sane;
ALTER TABLE public.semesters
  ADD CONSTRAINT semesters_dates_sane
  CHECK (start_date IS NULL OR end_date IS NULL OR end_date > start_date) NOT VALID;
ALTER TABLE public.semesters VALIDATE CONSTRAINT semesters_dates_sane;

ALTER TABLE public.academic_years
  DROP CONSTRAINT IF EXISTS academic_years_dates_sane;
ALTER TABLE public.academic_years
  ADD CONSTRAINT academic_years_dates_sane
  CHECK (start_date IS NULL OR end_date IS NULL OR end_date > start_date) NOT VALID;
ALTER TABLE public.academic_years VALIDATE CONSTRAINT academic_years_dates_sane;

ALTER TABLE public.hostel_rooms
  DROP CONSTRAINT IF EXISTS hostel_rooms_occupancy_sane;
ALTER TABLE public.hostel_rooms
  ADD CONSTRAINT hostel_rooms_occupancy_sane
  CHECK (occupancy >= 0 AND occupancy <= capacity) NOT VALID;
ALTER TABLE public.hostel_rooms VALIDATE CONSTRAINT hostel_rooms_occupancy_sane;

-- One active allocation per student.
DROP INDEX IF EXISTS public.idx_hostel_alloc_one_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_alloc_one_active
  ON public.hostel_allocations(student_id) WHERE status = 'active';

-- ────────────────────────────────────────────────────────────
-- P2-5 — a row's college_id must match the college of the student (and room)
-- it points at.
--
-- Enforced with a trigger rather than a composite FK on students(id,
-- college_id): migration 047 drops and recreates students_tenant_key on every
-- run (its idempotency reclaim), and a dependent FK would make that DROP fail
-- on a re-applied chain. The trigger carries no pg_depend on that key, so
-- re-runnability is preserved. Same auth.uid()-null exemption as the rest of
-- this migration, so seed/service writes are unaffected.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_row_student_tenant()
RETURNS TRIGGER AS $$
DECLARE v_student_college UUID;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  SELECT college_id INTO v_student_college FROM public.students WHERE id = NEW.student_id;
  IF v_student_college IS DISTINCT FROM NEW.college_id THEN
    RAISE EXCEPTION '%: student % is not in college %', TG_TABLE_NAME, NEW.student_id, NEW.college_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS guard_row_student_tenant ON public.fees;
CREATE TRIGGER guard_row_student_tenant BEFORE INSERT OR UPDATE ON public.fees
  FOR EACH ROW EXECUTE FUNCTION public.guard_row_student_tenant();

CREATE OR REPLACE FUNCTION public.guard_allocation_tenant()
RETURNS TRIGGER AS $$
DECLARE v_student_college UUID; v_room_college UUID;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  SELECT college_id INTO v_student_college FROM public.students WHERE id = NEW.student_id;
  SELECT college_id INTO v_room_college FROM public.hostel_rooms WHERE id = NEW.room_id;
  IF v_student_college IS DISTINCT FROM NEW.college_id OR v_room_college IS DISTINCT FROM NEW.college_id THEN
    RAISE EXCEPTION 'hostel_allocations: student/room must belong to college %', NEW.college_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS guard_allocation_tenant ON public.hostel_allocations;
CREATE TRIGGER guard_allocation_tenant BEFORE INSERT OR UPDATE ON public.hostel_allocations
  FOR EACH ROW EXECUTE FUNCTION public.guard_allocation_tenant();

-- Invitations: the insert policy only checked invited_by = auth.uid(), so an
-- admin could file an invitation into another college. Bind it to the actor's
-- own active college and to the invite tier (mirrors lib/auth/invite-tiers.ts).
CREATE OR REPLACE FUNCTION public.can_invite_role(p_target TEXT)
RETURNS BOOLEAN AS $$
  SELECT CASE public.get_my_role()
    WHEN 'super_admin' THEN p_target = 'admin'
    WHEN 'admin'       THEN p_target = 'director'
    WHEN 'director'    THEN p_target IN ('finance','hod','warden','placement_cell','gate_security')
    WHEN 'hod'         THEN p_target IN ('teacher','student')
    ELSE false
  END;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

DROP POLICY IF EXISTS "invitations_insert_own" ON public.invitations;
CREATE POLICY "invitations_insert_own" ON public.invitations
  FOR INSERT WITH CHECK (
    invited_by = auth.uid()
    AND college_id = public.get_my_college_id()
    AND public.can_invite_role(role)
  );

-- ────────────────────────────────────────────────────────────
-- P1-2 — accounting-safe finance.
--
-- 1. A cleared payment is immutable and cannot be deleted; the only allowed
--    change is the controlled status transition cleared -> refunded, which the
--    ledger trigger reconciles. update_fee_on_payment (047) already blocks
--    fee/student/amount edits; this adds DELETE and the status rule.
-- 2. fees->payments stops cascading on delete: deleting a fee that has
--    payments is refused, so financial history cannot be erased by removing
--    the parent.
-- 3. fees.paid_amount / status may change only through the ledger trigger
--    (guarded by a transaction-local flag it sets), never by a hand UPDATE.
-- ────────────────────────────────────────────────────────────

-- (2) Re-point the FK as RESTRICT.
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_fee_context_fkey;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_fee_context_fkey
  FOREIGN KEY (fee_id, college_id, student_id)
  REFERENCES public.fees(id, college_id, student_id) ON DELETE RESTRICT;

-- (3) Ledger trigger flags its own fee writes so the fee guard can tell an
--     accounting update from a hand edit.
CREATE OR REPLACE FUNCTION public.update_fee_on_payment()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'cleared' THEN
      RETURN NEW;
    END IF;
    UPDATE public.fees SET
      paid_amount = paid_amount + NEW.amount,
      paid_at = CASE WHEN (paid_amount + NEW.amount) >= amount THEN now() ELSE paid_at END,
      status = CASE
        WHEN (paid_amount + NEW.amount) >= amount THEN 'paid'
        WHEN (paid_amount + NEW.amount) > 0 THEN 'partial'
        ELSE status END
    WHERE id = NEW.fee_id AND paid_amount + NEW.amount <= amount;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Payment of % exceeds the outstanding balance on fee %', NEW.amount, NEW.fee_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.fee_id <> OLD.fee_id OR NEW.student_id <> OLD.student_id OR NEW.amount <> OLD.amount THEN
      RAISE EXCEPTION 'A payment''s fee, student and amount are immutable; record a refund instead'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Payment status is a one-way state machine:
    --   pending  -> cleared | failed
    --   cleared  -> refunded          (the ledger reversal itself is owned by
    --                                  approve_refund(); doing it here too
    --                                  would double-count)
    --   refunded, failed              terminal
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT (
           (OLD.status = 'pending' AND NEW.status IN ('cleared', 'failed'))
        OR (OLD.status = 'cleared' AND NEW.status = 'refunded')
      ) THEN
        RAISE EXCEPTION 'A payment''s status may not move from % to %', OLD.status, NEW.status
          USING ERRCODE = 'check_violation';
      END IF;
      -- A pending payment that clears is credited exactly as a cleared INSERT.
      IF OLD.status = 'pending' AND NEW.status = 'cleared' THEN
        UPDATE public.fees SET
          paid_amount = paid_amount + NEW.amount,
          paid_at = CASE WHEN (paid_amount + NEW.amount) >= amount THEN now() ELSE paid_at END,
          status = CASE
            WHEN (paid_amount + NEW.amount) >= amount THEN 'paid'
            WHEN (paid_amount + NEW.amount) > 0 THEN 'partial'
            ELSE status END
        WHERE id = NEW.fee_id AND paid_amount + NEW.amount <= amount;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Payment of % exceeds the outstanding balance on fee %', NEW.amount, NEW.fee_id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status = 'cleared' AND auth.uid() IS NOT NULL THEN
      RAISE EXCEPTION 'A cleared payment cannot be deleted; reverse it with a refund'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'cleared' THEN
      UPDATE public.fees SET
        paid_amount = GREATEST(paid_amount - OLD.amount, 0),
        status = CASE
          WHEN GREATEST(paid_amount - OLD.amount, 0) >= amount THEN 'paid'
          WHEN GREATEST(paid_amount - OLD.amount, 0) > 0 THEN 'partial'
          ELSE 'pending' END
      WHERE id = OLD.fee_id;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- (1)+(3) The fee guard: a hand UPDATE (auth.uid() present, ledger flag not
-- set) may not move paid_amount or status; the ledger trigger's own writes
-- carry the flag and pass.
CREATE OR REPLACE FUNCTION public.guard_fee_ledger_columns()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  -- Two sanctioned writers reach fees.paid_amount:
  --   * update_fee_on_payment() runs as a NESTED trigger (depth > 1);
  --   * approve_refund() runs at depth 0 and raises the flag below around its
  --     single fee UPDATE, then lowers it.
  -- A direct API UPDATE has neither, so it is guarded. A PostgREST caller
  -- cannot issue SET/set_config, so the flag is not reachable from the app.
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('app.fee_ledger_op', true), '') = '1' THEN RETURN NEW; END IF;
  IF NEW.paid_amount IS DISTINCT FROM OLD.paid_amount THEN
    RAISE EXCEPTION 'fees.paid_amount is derived from the payment ledger and cannot be set directly'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND OLD.status = 'paid' AND NEW.status IN ('pending','partial') THEN
    RAISE EXCEPTION 'a paid fee cannot be regressed; reverse the payment instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS guard_fee_ledger_columns ON public.fees;
CREATE TRIGGER guard_fee_ledger_columns
  BEFORE UPDATE ON public.fees
  FOR EACH ROW EXECUTE FUNCTION public.guard_fee_ledger_columns();

-- Deleting a fee that still has payments is refused by the RESTRICT FK; this
-- gives the attempt a legible message instead of a raw FK error, and blocks
-- it for app callers even before the FK is consulted.
CREATE OR REPLACE FUNCTION public.guard_fee_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.payments p WHERE p.fee_id = OLD.id) THEN
    RAISE EXCEPTION 'a fee with recorded payments cannot be deleted; its ledger is permanent'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS guard_fee_delete ON public.fees;
CREATE TRIGGER guard_fee_delete
  BEFORE DELETE ON public.fees
  FOR EACH ROW EXECUTE FUNCTION public.guard_fee_delete();

-- ────────────────────────────────────────────────────────────
-- P2-3 — a closed semester is immutable for its academic children, not just
-- for its own row. One trigger function, attached to every table that hangs
-- off a semester. Service-role/seed writes (auth.uid() IS NULL) are exempt so
-- historical fixtures and back-office corrections still load; every app call
-- is guarded.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_closed_semester()
RETURNS TRIGGER AS $$
DECLARE
  v_offering UUID;
  v_semester UUID;
  v_status   TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- course_offerings is the master row, not an academic record. Scope to
  -- exactly the P2-3 concerns: no NEW offering in a closed semester, no
  -- reactivation/status change of one, no moving an offering into a closed
  -- semester, no deleting one. A metadata edit (e.g. reassigning the
  -- instructor of a historical offering) stays allowed — the marks/attendance
  -- those records would need are independently frozen below.
  IF TG_TABLE_NAME = 'course_offerings' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT status INTO v_status FROM public.semesters WHERE id = NEW.semester_id;
      IF v_status = 'closed' THEN
        RAISE EXCEPTION 'course_offerings: cannot create an offering in a closed semester'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT status INTO v_status FROM public.semesters WHERE id = OLD.semester_id;
      IF v_status = 'closed' THEN
        RAISE EXCEPTION 'course_offerings: cannot delete an offering in a closed semester'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE -- UPDATE
      IF NEW.semester_id IS DISTINCT FROM OLD.semester_id THEN
        SELECT status INTO v_status FROM public.semesters WHERE id = NEW.semester_id;
        IF v_status = 'closed' THEN
          RAISE EXCEPTION 'course_offerings: cannot move an offering into a closed semester'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      IF NEW.status IS DISTINCT FROM OLD.status THEN
        SELECT status INTO v_status FROM public.semesters WHERE id = OLD.semester_id;
        IF v_status = 'closed' THEN
          RAISE EXCEPTION 'course_offerings: cannot change the status of an offering in a closed semester'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- Academic child records (attendance/marks/enrollments/timetable): frozen
  -- entirely once their offering's semester is closed.
  v_offering := CASE WHEN TG_OP = 'DELETE' THEN OLD.offering_id ELSE NEW.offering_id END;
  SELECT semester_id INTO v_semester FROM public.course_offerings WHERE id = v_offering;
  SELECT status INTO v_status FROM public.semesters WHERE id = v_semester;
  IF v_status = 'closed' THEN
    RAISE EXCEPTION '%: the semester is closed; its academic records are read-only', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['attendance','marks','course_enrollments','timetable_slots','course_offerings']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS guard_closed_semester ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER guard_closed_semester BEFORE INSERT OR UPDATE OR DELETE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.guard_closed_semester()', t);
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────
-- P3-8 — enrolment binding for attendance & marks at the database. RLS
-- authorises the OFFERING; this binds each row's student to that offering, so
-- an authorised teacher cannot attach a record to a same-college student who
-- is not in the section. Service/seed exempt.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_enrolled_student()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.course_enrollments e
    WHERE e.offering_id = NEW.offering_id
      AND e.student_id = NEW.student_id
      AND e.status IN ('enrolled','completed','failed')
  ) THEN
    RAISE EXCEPTION '%: student % is not enrolled in offering %', TG_TABLE_NAME, NEW.student_id, NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS guard_enrolled_student ON public.attendance;
CREATE TRIGGER guard_enrolled_student
  BEFORE INSERT OR UPDATE ON public.attendance
  FOR EACH ROW EXECUTE FUNCTION public.guard_enrolled_student();
DROP TRIGGER IF EXISTS guard_enrolled_student ON public.marks;
CREATE TRIGGER guard_enrolled_student
  BEFORE INSERT OR UPDATE ON public.marks
  FOR EACH ROW EXECUTE FUNCTION public.guard_enrolled_student();

-- attendance date must fall within the offering's semester window.
CREATE OR REPLACE FUNCTION public.guard_attendance_date()
RETURNS TRIGGER AS $$
DECLARE s DATE; e DATE;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  SELECT sem.start_date, sem.end_date INTO s, e
  FROM public.course_offerings o JOIN public.semesters sem ON sem.id = o.semester_id
  WHERE o.id = NEW.offering_id;
  IF s IS NOT NULL AND e IS NOT NULL AND (NEW.date < s OR NEW.date > e) THEN
    RAISE EXCEPTION 'attendance: date % is outside the semester window % .. %', NEW.date, s, e
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS guard_attendance_date ON public.attendance;
CREATE TRIGGER guard_attendance_date
  BEFORE INSERT OR UPDATE ON public.attendance
  FOR EACH ROW EXECUTE FUNCTION public.guard_attendance_date();

-- ────────────────────────────────────────────────────────────
-- P3-9 — reconcile role editing with the invitation tier. A role GRANT via a
-- profile UPDATE must respect the same map as an invitation, so an admin can
-- no longer mint finance/hod/warden/etc. by editing (only invite/appoint a
-- director). The existing self / super_admin / college-move protections from
-- 042 are preserved verbatim; only the role-grant branch is tightened.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_profile_privileged_columns()
RETURNS TRIGGER AS $$
DECLARE
  actor_role text;
BEGIN
  IF NEW.role          IS NOT DISTINCT FROM OLD.role
 AND NEW.college_id    IS NOT DISTINCT FROM OLD.college_id
 AND NEW.status        IS NOT DISTINCT FROM OLD.status
 AND NEW.department_id IS NOT DISTINCT FROM OLD.department_id THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.college_id IS DISTINCT FROM OLD.college_id THEN
    RAISE EXCEPTION 'A profile cannot be moved between colleges through the API.'
      USING ERRCODE = '42501';
  END IF;

  actor_role := public.get_my_role();

  IF NEW.id = auth.uid() THEN
    IF OLD.status = 'pending'
   AND NEW.status = 'active'
   AND NEW.role          IS NOT DISTINCT FROM OLD.role
   AND NEW.department_id IS NOT DISTINCT FROM OLD.department_id THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'You cannot change your own role, status or department.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role OR NEW.status IS DISTINCT FROM OLD.status THEN
    IF actor_role NOT IN ('admin', 'super_admin', 'director') THEN
      RAISE EXCEPTION 'Your role cannot change another user''s role or status.'
        USING ERRCODE = '42501';
    END IF;

    -- Preserved from 042: a super_admin row — its role OR its status — is
    -- only ever changed by a super_admin. (An earlier draft of this migration
    -- narrowed this to role grants only, which let a college admin suspend the
    -- super_admin; restored and regression-tested.)
    IF (OLD.role = 'super_admin' OR NEW.role = 'super_admin') AND actor_role <> 'super_admin' THEN
      RAISE EXCEPTION 'Only a super_admin may grant the super_admin role.'
        USING ERRCODE = '42501';
    END IF;

    -- Role GRANT must obey the invitation tier (P3-9). Demotion/removal to the
    -- baseline 'student' stays available to admin/super_admin for offboarding.
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      IF NEW.role = 'super_admin' AND actor_role <> 'super_admin' THEN
        RAISE EXCEPTION 'Only a super_admin may grant the super_admin role.'
          USING ERRCODE = '42501';
      END IF;
      IF NOT (
        public.can_invite_role(NEW.role)
        OR (NEW.role = 'student' AND actor_role IN ('admin','super_admin','director','hod'))
      ) THEN
        RAISE EXCEPTION 'Role % is outside your grant authority (see the invitation tier).', NEW.role
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

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

-- ────────────────────────────────────────────────────────────
-- P1-2 (cont.) — approve_refund() is a sanctioned ledger writer that updates
-- fees.paid_amount directly at trigger-depth 0. Redefined here identically to
-- 047, with one addition: it raises app.fee_ledger_op around its fee UPDATE so
-- guard_fee_ledger_columns() lets that one write through while still refusing a
-- hand UPDATE. Nothing else about the function changes.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_refund(p_request_id UUID)
RETURNS TABLE (
  fee_id UUID, payment_id UUID, refund_amount NUMERIC,
  fee_paid_before NUMERIC, fee_paid_after NUMERIC,
  fee_status_before TEXT, fee_status_after TEXT,
  payment_fully_refunded BOOLEAN, student_id UUID
)
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_req       public.refund_requests%ROWTYPE;
  v_pay       public.payments%ROWTYPE;
  v_fee       public.fees%ROWTYPE;
  v_refunded  NUMERIC;
  v_new_paid  NUMERIC;
  v_new_state TEXT;
BEGIN
  SELECT * INTO v_req FROM public.refund_requests r WHERE r.id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund request not found.' USING ERRCODE = 'no_data_found'; END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Refund request already %.', v_req.status USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_pay FROM public.payments p WHERE p.id = v_req.payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original payment not found.' USING ERRCODE = 'no_data_found'; END IF;

  SELECT COALESCE(SUM(r.amount), 0) INTO v_refunded
    FROM public.refund_requests r WHERE r.payment_id = v_pay.id AND r.status = 'approved';
  IF v_req.amount > v_pay.amount - v_refunded THEN
    RAISE EXCEPTION 'This refund (%) exceeds the refundable balance of %.',
      v_req.amount, v_pay.amount - v_refunded USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_fee FROM public.fees f WHERE f.id = v_pay.fee_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original fee not found.' USING ERRCODE = 'no_data_found'; END IF;

  v_new_paid  := GREATEST(v_fee.paid_amount - v_req.amount, 0);
  v_new_state := CASE
    WHEN v_new_paid <= 0 THEN 'refunded'
    WHEN v_new_paid < v_fee.amount THEN 'partial'
    ELSE v_fee.status
  END;

  PERFORM set_config('app.fee_ledger_op', '1', true);
  UPDATE public.fees f SET paid_amount = v_new_paid, status = v_new_state WHERE f.id = v_fee.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fee could not be updated.' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM set_config('app.fee_ledger_op', '0', true);

  payment_fully_refunded := (v_refunded + v_req.amount) >= v_pay.amount;
  IF payment_fully_refunded THEN
    UPDATE public.payments p SET status = 'refunded' WHERE p.id = v_pay.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Payment could not be updated.' USING ERRCODE = 'insufficient_privilege'; END IF;
  END IF;

  UPDATE public.refund_requests r
     SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
   WHERE r.id = v_req.id AND r.status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund request could not be updated.' USING ERRCODE = 'insufficient_privilege'; END IF;

  fee_id := v_fee.id; payment_id := v_pay.id; refund_amount := v_req.amount;
  fee_paid_before := v_fee.paid_amount; fee_paid_after := v_new_paid;
  fee_status_before := v_fee.status; fee_status_after := v_new_state;
  student_id := v_req.student_id;
  RETURN NEXT;
END;
$$;
