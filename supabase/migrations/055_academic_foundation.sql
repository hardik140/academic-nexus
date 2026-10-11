-- ════════════════════════════════════════════════════════════════════
-- 055 — ACADEMIC FOUNDATION (PR 1 of ACADEMIC_LIFECYCLE_CONTRACT.md)
--
-- Extends the academic model of 046/047/051/052 — it builds no parallel
-- one. Read the contract first; this header only maps sections to it.
--
--   §1  helpers (authority, notification)
--   §2  new tables (all history is effective-dated / append-only)
--   §3  history guards (one generic trigger)
--   §4  HOD history, instructor history (trigger-written)
--   §5  course_offerings: instructor eligibility (decision 4), closed-term
--       instructor lock (defect 5), auto-enrolment, teacher-clash check
--   §6  attendance/marks on a completed offering are frozen (defect 4)
--   §7  course_enrollments: staff writes narrowed to admin; one enrolled
--       row per course per term per student
--   §8  department academic configuration (decision 5): HOD programme
--       rights, structural guards, structural audit
--   §9  department operational term: readiness, start, end
--   §10 Class In-Charge
--   §11 external teaching authorizations
--   §12 student section assignments + reconciliation
--   §13 timetable authoring + conflicts + read narrowing (defect 2)
--   §14 student invitations: placements, preflight, acceptance (defect 1),
--       invitee update removed (defect 3), Class In-Charge invite tier
--   §15 my_academic_context()
--   §16 write gate: one more sanctioned channel (app.academic_service)
--   §17 gates on the new tables, grants
--   §18 backfill — derived only, nothing invented
--
-- Every new table is written ONLY by the SECURITY DEFINER functions below,
-- which re-derive authority from departments.hod_id, section_class_incharges
-- and the offering, through 053's my_operational_role() — a blocked college
-- or a refused session cannot act. No function trusts a client-supplied
-- department, HOD, In-Charge or teacher relationship.
--
-- Applies on top of 054. Additive except the two narrowings named in the
-- contract (course_enrollments staff writes, timetable reads for students)
-- and the removal of invitations_update_by_invitee. Rollback in the footer.
-- ════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────
-- §1. Helpers
-- ────────────────────────────────────────────────────────────

-- The college's active term, or NULL. 046's partial unique index makes this
-- single-valued.
CREATE OR REPLACE FUNCTION public.active_semester_id(p_college_id uuid)
RETURNS uuid AS $$
  SELECT id FROM public.semesters WHERE college_id = p_college_id AND status = 'active';
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- The department a section belongs to: its programme's.
CREATE OR REPLACE FUNCTION public.section_department_id(p_section_id uuid)
RETURNS uuid AS $$
  SELECT p.department_id FROM public.sections s JOIN public.programmes p ON p.id = s.programme_id
  WHERE s.id = p_section_id;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- May the caller manage this department's academic operation? An HOD of
-- THIS department (departments.hod_id, read live — replacing the HOD moves
-- this answer immediately), or admin/director of the same college as the
-- institutional fallback. Admitted callers only (053).
CREATE OR REPLACE FUNCTION public.can_manage_department(p_department_id uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.departments d
    WHERE d.id = p_department_id
      AND d.college_id = public.my_operational_college_id()
      AND (
        public.my_operational_role() IN ('admin', 'director')
        OR (public.my_operational_role() = 'hod' AND d.hod_id = auth.uid())
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- Does this person belong to the department as staff? Home department on the
-- profile, or heading it (an HOD's own profile department is not always set
-- — the departments.hod_id vs profiles.department_id gotcha).
CREATE OR REPLACE FUNCTION public.is_department_staff(p_profile_id uuid, p_department_id uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles pr
    WHERE pr.id = p_profile_id
      AND pr.status = 'active'
      AND pr.role IN ('teacher', 'hod')
      AND (
        pr.department_id = p_department_id
        OR EXISTS (SELECT 1 FROM public.departments d WHERE d.id = p_department_id AND d.hod_id = pr.id)
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- Refuses unless the caller is admitted (053). Returns the role.
CREATE OR REPLACE FUNCTION public.academic_actor_role()
RETURNS text AS $$
DECLARE v_role text := public.my_operational_role();
BEGIN
  IF auth.uid() IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'Your account cannot make academic changes right now.'
      USING ERRCODE = '42501';
  END IF;
  RETURN v_role;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- In-app notification, written inside the caller's transaction so it can
-- never describe a state that did not commit (contract §12). Internal.
CREATE OR REPLACE FUNCTION public.academic_notify(
  p_college_id uuid, p_receiver uuid, p_title text, p_message text, p_link text DEFAULT NULL, p_type text DEFAULT 'info'
) RETURNS void AS $$
BEGIN
  IF p_receiver IS NULL THEN RETURN; END IF;
  INSERT INTO public.notifications (college_id, title, message, receiver_id, sender_id, type, link)
  VALUES (p_college_id, p_title, p_message, p_receiver, auth.uid(), p_type, p_link);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

-- One audit row written by the acting function. Internal.
CREATE OR REPLACE FUNCTION public.academic_audit(
  p_college_id uuid, p_action text, p_table text, p_record text, p_old jsonb, p_new jsonb
) RETURNS void AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  INSERT INTO public.audit_logs (college_id, user_id, action, table_name, record_id, old_value, new_value)
  VALUES (p_college_id, auth.uid(), p_action, p_table, p_record, p_old, p_new);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

-- ────────────────────────────────────────────────────────────
-- §2. New tables
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.department_terms (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id           uuid NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  department_id        uuid NOT NULL,
  semester_id          uuid NOT NULL,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  start_source         text NOT NULL DEFAULT 'started' CHECK (start_source IN ('started', 'backfill')),
  started_at           timestamptz NOT NULL DEFAULT now(),
  started_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  pending_acknowledged jsonb,
  ended_at             timestamptz,
  ended_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  end_reason           text,
  UNIQUE (department_id, semester_id),
  FOREIGN KEY (department_id) REFERENCES public.departments(id),
  FOREIGN KEY (semester_id) REFERENCES public.semesters(id),
  CONSTRAINT department_terms_end_consistent CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_department_terms_semester ON public.department_terms(semester_id);

CREATE TABLE IF NOT EXISTS public.section_class_incharges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id    uuid NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  semester_id   uuid NOT NULL,
  section_id    uuid NOT NULL,
  teacher_id    uuid NOT NULL,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  assigned_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  assign_reason text,
  ended_at      timestamptz,
  ended_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  end_reason    text,
  FOREIGN KEY (semester_id) REFERENCES public.semesters(id),
  FOREIGN KEY (section_id) REFERENCES public.sections(id),
  FOREIGN KEY (teacher_id) REFERENCES public.profiles(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_class_incharge_one_current
  ON public.section_class_incharges(semester_id, section_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_class_incharge_teacher_current
  ON public.section_class_incharges(teacher_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS public.student_section_assignments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id          uuid NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  student_id          uuid NOT NULL,
  section_id          uuid NOT NULL,
  started_at          timestamptz NOT NULL DEFAULT now(),
  started_semester_id uuid REFERENCES public.semesters(id),
  start_source        text NOT NULL CHECK (start_source IN ('invitation', 'reconciliation', 'backfill', 'transfer', 'progression')),
  start_reason        text,
  assigned_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ended_at            timestamptz,
  ended_semester_id   uuid REFERENCES public.semesters(id),
  end_source          text CHECK (end_source IN ('transfer', 'progression', 'withdrawal')),
  end_reason          text,
  ended_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (student_id) REFERENCES public.students(id),
  FOREIGN KEY (section_id) REFERENCES public.sections(id),
  CONSTRAINT student_section_end_consistent CHECK ((ended_at IS NULL) = (end_source IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_student_section_one_current
  ON public.student_section_assignments(student_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_student_section_current_section
  ON public.student_section_assignments(section_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_student_section_student ON public.student_section_assignments(student_id);

CREATE TABLE IF NOT EXISTS public.department_hod_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id    uuid NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  department_id uuid NOT NULL,
  hod_id        uuid NOT NULL REFERENCES public.profiles(id),
  source        text NOT NULL DEFAULT 'assignment' CHECK (source IN ('assignment', 'backfill')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  assigned_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ended_at      timestamptz,
  ended_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (department_id) REFERENCES public.departments(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_department_hod_one_current
  ON public.department_hod_assignments(department_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS public.offering_instructor_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id    uuid NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  offering_id   uuid NOT NULL,
  instructor_id uuid NOT NULL REFERENCES public.profiles(id),
  source        text NOT NULL DEFAULT 'assignment' CHECK (source IN ('assignment', 'backfill')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  started_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ended_at      timestamptz,
  ended_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (offering_id) REFERENCES public.course_offerings(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_offering_instructor_one_current
  ON public.offering_instructor_history(offering_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_offering_instructor_instructor ON public.offering_instructor_history(instructor_id);

CREATE TABLE IF NOT EXISTS public.external_teaching_authorizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id    uuid NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  department_id uuid NOT NULL,
  teacher_id    uuid NOT NULL,
  reason        text NOT NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  granted_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  revoke_reason text,
  FOREIGN KEY (department_id) REFERENCES public.departments(id),
  FOREIGN KEY (teacher_id) REFERENCES public.profiles(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_teaching_one_current
  ON public.external_teaching_authorizations(department_id, teacher_id) WHERE revoked_at IS NULL;

-- The server-resolved academic placement of a student invitation. The
-- invitations row stays bookkeeping (019); THIS is authoritative, and the
-- invitee can write neither it nor (after §14) the invitation.
CREATE TABLE IF NOT EXISTS public.student_invitation_placements (
  invitation_id       uuid PRIMARY KEY REFERENCES public.invitations(id),
  college_id          uuid NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  department_id       uuid NOT NULL,
  programme_id        uuid NOT NULL,
  section_id          uuid NOT NULL,
  semester_id         uuid NOT NULL,
  programme_semester  integer NOT NULL CHECK (programme_semester >= 1),
  enrollment_number   text NOT NULL,
  parent_name         text,
  parent_email        text,
  parent_phone        text,
  invited_by          uuid NOT NULL REFERENCES public.profiles(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  consumed_at         timestamptz,
  consumed_student_id uuid REFERENCES public.students(id),
  FOREIGN KEY (department_id) REFERENCES public.departments(id),
  FOREIGN KEY (programme_id) REFERENCES public.programmes(id),
  FOREIGN KEY (section_id) REFERENCES public.sections(id),
  FOREIGN KEY (semester_id) REFERENCES public.semesters(id),
  CONSTRAINT placement_consumed_consistent CHECK ((consumed_at IS NULL) = (consumed_student_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_placements_section ON public.student_invitation_placements(section_id);
CREATE INDEX IF NOT EXISTS idx_placements_enrollment ON public.student_invitation_placements(college_id, lower(enrollment_number)) WHERE consumed_at IS NULL;

-- Tenant consistency for the new tables. 047's composite (id, college_id)
-- keys are NOT referenced on purpose: 047 drops and re-adds them, so a
-- foreign key on them would make 047 non-replayable (the re-runnable chain
-- test). The same rule is stated once here, for every caller.
CREATE OR REPLACE FUNCTION public.guard_academic_tenant()
RETURNS trigger AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF TG_TABLE_NAME = 'department_terms' THEN
    v_ok := EXISTS (SELECT 1 FROM public.departments WHERE id = NEW.department_id AND college_id = NEW.college_id)
        AND EXISTS (SELECT 1 FROM public.semesters WHERE id = NEW.semester_id AND college_id = NEW.college_id);
  ELSIF TG_TABLE_NAME = 'section_class_incharges' THEN
    v_ok := EXISTS (SELECT 1 FROM public.semesters WHERE id = NEW.semester_id AND college_id = NEW.college_id)
        AND EXISTS (SELECT 1 FROM public.sections WHERE id = NEW.section_id AND college_id = NEW.college_id)
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = NEW.teacher_id AND college_id = NEW.college_id);
  ELSIF TG_TABLE_NAME = 'student_section_assignments' THEN
    v_ok := EXISTS (SELECT 1 FROM public.students WHERE id = NEW.student_id AND college_id = NEW.college_id)
        AND EXISTS (SELECT 1 FROM public.sections WHERE id = NEW.section_id AND college_id = NEW.college_id);
  ELSIF TG_TABLE_NAME = 'department_hod_assignments' THEN
    v_ok := EXISTS (SELECT 1 FROM public.departments WHERE id = NEW.department_id AND college_id = NEW.college_id);
  ELSIF TG_TABLE_NAME = 'offering_instructor_history' THEN
    v_ok := EXISTS (SELECT 1 FROM public.course_offerings WHERE id = NEW.offering_id AND college_id = NEW.college_id);
  ELSIF TG_TABLE_NAME = 'external_teaching_authorizations' THEN
    v_ok := EXISTS (SELECT 1 FROM public.departments WHERE id = NEW.department_id AND college_id = NEW.college_id)
        AND EXISTS (SELECT 1 FROM public.profiles WHERE id = NEW.teacher_id AND college_id = NEW.college_id);
  ELSIF TG_TABLE_NAME = 'student_invitation_placements' THEN
    v_ok := EXISTS (SELECT 1 FROM public.invitations WHERE id = NEW.invitation_id AND college_id = NEW.college_id)
        AND EXISTS (SELECT 1 FROM public.departments WHERE id = NEW.department_id AND college_id = NEW.college_id)
        AND EXISTS (SELECT 1 FROM public.programmes WHERE id = NEW.programme_id AND college_id = NEW.college_id)
        AND EXISTS (SELECT 1 FROM public.sections WHERE id = NEW.section_id AND college_id = NEW.college_id)
        AND EXISTS (SELECT 1 FROM public.semesters WHERE id = NEW.semester_id AND college_id = NEW.college_id);
  ELSE
    v_ok := false;
  END IF;
  IF NOT v_ok THEN
    RAISE EXCEPTION '%: every reference must belong to the same college', TG_TABLE_NAME
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['department_terms', 'section_class_incharges', 'student_section_assignments',
                           'department_hod_assignments', 'offering_instructor_history',
                           'external_teaching_authorizations', 'student_invitation_placements'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS guard_academic_tenant ON public.%I', t);
    EXECUTE format('CREATE TRIGGER guard_academic_tenant BEFORE INSERT OR UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.guard_academic_tenant()', t);
  END LOOP;
END $$;

-- Helpers that read the new tables (SQL bodies are validated at creation).

-- Decision 4 — THE instructor eligibility rule, as implemented:
--   same college as the course; active; teacher or hod; and EITHER staff of
--   the course's owning department OR holding an unrevoked external teaching
--   authorization granted by that department.
CREATE OR REPLACE FUNCTION public.instructor_eligible(p_teacher_id uuid, p_course_id uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles pr
    JOIN public.courses c ON c.id = p_course_id
    WHERE pr.id = p_teacher_id
      AND pr.college_id = c.college_id
      AND pr.status = 'active'
      AND pr.role IN ('teacher', 'hod')
      AND (
        public.is_department_staff(pr.id, c.department_id)
        OR EXISTS (
          SELECT 1 FROM public.external_teaching_authorizations a
          WHERE a.department_id = c.department_id
            AND a.teacher_id = pr.id
            AND a.revoked_at IS NULL
        )
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- The current Class In-Charge of a section in a term.
CREATE OR REPLACE FUNCTION public.current_class_incharge(p_section_id uuid, p_semester_id uuid)
RETURNS uuid AS $$
  SELECT teacher_id FROM public.section_class_incharges
  WHERE section_id = p_section_id AND semester_id = p_semester_id AND ended_at IS NULL;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- ────────────────────────────────────────────────────────────
-- §3. History guard — one trigger for every effective-dated table.
--
-- TG_ARGV[0]   the column whose NULL -> value transition "closes" the row
-- TG_ARGV[1..] the only columns that closing may set
--
-- A closed row is immutable; an open row may change only by being closed;
-- DELETE is refused (a college deletion — service role, auth.uid() NULL —
-- still cascades, as 045 intends for tenant removal). Applies to every
-- authenticated caller, the definer functions included: a function bug
-- cannot rewrite history either.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_academic_history()
RETURNS trigger AS $$
DECLARE
  v_close   text := TG_ARGV[0];
  v_allowed text[] := TG_ARGV[1:TG_NARGS - 1];
  v_old     jsonb;
  v_new     jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF auth.uid() IS NULL THEN RETURN OLD; END IF;
    RAISE EXCEPTION '%: academic history cannot be deleted', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);

  IF v_old ->> v_close IS NOT NULL THEN
    RAISE EXCEPTION '%: a closed history row is immutable', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_new ->> v_close IS NULL THEN
    RAISE EXCEPTION '%: an open history row may change only by being closed', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  IF (v_old - v_allowed) IS DISTINCT FROM (v_new - v_allowed) THEN
    RAISE EXCEPTION '%: closing a history row may not change its recorded facts', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS guard_academic_history ON public.department_terms;
CREATE TRIGGER guard_academic_history BEFORE UPDATE OR DELETE ON public.department_terms
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_history('ended_at', 'status', 'ended_at', 'ended_by', 'end_reason');
DROP TRIGGER IF EXISTS guard_academic_history ON public.section_class_incharges;
CREATE TRIGGER guard_academic_history BEFORE UPDATE OR DELETE ON public.section_class_incharges
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_history('ended_at', 'ended_at', 'ended_by', 'end_reason');
DROP TRIGGER IF EXISTS guard_academic_history ON public.student_section_assignments;
CREATE TRIGGER guard_academic_history BEFORE UPDATE OR DELETE ON public.student_section_assignments
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_history('ended_at', 'ended_at', 'ended_semester_id', 'end_source', 'end_reason', 'ended_by');
DROP TRIGGER IF EXISTS guard_academic_history ON public.department_hod_assignments;
CREATE TRIGGER guard_academic_history BEFORE UPDATE OR DELETE ON public.department_hod_assignments
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_history('ended_at', 'ended_at', 'ended_by');
DROP TRIGGER IF EXISTS guard_academic_history ON public.offering_instructor_history;
CREATE TRIGGER guard_academic_history BEFORE UPDATE OR DELETE ON public.offering_instructor_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_history('ended_at', 'ended_at', 'ended_by');
DROP TRIGGER IF EXISTS guard_academic_history ON public.external_teaching_authorizations;
CREATE TRIGGER guard_academic_history BEFORE UPDATE OR DELETE ON public.external_teaching_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_history('revoked_at', 'revoked_at', 'revoked_by', 'revoke_reason');
DROP TRIGGER IF EXISTS guard_academic_history ON public.student_invitation_placements;
CREATE TRIGGER guard_academic_history BEFORE UPDATE OR DELETE ON public.student_invitation_placements
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_history('consumed_at', 'consumed_at', 'consumed_student_id');

-- A department term may close only by moving active -> ended.
CREATE OR REPLACE FUNCTION public.guard_department_term_status()
RETURNS trigger AS $$
BEGIN
  IF NOT (OLD.status = 'active' AND NEW.status = 'ended') THEN
    RAISE EXCEPTION 'department_terms: status may only move from active to ended'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS guard_department_term_status ON public.department_terms;
CREATE TRIGGER guard_department_term_status BEFORE UPDATE ON public.department_terms
  FOR EACH ROW EXECUTE FUNCTION public.guard_department_term_status();

-- A student's section is always in their home department, and a NEW
-- assignment goes only to an active section.
CREATE OR REPLACE FUNCTION public.guard_student_section_assignment()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.students st
    WHERE st.id = NEW.student_id
      AND st.department_id = public.section_department_id(NEW.section_id)
  ) THEN
    RAISE EXCEPTION 'A student can only be placed in a section of their own department.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sections s WHERE s.id = NEW.section_id AND s.status = 'active') THEN
    RAISE EXCEPTION 'That section is not active.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS guard_student_section_assignment ON public.student_section_assignments;
CREATE TRIGGER guard_student_section_assignment BEFORE INSERT ON public.student_section_assignments
  FOR EACH ROW EXECUTE FUNCTION public.guard_student_section_assignment();

-- ────────────────────────────────────────────────────────────
-- §4. Trigger-written history: HOD and offering instructor.
--
-- departments.hod_id stays the ONE authoritative HOD (every HOD policy reads
-- it live). The history table only records what it was, so "who was HOD of
-- CSE in 2025-26" is answerable, and replacing an HOD changes responsibility
-- and nothing else — no configuration hangs off the person.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_department_hod()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.hod_id IS NOT DISTINCT FROM OLD.hod_id THEN
    RETURN NEW;
  END IF;
  UPDATE public.department_hod_assignments
     SET ended_at = now(), ended_by = auth.uid()
   WHERE department_id = NEW.id AND ended_at IS NULL;
  IF NEW.hod_id IS NOT NULL THEN
    INSERT INTO public.department_hod_assignments (college_id, department_id, hod_id, source, assigned_by)
    VALUES (NEW.college_id, NEW.id, NEW.hod_id, 'assignment', auth.uid());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS record_department_hod ON public.departments;
CREATE TRIGGER record_department_hod AFTER INSERT OR UPDATE OF hod_id ON public.departments
  FOR EACH ROW EXECUTE FUNCTION public.record_department_hod();

CREATE OR REPLACE FUNCTION public.record_offering_instructor()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.instructor_id IS NOT DISTINCT FROM OLD.instructor_id THEN
    RETURN NEW;
  END IF;
  UPDATE public.offering_instructor_history
     SET ended_at = now(), ended_by = auth.uid()
   WHERE offering_id = NEW.id AND ended_at IS NULL;
  IF NEW.instructor_id IS NOT NULL THEN
    INSERT INTO public.offering_instructor_history (college_id, offering_id, instructor_id, source, started_by)
    VALUES (NEW.college_id, NEW.id, NEW.instructor_id, 'assignment', auth.uid());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS record_offering_instructor ON public.course_offerings;
CREATE TRIGGER record_offering_instructor AFTER INSERT OR UPDATE OF instructor_id ON public.course_offerings
  FOR EACH ROW EXECUTE FUNCTION public.record_offering_instructor();

-- ────────────────────────────────────────────────────────────
-- §5. course_offerings.
-- ────────────────────────────────────────────────────────────

-- Teacher clash: would `p_instructor` teaching `p_offering` overlap another
-- of their classes in the same term? Shared by the offering guard (an
-- instructor change) and the timetable guard (a slot write).
CREATE OR REPLACE FUNCTION public.timetable_teacher_clash(
  p_offering_id uuid, p_instructor_id uuid, p_day integer, p_start time, p_end time, p_exclude_slot uuid
) RETURNS text AS $$
  SELECT coalesce(pr.full_name, 'This teacher') || ' already teaches ' || c.code || ' (' || s.name || ') '
         || to_char(t.start_time, 'HH24:MI') || '–' || to_char(t.end_time, 'HH24:MI') || ' on that day.'
  FROM public.timetable_slots t
  JOIN public.course_offerings o ON o.id = t.offering_id
  JOIN public.course_offerings mine ON mine.id = p_offering_id
  JOIN public.courses c ON c.id = o.course_id
  JOIN public.sections s ON s.id = o.section_id
  LEFT JOIN public.profiles pr ON pr.id = p_instructor_id
  WHERE o.semester_id = mine.semester_id
    AND o.id <> p_offering_id
    AND o.status <> 'cancelled'
    AND o.instructor_id = p_instructor_id
    AND t.day_of_week = p_day
    AND t.start_time < p_end AND p_start < t.end_time
    AND (p_exclude_slot IS NULL OR t.id <> p_exclude_slot)
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- Decision 4 + structure validation, for every authenticated caller. The
-- service role (seed, back office) is exempt, as for every 051 guard.
CREATE OR REPLACE FUNCTION public.guard_offering_assignment()
RETURNS trigger AS $$
DECLARE
  v_clash text;
  v_slot  record;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.sections WHERE id = NEW.section_id AND status = 'active') THEN
      RAISE EXCEPTION 'Offerings can only be created for an active section.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.courses WHERE id = NEW.course_id AND status = 'active') THEN
      RAISE EXCEPTION 'Offerings can only be created for an active course.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.instructor_id IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW.instructor_id IS DISTINCT FROM OLD.instructor_id
          OR NEW.course_id IS DISTINCT FROM OLD.course_id) THEN
    IF NOT public.instructor_eligible(NEW.instructor_id, NEW.course_id) THEN
      RAISE EXCEPTION 'That teacher is not authorized to teach this course. Assign a teacher of the course''s department, or grant an external teaching authorization first.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- An instructor change must not double-book the new teacher.
  IF TG_OP = 'UPDATE' AND NEW.instructor_id IS NOT NULL
     AND NEW.instructor_id IS DISTINCT FROM OLD.instructor_id THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('timetable:' || NEW.semester_id::text, 0));
    FOR v_slot IN SELECT * FROM public.timetable_slots WHERE offering_id = NEW.id LOOP
      v_clash := public.timetable_teacher_clash(NEW.id, NEW.instructor_id, v_slot.day_of_week, v_slot.start_time, v_slot.end_time, NULL);
      IF v_clash IS NOT NULL THEN
        RAISE EXCEPTION 'Timetable conflict: %', v_clash USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS guard_offering_assignment ON public.course_offerings;
CREATE TRIGGER guard_offering_assignment
  BEFORE INSERT OR UPDATE OF instructor_id, course_id ON public.course_offerings
  FOR EACH ROW EXECUTE FUNCTION public.guard_offering_assignment();

-- Defect 5: 051's guard allowed "reassigning the instructor of a historical
-- offering". Historical teacher assignments are immutable (contract §8), so
-- a closed (or reopened) term's instructor is now frozen too. Otherwise the
-- body is 051's, verbatim.
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
      SELECT status INTO v_status FROM public.semesters WHERE id = OLD.semester_id;
      IF NEW.status IS DISTINCT FROM OLD.status AND v_status = 'closed' THEN
        RAISE EXCEPTION 'course_offerings: cannot change the status of an offering in a closed semester'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.instructor_id IS DISTINCT FROM OLD.instructor_id AND v_status IN ('closed', 'reopened') THEN
        RAISE EXCEPTION 'The teacher of a closed term''s offering is part of its history and cannot be changed.'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

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

-- Enrol a section's current students into one offering, skipping anyone
-- already enrolled in the same course this term (one enrolled row per course
-- per term — §7). Electives are never auto-enrolled. Internal.
CREATE OR REPLACE FUNCTION public.enroll_section_into_offering(p_offering_id uuid)
RETURNS integer AS $$
DECLARE v_count integer;
BEGIN
  WITH o AS (
    SELECT co.id, co.college_id, co.section_id, co.course_id, co.semester_id
    FROM public.course_offerings co
    JOIN public.courses c ON c.id = co.course_id
    WHERE co.id = p_offering_id
      AND co.status IN ('planned', 'active')
      AND c.type <> 'elective'
  ), ins AS (
    INSERT INTO public.course_enrollments (college_id, student_id, offering_id, status)
    SELECT o.college_id, a.student_id, o.id, 'enrolled'
    FROM o
    JOIN public.student_section_assignments a ON a.section_id = o.section_id AND a.ended_at IS NULL
    JOIN public.students st ON st.id = a.student_id AND st.status IN ('active', 'on_leave')
    WHERE NOT EXISTS (
      SELECT 1 FROM public.course_enrollments e
      JOIN public.course_offerings eo ON eo.id = e.offering_id
      WHERE e.student_id = a.student_id
        AND e.status = 'enrolled'
        AND eo.course_id = o.course_id
        AND eo.semester_id = o.semester_id
    )
    ON CONFLICT (offering_id, student_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

-- Auto-enrolment: an offering created in the ACTIVE term reaches the
-- section's current students at once (planned terms are enrolled when the
-- department term starts — §9).
CREATE OR REPLACE FUNCTION public.offering_auto_enroll()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.semesters WHERE id = NEW.semester_id AND status = 'active') THEN
    PERFORM public.enroll_section_into_offering(NEW.id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS offering_auto_enroll ON public.course_offerings;
CREATE TRIGGER offering_auto_enroll AFTER INSERT ON public.course_offerings
  FOR EACH ROW EXECUTE FUNCTION public.offering_auto_enroll();

-- ────────────────────────────────────────────────────────────
-- §6. Defect 4 — a completed offering accepts no academic writes.
--
-- Covers every path that reaches attendance or marks, including the HOD's
-- approved-correction policy (047), which does not go through
-- can_write_offering_records(). The one exception is 052's controlled
-- correction window: while the term is 'reopened', its completed offerings
-- are writable again, which is what reopening exists for.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_offering_open_for_records()
RETURNS trigger AS $$
DECLARE
  v_offering uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.offering_id ELSE NEW.offering_id END;
  v_status   text;
  v_term     text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT o.status, s.status INTO v_status, v_term
  FROM public.course_offerings o JOIN public.semesters s ON s.id = o.semester_id
  WHERE o.id = v_offering;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'This course offering was cancelled; its records are read-only.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_status = 'completed' AND v_term IS DISTINCT FROM 'reopened' THEN
    RAISE EXCEPTION 'This course offering is completed; its records are read-only.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS guard_offering_open_for_records ON public.attendance;
CREATE TRIGGER guard_offering_open_for_records BEFORE INSERT OR UPDATE OR DELETE ON public.attendance
  FOR EACH ROW EXECUTE FUNCTION public.guard_offering_open_for_records();
DROP TRIGGER IF EXISTS guard_offering_open_for_records ON public.marks;
CREATE TRIGGER guard_offering_open_for_records BEFORE INSERT OR UPDATE OR DELETE ON public.marks
  FOR EACH ROW EXECUTE FUNCTION public.guard_offering_open_for_records();

-- ────────────────────────────────────────────────────────────
-- §7. course_enrollments.
--
-- 047's course_enrollments_manage_staff let the HOD and the instructor
-- write enrolments directly. No application code ever used it (a repo-wide
-- scan finds zero enrolment writes), and it is exactly the path that would
-- let a teacher enrol a student into another department's class, bypassing
-- the course-change approvals of PR 2. Enrolment now changes only through
-- the definer functions in this migration (and PR 2's), with admin keeping
-- direct back-office access. Staff READ is unchanged (036's _read_staff).
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "course_enrollments_manage_staff" ON public.course_enrollments;
DROP POLICY IF EXISTS "course_enrollments_manage_admin" ON public.course_enrollments;
CREATE POLICY "course_enrollments_manage_admin" ON public.course_enrollments
  FOR ALL
  USING (college_id = public.get_my_college_id() AND public.get_my_role() = 'admin')
  WITH CHECK (college_id = public.get_my_college_id() AND public.get_my_role() = 'admin');

-- One `enrolled` row per student per course per term, for every caller.
-- course_id/semester_id are not on the enrolment (047 removed them on
-- purpose), so this cannot be a plain index; a per-student advisory lock
-- serializes the check-then-insert.
CREATE OR REPLACE FUNCTION public.guard_enrollment_unique_course()
RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'enrolled' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('student_academic:' || NEW.student_id::text, 0));
  IF EXISTS (
    SELECT 1
    FROM public.course_enrollments e
    JOIN public.course_offerings eo ON eo.id = e.offering_id
    JOIN public.course_offerings mine ON mine.id = NEW.offering_id
    WHERE e.student_id = NEW.student_id
      AND e.id <> NEW.id
      -- The SAME offering is the unique key's business (and ON CONFLICT's):
      -- a BEFORE trigger fires before conflict resolution, so counting it
      -- here would break idempotent re-inserts.
      AND e.offering_id <> NEW.offering_id
      AND e.status = 'enrolled'
      AND eo.course_id = mine.course_id
      AND eo.semester_id = mine.semester_id
  ) THEN
    RAISE EXCEPTION 'This student is already enrolled in this course for this term.'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS guard_enrollment_unique_course ON public.course_enrollments;
CREATE TRIGGER guard_enrollment_unique_course BEFORE INSERT OR UPDATE OF status, offering_id ON public.course_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.guard_enrollment_unique_course();

-- ────────────────────────────────────────────────────────────
-- §8. Department academic configuration (decision 5).
--
-- Configuration belongs to the DEPARTMENT, never to the HOD: every grant
-- below reads departments.hod_id live, so HOD A -> HOD B moves the right to
-- manage the same rows and recreates nothing.
--
-- Programmes: admin/director keep 046's FOR ALL. An HOD may now create and
-- edit their OWN department's programmes — no delete, no move to another
-- department. Sections and courses keep their 047 HOD grants. Guards below
-- protect history for every caller; an audit trigger records every
-- structural change.
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "programmes_hod_insert" ON public.programmes;
CREATE POLICY "programmes_hod_insert" ON public.programmes
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'hod'
    AND EXISTS (SELECT 1 FROM public.departments d WHERE d.id = programmes.department_id AND d.hod_id = auth.uid())
  );
DROP POLICY IF EXISTS "programmes_hod_update" ON public.programmes;
CREATE POLICY "programmes_hod_update" ON public.programmes
  FOR UPDATE
  USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'hod'
    AND EXISTS (SELECT 1 FROM public.departments d WHERE d.id = programmes.department_id AND d.hod_id = auth.uid())
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'hod'
    AND EXISTS (SELECT 1 FROM public.departments d WHERE d.id = programmes.department_id AND d.hod_id = auth.uid())
  );

CREATE OR REPLACE FUNCTION public.guard_academic_structure()
RETURNS trigger AS $$
DECLARE
  v_max_sem integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_TABLE_NAME = 'programmes' THEN
    IF TG_OP = 'DELETE' THEN
      IF public.get_my_role() = 'hod' THEN
        RAISE EXCEPTION 'An HOD cannot delete a programme; mark it inactive instead.'
          USING ERRCODE = '42501';
      END IF;
      RETURN OLD;
    END IF;
    IF NEW.department_id IS DISTINCT FROM OLD.department_id THEN
      RAISE EXCEPTION 'A programme cannot be moved to another department.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.duration_semesters IS DISTINCT FROM OLD.duration_semesters THEN
      SELECT max(st.semester) INTO v_max_sem
      FROM public.student_section_assignments a
      JOIN public.sections s ON s.id = a.section_id
      JOIN public.students st ON st.id = a.student_id
      WHERE s.programme_id = NEW.id AND a.ended_at IS NULL;
      IF NEW.duration_semesters < 1 OR (v_max_sem IS NOT NULL AND NEW.duration_semesters < v_max_sem) THEN
        RAISE EXCEPTION 'The programme duration cannot be shorter than the semester its current students are in (%).', v_max_sem
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.status = 'inactive' AND OLD.status = 'active'
       AND EXISTS (SELECT 1 FROM public.sections WHERE programme_id = NEW.id AND status = 'active') THEN
      RAISE EXCEPTION 'Deactivate the programme''s sections before the programme.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'sections' THEN
    IF TG_OP = 'DELETE' THEN
      IF EXISTS (SELECT 1 FROM public.student_section_assignments WHERE section_id = OLD.id)
         OR EXISTS (SELECT 1 FROM public.course_offerings WHERE section_id = OLD.id) THEN
        RAISE EXCEPTION 'A section with academic history cannot be deleted; mark it inactive instead.'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN OLD;
    END IF;
    IF (NEW.programme_id IS DISTINCT FROM OLD.programme_id OR NEW.batch_year IS DISTINCT FROM OLD.batch_year)
       AND (EXISTS (SELECT 1 FROM public.student_section_assignments WHERE section_id = OLD.id)
            OR EXISTS (SELECT 1 FROM public.course_offerings WHERE section_id = OLD.id)) THEN
      RAISE EXCEPTION 'A section with academic history cannot change its programme or batch year.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'inactive' AND OLD.status = 'active'
       AND EXISTS (SELECT 1 FROM public.student_section_assignments WHERE section_id = OLD.id AND ended_at IS NULL) THEN
      RAISE EXCEPTION 'A section with current students cannot be deactivated.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- courses
  IF TG_OP = 'UPDATE' AND NEW.department_id IS DISTINCT FROM OLD.department_id
     AND EXISTS (SELECT 1 FROM public.course_offerings WHERE course_id = OLD.id) THEN
    RAISE EXCEPTION 'A course that has been offered cannot move to another department.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS guard_academic_structure ON public.programmes;
CREATE TRIGGER guard_academic_structure BEFORE UPDATE OR DELETE ON public.programmes
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_structure();
DROP TRIGGER IF EXISTS guard_academic_structure ON public.sections;
CREATE TRIGGER guard_academic_structure BEFORE UPDATE OR DELETE ON public.sections
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_structure();
DROP TRIGGER IF EXISTS guard_academic_structure ON public.courses;
CREATE TRIGGER guard_academic_structure BEFORE UPDATE OR DELETE ON public.courses
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_structure();

-- Every structural change is audited by the database, whoever made it and
-- however (server action, mobile API, direct PostgREST).
CREATE OR REPLACE FUNCTION public.audit_academic_structure()
RETURNS trigger AS $$
DECLARE
  v_college uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.college_id ELSE NEW.college_id END;
  v_id      text := CASE WHEN TG_OP = 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND to_jsonb(OLD) - 'updated_at' = to_jsonb(NEW) - 'updated_at' THEN RETURN NULL; END IF;
  INSERT INTO public.audit_logs (college_id, user_id, action, table_name, record_id, old_value, new_value)
  VALUES (
    v_college, auth.uid(),
    'academic_structure.' || lower(TG_OP),
    TG_TABLE_NAME, v_id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['programmes', 'sections', 'courses', 'course_offerings'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_academic_structure ON public.%I', t);
    EXECUTE format('CREATE TRIGGER audit_academic_structure AFTER INSERT OR UPDATE OR DELETE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.audit_academic_structure()', t);
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────
-- §9. Department operational term — inside the active college term
--     (decision 1). Not a second term model: the row is (department,
--     college term), and it can exist only for the active college term.
-- ────────────────────────────────────────────────────────────

-- What is missing before a department can start. Blocking items stop a
-- start; 'pending' items (offerings without a teacher) need an explicit
-- acknowledgement. Readable by anyone who can manage the department.
CREATE OR REPLACE FUNCTION public.department_term_readiness(p_department_id uuid)
RETURNS jsonb AS $$
DECLARE
  v_role    text := public.academic_actor_role();
  v_dept    record;
  v_sem     record;
  v_term    record;
  v_items   jsonb := '[]'::jsonb;
  r         record;
BEGIN
  IF NOT public.can_manage_department(p_department_id) THEN
    RAISE EXCEPTION 'You can only view the readiness of a department you manage.'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_dept FROM public.departments WHERE id = p_department_id;
  SELECT * INTO v_sem FROM public.semesters WHERE college_id = v_dept.college_id AND status = 'active';

  IF v_sem.id IS NULL THEN
    RETURN jsonb_build_object('semester_id', NULL, 'semester_name', NULL, 'status', 'no_active_term',
      'ready', false, 'blocking_count', 1, 'pending_count', 0,
      'items', jsonb_build_array(jsonb_build_object('code', 'no_active_term', 'severity', 'blocking',
        'message', 'The college has no active term. Admin or Director starts the term first.')));
  END IF;

  SELECT * INTO v_term FROM public.department_terms WHERE department_id = p_department_id AND semester_id = v_sem.id;

  IF NOT EXISTS (SELECT 1 FROM public.programmes WHERE department_id = p_department_id AND status = 'active') THEN
    v_items := v_items || jsonb_build_object('code', 'no_programmes', 'severity', 'blocking',
      'message', 'The department has no active programme.');
  END IF;

  FOR r IN SELECT p.id, p.name FROM public.programmes p
           WHERE p.department_id = p_department_id AND p.status = 'active'
             AND NOT EXISTS (SELECT 1 FROM public.sections s WHERE s.programme_id = p.id AND s.status = 'active') LOOP
    v_items := v_items || jsonb_build_object('code', 'programme_without_sections', 'severity', 'blocking',
      'message', r.name || ' has no active section.', 'ref_id', r.id);
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.courses WHERE department_id = p_department_id AND status = 'active') THEN
    v_items := v_items || jsonb_build_object('code', 'no_courses', 'severity', 'blocking',
      'message', 'The department has no active course.');
  END IF;

  FOR r IN SELECT s.id, s.name, s.batch_year, p.code AS programme
           FROM public.sections s JOIN public.programmes p ON p.id = s.programme_id
           WHERE p.department_id = p_department_id AND p.status = 'active' AND s.status = 'active'
           ORDER BY p.code, s.batch_year DESC, s.name LOOP
    IF NOT EXISTS (SELECT 1 FROM public.course_offerings o
                   WHERE o.section_id = r.id AND o.semester_id = v_sem.id AND o.status <> 'cancelled') THEN
      v_items := v_items || jsonb_build_object('code', 'section_without_offerings', 'severity', 'blocking',
        'message', r.programme || ' ' || r.name || ' (' || r.batch_year || ') has no course offering this term.', 'ref_id', r.id);
    END IF;
    IF public.current_class_incharge(r.id, v_sem.id) IS NULL THEN
      v_items := v_items || jsonb_build_object('code', 'section_without_incharge', 'severity', 'blocking',
        'message', r.programme || ' ' || r.name || ' (' || r.batch_year || ') has no Class In-Charge this term.', 'ref_id', r.id);
    END IF;
  END LOOP;

  FOR r IN SELECT o.id, c.code, s.name AS section, o.instructor_id, o.course_id
           FROM public.course_offerings o
           JOIN public.courses c ON c.id = o.course_id
           JOIN public.sections s ON s.id = o.section_id
           WHERE c.department_id = p_department_id AND o.semester_id = v_sem.id AND o.status IN ('planned', 'active')
           ORDER BY c.code, s.name LOOP
    IF r.instructor_id IS NULL THEN
      v_items := v_items || jsonb_build_object('code', 'offering_without_instructor', 'severity', 'pending',
        'message', r.code || ' (' || r.section || ') has no teacher assigned.', 'ref_id', r.id);
    ELSIF NOT public.instructor_eligible(r.instructor_id, r.course_id) THEN
      v_items := v_items || jsonb_build_object('code', 'instructor_not_eligible', 'severity', 'blocking',
        'message', r.code || ' (' || r.section || '): the assigned teacher is no longer authorized to teach it.', 'ref_id', r.id);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'semester_id', v_sem.id,
    'semester_name', v_sem.name,
    'status', coalesce(v_term.status, 'not_started'),
    'started_at', v_term.started_at,
    'ended_at', v_term.ended_at,
    'ready', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) i WHERE i->>'severity' = 'blocking'),
    'blocking_count', (SELECT count(*) FROM jsonb_array_elements(v_items) i WHERE i->>'severity' = 'blocking'),
    'pending_count', (SELECT count(*) FROM jsonb_array_elements(v_items) i WHERE i->>'severity' = 'pending'),
    'items', v_items
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.start_department_term(p_department_id uuid, p_acknowledge_pending boolean DEFAULT false)
RETURNS jsonb AS $$
DECLARE
  v_role       text := public.academic_actor_role();
  v_dept       record;
  v_sem        record;
  v_readiness  jsonb;
  v_pending    jsonb;
  v_row        public.department_terms;
  v_activated  integer;
  v_enrolled   integer := 0;
  r            record;
BEGIN
  IF NOT public.can_manage_department(p_department_id) THEN
    RAISE EXCEPTION 'Only the HOD of this department can start its term.'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_dept FROM public.departments WHERE id = p_department_id;

  SELECT * INTO v_sem FROM public.semesters
   WHERE college_id = v_dept.college_id AND status = 'active'
   FOR SHARE;
  IF v_sem.id IS NULL THEN
    RAISE EXCEPTION 'The college has no active term to start the department in.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('department_term:' || p_department_id::text || ':' || v_sem.id::text, 0));

  IF EXISTS (SELECT 1 FROM public.department_terms WHERE department_id = p_department_id AND semester_id = v_sem.id) THEN
    RAISE EXCEPTION 'The department''s term has already been started for %.', v_sem.name
      USING ERRCODE = 'check_violation';
  END IF;

  v_readiness := public.department_term_readiness(p_department_id);
  IF (v_readiness->>'blocking_count')::int > 0 THEN
    RAISE EXCEPTION 'The department is not ready to start: % item(s) need attention.', v_readiness->>'blocking_count'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(jsonb_agg(i->'ref_id'), '[]'::jsonb) INTO v_pending
  FROM jsonb_array_elements(v_readiness->'items') i WHERE i->>'severity' = 'pending';
  IF jsonb_array_length(v_pending) > 0 AND NOT coalesce(p_acknowledge_pending, false) THEN
    RAISE EXCEPTION '% offering(s) still have no teacher. Confirm that they start without one.', jsonb_array_length(v_pending)
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.department_terms (college_id, department_id, semester_id, status, started_by, pending_acknowledged)
  VALUES (v_dept.college_id, p_department_id, v_sem.id, 'active', auth.uid(),
          CASE WHEN jsonb_array_length(v_pending) > 0 THEN v_pending END)
  RETURNING * INTO v_row;

  UPDATE public.course_offerings o SET status = 'active'
   WHERE o.semester_id = v_sem.id AND o.status = 'planned'
     AND o.course_id IN (SELECT id FROM public.courses WHERE department_id = p_department_id);
  GET DIAGNOSTICS v_activated = ROW_COUNT;

  -- Enrol the department's section members into every offering of their
  -- section this term (service courses taught by another department too).
  FOR r IN SELECT o.id FROM public.course_offerings o
           WHERE o.semester_id = v_sem.id
             AND public.section_department_id(o.section_id) = p_department_id LOOP
    v_enrolled := v_enrolled + public.enroll_section_into_offering(r.id);
  END LOOP;

  PERFORM public.academic_audit(v_dept.college_id, 'department_term.started', 'department_terms', v_row.id::text, NULL,
    jsonb_build_object('department_id', p_department_id, 'semester_id', v_sem.id, 'offerings_activated', v_activated,
                       'enrollments_created', v_enrolled, 'pending_acknowledged', v_row.pending_acknowledged));

  FOR r IN SELECT pr.id FROM public.profiles pr
           WHERE public.is_department_staff(pr.id, p_department_id) AND pr.id <> auth.uid() LOOP
    PERFORM public.academic_notify(v_dept.college_id, r.id, 'Department term started',
      v_dept.name || ' has started ' || v_sem.name || '.', '/teacher/dashboard');
  END LOOP;

  RETURN to_jsonb(v_row) || jsonb_build_object('offerings_activated', v_activated, 'enrollments_created', v_enrolled);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.end_department_term(p_department_id uuid, p_reason text)
RETURNS jsonb AS $$
DECLARE
  v_role      text := public.academic_actor_role();
  v_dept      record;
  v_sem       record;
  v_row       public.department_terms;
  v_completed integer;
  v_reason    text := btrim(coalesce(p_reason, ''));
  r           record;
BEGIN
  IF NOT public.can_manage_department(p_department_id) THEN
    RAISE EXCEPTION 'Only the HOD of this department can end its term.'
      USING ERRCODE = '42501';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required to end the term.'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_dept FROM public.departments WHERE id = p_department_id;
  SELECT * INTO v_sem FROM public.semesters WHERE college_id = v_dept.college_id AND status = 'active' FOR SHARE;
  IF v_sem.id IS NULL THEN
    RAISE EXCEPTION 'The college has no active term.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('department_term:' || p_department_id::text || ':' || v_sem.id::text, 0));

  SELECT * INTO v_row FROM public.department_terms
   WHERE department_id = p_department_id AND semester_id = v_sem.id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'The department''s term has not been started.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_row.status = 'ended' THEN
    RAISE EXCEPTION 'The department''s term has already ended.'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.department_terms
     SET status = 'ended', ended_at = now(), ended_by = auth.uid(), end_reason = v_reason
   WHERE id = v_row.id
  RETURNING * INTO v_row;

  -- The department's offerings this term stop accepting academic writes
  -- (§6). Enrolments, attendance and marks are untouched.
  UPDATE public.course_offerings o SET status = 'completed'
   WHERE o.semester_id = v_sem.id AND o.status IN ('planned', 'active')
     AND o.course_id IN (SELECT id FROM public.courses WHERE department_id = p_department_id);
  GET DIAGNOSTICS v_completed = ROW_COUNT;

  PERFORM public.academic_audit(v_dept.college_id, 'department_term.ended', 'department_terms', v_row.id::text,
    jsonb_build_object('status', 'active'),
    jsonb_build_object('status', 'ended', 'reason', v_reason, 'offerings_completed', v_completed));

  FOR r IN SELECT pr.id FROM public.profiles pr
           WHERE public.is_department_staff(pr.id, p_department_id) AND pr.id <> auth.uid() LOOP
    PERFORM public.academic_notify(v_dept.college_id, r.id, 'Department term ended',
      v_dept.name || ' has ended ' || v_sem.name || '. Its course offerings are now read-only.', '/teacher/dashboard');
  END LOOP;

  RETURN to_jsonb(v_row) || jsonb_build_object('offerings_completed', v_completed);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

-- Closing the college term ends any department term still running in it,
-- so the two never disagree.
CREATE OR REPLACE FUNCTION public.end_department_terms_with_semester()
RETURNS trigger AS $$
BEGIN
  UPDATE public.department_terms
     SET status = 'ended', ended_at = now(), ended_by = auth.uid(),
         end_reason = 'The college term was closed.'
   WHERE semester_id = NEW.id AND status = 'active';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS end_department_terms_with_semester ON public.semesters;
CREATE TRIGGER end_department_terms_with_semester AFTER UPDATE OF status ON public.semesters
  FOR EACH ROW WHEN (NEW.status = 'closed' AND OLD.status = 'active')
  EXECUTE FUNCTION public.end_department_terms_with_semester();

-- ────────────────────────────────────────────────────────────
-- §10. Class In-Charge — explicit, per term and section. Teaching a subject
--      to a section never makes anyone its In-Charge.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.assign_class_incharge(p_section_id uuid, p_teacher_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE
  v_role    text := public.academic_actor_role();
  v_section record;
  v_dept    uuid;
  v_sem     uuid;
  v_current public.section_class_incharges;
  v_new     public.section_class_incharges;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  SELECT s.*, p.code AS programme_code INTO v_section
  FROM public.sections s JOIN public.programmes p ON p.id = s.programme_id
  WHERE s.id = p_section_id AND s.college_id = public.my_operational_college_id();
  IF v_section.id IS NULL THEN
    RAISE EXCEPTION 'Section not found in your college.' USING ERRCODE = 'no_data_found';
  END IF;
  v_dept := public.section_department_id(p_section_id);
  IF NOT public.can_manage_department(v_dept) THEN
    RAISE EXCEPTION 'Only the HOD of the section''s department can assign its Class In-Charge.'
      USING ERRCODE = '42501';
  END IF;
  IF v_section.status <> 'active' THEN
    RAISE EXCEPTION 'That section is not active.' USING ERRCODE = 'check_violation';
  END IF;
  v_sem := public.active_semester_id(v_section.college_id);
  IF v_sem IS NULL THEN
    RAISE EXCEPTION 'The college has no active term.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_teacher_id AND college_id = v_section.college_id)
     OR NOT public.is_department_staff(p_teacher_id, v_dept) THEN
    RAISE EXCEPTION 'The Class In-Charge must be an active teacher of the section''s department.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('class_incharge:' || p_section_id::text || ':' || v_sem::text, 0));

  SELECT * INTO v_current FROM public.section_class_incharges
   WHERE section_id = p_section_id AND semester_id = v_sem AND ended_at IS NULL FOR UPDATE;
  IF v_current.teacher_id = p_teacher_id THEN
    RAISE EXCEPTION 'That teacher is already the Class In-Charge of this section.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_current.id IS NOT NULL THEN
    UPDATE public.section_class_incharges
       SET ended_at = now(), ended_by = auth.uid(), end_reason = coalesce(v_reason, 'Replaced')
     WHERE id = v_current.id;
  END IF;

  INSERT INTO public.section_class_incharges (college_id, semester_id, section_id, teacher_id, assigned_by, assign_reason)
  VALUES (v_section.college_id, v_sem, p_section_id, p_teacher_id, auth.uid(), v_reason)
  RETURNING * INTO v_new;

  PERFORM public.academic_audit(v_section.college_id, 'class_incharge.assigned', 'section_class_incharges', v_new.id::text,
    CASE WHEN v_current.id IS NOT NULL THEN jsonb_build_object('teacher_id', v_current.teacher_id) END,
    jsonb_build_object('section_id', p_section_id, 'semester_id', v_sem, 'teacher_id', p_teacher_id, 'reason', v_reason));
  PERFORM public.academic_notify(v_section.college_id, p_teacher_id, 'You are a Class In-Charge',
    'You are now the Class In-Charge of ' || v_section.programme_code || ' ' || v_section.name || ' (' || v_section.batch_year || ').', '/teacher/class');
  IF v_current.id IS NOT NULL THEN
    PERFORM public.academic_notify(v_section.college_id, v_current.teacher_id, 'Class In-Charge changed',
      'You are no longer the Class In-Charge of ' || v_section.programme_code || ' ' || v_section.name || ' (' || v_section.batch_year || ').');
  END IF;

  RETURN to_jsonb(v_new);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.end_class_incharge(p_section_id uuid, p_reason text)
RETURNS void AS $$
DECLARE
  v_role    text := public.academic_actor_role();
  v_college uuid;
  v_sem     uuid;
  v_current public.section_class_incharges;
  v_reason  text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT college_id INTO v_college FROM public.sections
   WHERE id = p_section_id AND college_id = public.my_operational_college_id();
  IF v_college IS NULL OR NOT public.can_manage_department(public.section_department_id(p_section_id)) THEN
    RAISE EXCEPTION 'Only the HOD of the section''s department can change its Class In-Charge.'
      USING ERRCODE = '42501';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required.' USING ERRCODE = 'check_violation';
  END IF;
  v_sem := public.active_semester_id(v_college);
  PERFORM pg_advisory_xact_lock(hashtextextended('class_incharge:' || p_section_id::text || ':' || coalesce(v_sem::text, ''), 0));
  SELECT * INTO v_current FROM public.section_class_incharges
   WHERE section_id = p_section_id AND semester_id = v_sem AND ended_at IS NULL FOR UPDATE;
  IF v_current.id IS NULL THEN
    RAISE EXCEPTION 'This section has no current Class In-Charge.' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.section_class_incharges SET ended_at = now(), ended_by = auth.uid(), end_reason = v_reason
   WHERE id = v_current.id;
  PERFORM public.academic_audit(v_college, 'class_incharge.ended', 'section_class_incharges', v_current.id::text,
    jsonb_build_object('teacher_id', v_current.teacher_id), jsonb_build_object('reason', v_reason));
  PERFORM public.academic_notify(v_college, v_current.teacher_id, 'Class In-Charge changed',
    'You are no longer the Class In-Charge of a section you led.');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

-- ────────────────────────────────────────────────────────────
-- §11. External teaching authorizations (decision 4). Granted by the
--      OWNING department — the department whose courses will be taught.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.grant_external_teaching(p_department_id uuid, p_teacher_id uuid, p_reason text)
RETURNS jsonb AS $$
DECLARE
  v_role   text := public.academic_actor_role();
  v_dept   record;
  v_row    public.external_teaching_authorizations;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF NOT public.can_manage_department(p_department_id) THEN
    RAISE EXCEPTION 'Only the HOD of this department can authorize external teachers for its courses.'
      USING ERRCODE = '42501';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_dept FROM public.departments WHERE id = p_department_id;
  IF NOT EXISTS (SELECT 1 FROM public.profiles
                 WHERE id = p_teacher_id AND college_id = v_dept.college_id AND status = 'active' AND role IN ('teacher', 'hod')) THEN
    RAISE EXCEPTION 'Only an active teacher of your college can be authorized.' USING ERRCODE = 'check_violation';
  END IF;
  IF public.is_department_staff(p_teacher_id, p_department_id) THEN
    RAISE EXCEPTION 'That teacher already belongs to this department.' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.external_teaching_authorizations
             WHERE department_id = p_department_id AND teacher_id = p_teacher_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'That teacher is already authorized for this department.' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.external_teaching_authorizations (college_id, department_id, teacher_id, reason, granted_by)
  VALUES (v_dept.college_id, p_department_id, p_teacher_id, v_reason, auth.uid())
  RETURNING * INTO v_row;

  PERFORM public.academic_audit(v_dept.college_id, 'external_teaching.granted', 'external_teaching_authorizations', v_row.id::text,
    NULL, jsonb_build_object('department_id', p_department_id, 'teacher_id', p_teacher_id, 'reason', v_reason));
  PERFORM public.academic_notify(v_dept.college_id, p_teacher_id, 'Teaching authorization granted',
    'You may now be assigned to teach ' || v_dept.name || ' courses.', '/teacher/courses');
  RETURN to_jsonb(v_row);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.revoke_external_teaching(p_authorization_id uuid, p_reason text)
RETURNS void AS $$
DECLARE
  v_role   text := public.academic_actor_role();
  v_row    public.external_teaching_authorizations;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO v_row FROM public.external_teaching_authorizations
   WHERE id = p_authorization_id AND college_id = public.my_operational_college_id() FOR UPDATE;
  IF v_row.id IS NULL OR NOT public.can_manage_department(v_row.department_id) THEN
    RAISE EXCEPTION 'Only the HOD of the authorizing department can revoke this.' USING ERRCODE = '42501';
  END IF;
  IF v_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'This authorization has already been revoked.' USING ERRCODE = 'check_violation';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required.' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.course_offerings o
    JOIN public.courses c ON c.id = o.course_id
    JOIN public.semesters s ON s.id = o.semester_id
    WHERE c.department_id = v_row.department_id
      AND o.instructor_id = v_row.teacher_id
      AND o.status IN ('planned', 'active')
      AND s.status IN ('planned', 'active')
  ) THEN
    RAISE EXCEPTION 'This teacher still teaches an open offering of the department. Reassign it first.'
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.external_teaching_authorizations
     SET revoked_at = now(), revoked_by = auth.uid(), revoke_reason = v_reason
   WHERE id = v_row.id;
  PERFORM public.academic_audit(v_row.college_id, 'external_teaching.revoked', 'external_teaching_authorizations', v_row.id::text,
    jsonb_build_object('teacher_id', v_row.teacher_id), jsonb_build_object('reason', v_reason));
  PERFORM public.academic_notify(v_row.college_id, v_row.teacher_id, 'Teaching authorization revoked',
    'An external teaching authorization you held was revoked.');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

-- ────────────────────────────────────────────────────────────
-- §12. Student section assignments.
-- ────────────────────────────────────────────────────────────

-- Reconciliation: place a student who has NO current section. A student who
-- already has one changes section only through PR 2's approval workflow.
CREATE OR REPLACE FUNCTION public.assign_student_section(p_student_id uuid, p_section_id uuid, p_reason text)
RETURNS jsonb AS $$
DECLARE
  v_role     text := public.academic_actor_role();
  v_student  record;
  v_dept     uuid;
  v_sem      uuid;
  v_row      public.student_section_assignments;
  v_reason   text := btrim(coalesce(p_reason, ''));
  v_enrolled integer := 0;
  r          record;
BEGIN
  SELECT * INTO v_student FROM public.students
   WHERE id = p_student_id AND college_id = public.my_operational_college_id();
  IF v_student.id IS NULL THEN
    RAISE EXCEPTION 'Student not found in your college.' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (v_role = 'admin'
          OR (v_role = 'hod' AND EXISTS (SELECT 1 FROM public.departments WHERE id = v_student.department_id AND hod_id = auth.uid()))) THEN
    RAISE EXCEPTION 'Only the HOD of the student''s department can place them in a section.' USING ERRCODE = '42501';
  END IF;
  IF v_student.status IN ('graduated', 'dropped') THEN
    RAISE EXCEPTION 'A % student cannot be placed in a section.', v_student.status USING ERRCODE = 'check_violation';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required.' USING ERRCODE = 'check_violation';
  END IF;
  v_dept := public.section_department_id(p_section_id);
  IF v_dept IS NULL OR v_dept <> v_student.department_id THEN
    RAISE EXCEPTION 'A student can only be placed in a section of their own department.' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('student_academic:' || p_student_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.student_section_assignments WHERE student_id = p_student_id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'This student already has a section. A change of section goes through a section change request.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_sem := public.active_semester_id(v_student.college_id);
  INSERT INTO public.student_section_assignments
    (college_id, student_id, section_id, started_semester_id, start_source, start_reason, assigned_by)
  VALUES (v_student.college_id, p_student_id, p_section_id, v_sem, 'reconciliation', v_reason, auth.uid())
  RETURNING * INTO v_row;

  IF v_sem IS NOT NULL THEN
    FOR r IN SELECT id FROM public.course_offerings WHERE section_id = p_section_id AND semester_id = v_sem LOOP
      v_enrolled := v_enrolled + public.enroll_section_into_offering(r.id);
    END LOOP;
  END IF;

  PERFORM public.academic_audit(v_student.college_id, 'student_section.assigned', 'student_section_assignments', v_row.id::text,
    NULL, jsonb_build_object('student_id', p_student_id, 'section_id', p_section_id, 'reason', v_reason, 'enrollments_created', v_enrolled));
  PERFORM public.academic_notify(v_student.college_id, v_student.user_id, 'Your section',
    'You have been placed in your section. Your timetable now shows its classes.', '/student/schedule');
  RETURN to_jsonb(v_row) || jsonb_build_object('enrollments_created', v_enrolled);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

-- The reconciliation list: department students with no current section.
CREATE OR REPLACE FUNCTION public.students_without_section(p_department_id uuid)
RETURNS TABLE (student_id uuid, user_id uuid, full_name text, enrollment_number text, batch_year integer, semester integer, status text) AS $$
BEGIN
  PERFORM public.academic_actor_role();
  IF NOT public.can_manage_department(p_department_id) THEN
    RAISE EXCEPTION 'You can only view students of a department you manage.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT st.id, st.user_id, pr.full_name, st.enrollment_number, st.batch_year, st.semester, st.status
    FROM public.students st
    JOIN public.profiles pr ON pr.id = st.user_id
    WHERE st.department_id = p_department_id
      AND st.status NOT IN ('graduated', 'dropped')
      AND NOT EXISTS (SELECT 1 FROM public.student_section_assignments a WHERE a.student_id = st.id AND a.ended_at IS NULL)
    ORDER BY st.batch_year DESC, st.enrollment_number;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- "Which section(s) was this student in during term T?" — intervals that
-- overlap the term's dates. SECURITY INVOKER: the caller's RLS decides
-- whether they may see the student at all.
CREATE OR REPLACE FUNCTION public.student_section_at(p_student_id uuid, p_semester_id uuid)
RETURNS TABLE (section_id uuid, started_at timestamptz, ended_at timestamptz) AS $$
  SELECT a.section_id, a.started_at, a.ended_at
  FROM public.student_section_assignments a
  JOIN public.semesters s ON s.id = p_semester_id
  WHERE a.student_id = p_student_id
    AND a.started_at < (s.end_date + 1)::timestamptz
    AND (a.ended_at IS NULL OR a.ended_at >= s.start_date::timestamptz)
  ORDER BY a.started_at;
$$ LANGUAGE sql STABLE SET search_path = public, pg_catalog;

-- ────────────────────────────────────────────────────────────
-- §13. Timetable (decision 6).
-- ────────────────────────────────────────────────────────────

-- Conflicts are checked for EVERY caller, the service role included: a
-- double-booked room is wrong however it got there. Term-scoped and
-- overlap-aware (047's index only caught identical start times).
CREATE OR REPLACE FUNCTION public.guard_timetable_slot()
RETURNS trigger AS $$
DECLARE
  v_off   record;
  v_clash text;
  v_other record;
BEGIN
  IF NEW.end_time <= NEW.start_time THEN
    RAISE EXCEPTION 'A class must end after it starts.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT o.*, sem.status AS semester_status INTO v_off
  FROM public.course_offerings o JOIN public.semesters sem ON sem.id = o.semester_id
  WHERE o.id = NEW.offering_id;

  IF auth.uid() IS NOT NULL THEN
    IF v_off.status NOT IN ('planned', 'active') THEN
      RAISE EXCEPTION 'Only a planned or active offering can be scheduled.' USING ERRCODE = 'check_violation';
    END IF;
    IF v_off.semester_status NOT IN ('planned', 'active') THEN
      RAISE EXCEPTION 'A closed term''s timetable is part of its history and cannot change.' USING ERRCODE = 'check_violation';
    END IF;
    IF v_off.instructor_id IS NULL THEN
      RAISE EXCEPTION 'Assign a teacher to the offering before scheduling it.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('timetable:' || v_off.semester_id::text, 0));

  IF v_off.instructor_id IS NOT NULL THEN
    v_clash := public.timetable_teacher_clash(NEW.offering_id, v_off.instructor_id, NEW.day_of_week, NEW.start_time, NEW.end_time,
                                              CASE WHEN TG_OP = 'UPDATE' THEN NEW.id END);
    IF v_clash IS NOT NULL THEN
      RAISE EXCEPTION 'Teacher conflict: %', v_clash USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT c.code, to_char(t.start_time, 'HH24:MI') AS s, to_char(t.end_time, 'HH24:MI') AS e INTO v_other
  FROM public.timetable_slots t
  JOIN public.course_offerings o ON o.id = t.offering_id
  JOIN public.courses c ON c.id = o.course_id
  WHERE o.semester_id = v_off.semester_id AND o.section_id = v_off.section_id AND o.status <> 'cancelled'
    AND t.day_of_week = NEW.day_of_week AND t.start_time < NEW.end_time AND NEW.start_time < t.end_time
    AND t.id <> NEW.id
  LIMIT 1;
  IF v_other.code IS NOT NULL THEN
    RAISE EXCEPTION 'Section conflict: the section already has % %–% on that day.', v_other.code, v_other.s, v_other.e
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.room IS NOT NULL AND btrim(NEW.room) <> '' THEN
    SELECT c.code, to_char(t.start_time, 'HH24:MI') AS s, to_char(t.end_time, 'HH24:MI') AS e INTO v_other
    FROM public.timetable_slots t
    JOIN public.course_offerings o ON o.id = t.offering_id
    JOIN public.courses c ON c.id = o.course_id
    WHERE o.semester_id = v_off.semester_id AND o.status <> 'cancelled'
      AND lower(btrim(t.room)) = lower(btrim(NEW.room))
      AND t.day_of_week = NEW.day_of_week AND t.start_time < NEW.end_time AND NEW.start_time < t.end_time
      AND t.id <> NEW.id
    LIMIT 1;
    IF v_other.code IS NOT NULL THEN
      RAISE EXCEPTION 'Room conflict: % is booked for % %–% on that day.', NEW.room, v_other.code, v_other.s, v_other.e
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

DROP TRIGGER IF EXISTS guard_timetable_slot ON public.timetable_slots;
CREATE TRIGGER guard_timetable_slot BEFORE INSERT OR UPDATE ON public.timetable_slots
  FOR EACH ROW EXECUTE FUNCTION public.guard_timetable_slot();

-- The authority to schedule an offering: whoever manages its course's
-- (owning) department — the same department that creates the offering.
CREATE OR REPLACE FUNCTION public.can_schedule_offering(p_offering_id uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.course_offerings o JOIN public.courses c ON c.id = o.course_id
    WHERE o.id = p_offering_id
      AND o.college_id = public.my_operational_college_id()
      AND public.can_manage_department(c.department_id)
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.create_timetable_slot(p_offering_id uuid, p_day integer, p_start time, p_end time, p_room text)
RETURNS uuid AS $$
DECLARE
  v_role text := public.academic_actor_role();
  v_row  public.timetable_slots;
BEGIN
  IF NOT public.can_schedule_offering(p_offering_id) THEN
    RAISE EXCEPTION 'Only the HOD of the course''s department can schedule this offering.' USING ERRCODE = '42501';
  END IF;
  IF p_day IS NULL OR p_day NOT BETWEEN 0 AND 6 THEN
    RAISE EXCEPTION 'Choose a valid day of the week.' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.timetable_slots (college_id, offering_id, day_of_week, start_time, end_time, room)
  SELECT o.college_id, o.id, p_day, p_start, p_end, nullif(btrim(coalesce(p_room, '')), '')
  FROM public.course_offerings o WHERE o.id = p_offering_id
  RETURNING * INTO v_row;
  PERFORM public.academic_audit(v_row.college_id, 'timetable.slot_created', 'timetable_slots', v_row.id::text, NULL, to_jsonb(v_row));
  RETURN v_row.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.update_timetable_slot(p_slot_id uuid, p_day integer, p_start time, p_end time, p_room text)
RETURNS void AS $$
DECLARE
  v_role text := public.academic_actor_role();
  v_old  public.timetable_slots;
  v_new  public.timetable_slots;
BEGIN
  SELECT * INTO v_old FROM public.timetable_slots WHERE id = p_slot_id FOR UPDATE;
  IF v_old.id IS NULL OR NOT public.can_schedule_offering(v_old.offering_id) THEN
    RAISE EXCEPTION 'Only the HOD of the course''s department can change this class.' USING ERRCODE = '42501';
  END IF;
  IF p_day IS NULL OR p_day NOT BETWEEN 0 AND 6 THEN
    RAISE EXCEPTION 'Choose a valid day of the week.' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.timetable_slots
     SET day_of_week = p_day, start_time = p_start, end_time = p_end, room = nullif(btrim(coalesce(p_room, '')), '')
   WHERE id = p_slot_id
  RETURNING * INTO v_new;
  PERFORM public.academic_audit(v_new.college_id, 'timetable.slot_updated', 'timetable_slots', v_new.id::text, to_jsonb(v_old), to_jsonb(v_new));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.delete_timetable_slot(p_slot_id uuid)
RETURNS void AS $$
DECLARE
  v_role text := public.academic_actor_role();
  v_old  public.timetable_slots;
  v_term text;
BEGIN
  SELECT * INTO v_old FROM public.timetable_slots WHERE id = p_slot_id FOR UPDATE;
  IF v_old.id IS NULL OR NOT public.can_schedule_offering(v_old.offering_id) THEN
    RAISE EXCEPTION 'Only the HOD of the course''s department can remove this class.' USING ERRCODE = '42501';
  END IF;
  SELECT s.status INTO v_term FROM public.course_offerings o JOIN public.semesters s ON s.id = o.semester_id
  WHERE o.id = v_old.offering_id;
  IF v_term NOT IN ('planned', 'active') THEN
    RAISE EXCEPTION 'A closed term''s timetable is part of its history and cannot change.' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM public.timetable_slots WHERE id = p_slot_id;
  PERFORM public.academic_audit(v_old.college_id, 'timetable.slot_deleted', 'timetable_slots', v_old.id::text, to_jsonb(v_old), NULL);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

-- Defect 2, database half. Staff keep 006's college-wide read; a student
-- (or a legacy parent) reads only the slots of offerings they — or their
-- child — are enrolled in.
--
-- PERFORMANCE (measured with pgbench on real PostgreSQL, 3,000 students):
-- the first version returned SETOF uuid with an OR between the student and
-- parent cases. The OR defeated the index on students.user_id and the set
-- was planned per row: the student timetable read went from ~726 to ~37
-- transactions/second. Now the two cases are separate branches (the parent
-- one is a one-time filter on the caller's role), the answer is ONE array,
-- and both policies use 053's initplan form, so each helper runs once per
-- statement, not once per row.
CREATE OR REPLACE FUNCTION public.my_timetable_offering_ids()
RETURNS uuid[] AS $$
  SELECT coalesce(array_agg(DISTINCT q.offering_id), '{}'::uuid[])
  FROM (
    SELECT e.offering_id
    FROM public.course_enrollments e
    JOIN public.students s ON s.id = e.student_id
    WHERE s.user_id = auth.uid()
    UNION ALL
    SELECT e.offering_id
    FROM public.course_enrollments e
    JOIN public.students s ON s.id = e.student_id
    WHERE public.get_my_role() = 'parent' AND s.parent_email = public.get_my_email()
  ) q;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

DROP POLICY IF EXISTS "timetable_read" ON public.timetable_slots;
DROP POLICY IF EXISTS "timetable_read_staff" ON public.timetable_slots;
CREATE POLICY "timetable_read_staff" ON public.timetable_slots
  FOR SELECT USING (
    college_id = (SELECT public.get_my_college_id())
    AND (SELECT public.get_my_role()) NOT IN ('student', 'parent')
  );
DROP POLICY IF EXISTS "timetable_read_enrolled" ON public.timetable_slots;
CREATE POLICY "timetable_read_enrolled" ON public.timetable_slots
  FOR SELECT USING (
    (SELECT public.get_my_role()) IN ('student', 'parent')
    AND offering_id = ANY ((SELECT public.my_timetable_offering_ids())::uuid[])
  );

-- ────────────────────────────────────────────────────────────
-- §14. Student invitations (decision 3; defects 1 and 3).
-- ────────────────────────────────────────────────────────────

-- Defect 3. The invitee could UPDATE every column of their own invitation
-- row (019: USING user_id = auth.uid(), no WITH CHECK, no column limit).
-- Acceptance never needed it — acceptInvitation() marks the row accepted
-- through the service role, and accept_student_invitation() below does it
-- as a definer — so the policy goes entirely.
DROP POLICY IF EXISTS "invitations_update_by_invitee" ON public.invitations;

-- The invitation tier, as 051 left it, plus ONE relationship-scoped grant:
-- a teacher may invite a student only while they are the current Class
-- In-Charge of some section. WHICH section is decided per invitation by
-- create_student_invitation_placement() — this only opens the door.
CREATE OR REPLACE FUNCTION public.can_invite_role(p_target TEXT)
RETURNS BOOLEAN AS $$
  SELECT CASE public.get_my_role()
    WHEN 'super_admin' THEN p_target = 'admin'
    WHEN 'admin'       THEN p_target = 'director'
    WHEN 'director'    THEN p_target IN ('finance','hod','warden','placement_cell','gate_security')
    WHEN 'hod'         THEN p_target IN ('teacher','student')
    WHEN 'teacher'     THEN p_target = 'student' AND EXISTS (
                              SELECT 1 FROM public.section_class_incharges ci
                              JOIN public.semesters s ON s.id = ci.semester_id AND s.status = 'active'
                              WHERE ci.teacher_id = auth.uid() AND ci.ended_at IS NULL)
    ELSE false
  END;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- The one placement check, shared by preflight and placement creation.
-- Everything is resolved from the section; the caller's own department
-- claim is never consulted.
CREATE OR REPLACE FUNCTION public.student_placement_check(p_section_id uuid, p_enrollment_number text, p_programme_semester integer)
RETURNS jsonb AS $$
DECLARE
  v_role    text := public.academic_actor_role();
  v_college uuid := public.my_operational_college_id();
  v_sec     record;
  v_sem     record;
  v_enr     text := btrim(coalesce(p_enrollment_number, ''));
  v_heads   boolean;
  v_incharge boolean;
BEGIN
  IF v_role NOT IN ('hod', 'teacher') THEN
    RAISE EXCEPTION 'Only an HOD or a Class In-Charge can invite students.' USING ERRCODE = '42501';
  END IF;
  SELECT s.id, s.name, s.batch_year, s.status, s.college_id, p.id AS programme_id, p.code AS programme_code,
         p.department_id, p.duration_semesters, p.status AS programme_status
    INTO v_sec
  FROM public.sections s JOIN public.programmes p ON p.id = s.programme_id
  WHERE s.id = p_section_id AND s.college_id = v_college;
  IF v_sec.id IS NULL THEN
    RAISE EXCEPTION 'Section not found in your college.' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO v_sem FROM public.semesters WHERE college_id = v_college AND status = 'active';
  IF v_sem.id IS NULL THEN
    RAISE EXCEPTION 'Students can be invited only while the college has an active term.' USING ERRCODE = 'check_violation';
  END IF;

  -- Both are coalesced: "no In-Charge" is NULL, and NOT (false OR NULL) is
  -- NULL, which an IF treats as "do not refuse". A regression test pins it.
  v_heads := coalesce(v_role = 'hod' AND EXISTS (SELECT 1 FROM public.departments WHERE id = v_sec.department_id AND hod_id = auth.uid()), false);
  v_incharge := coalesce(public.current_class_incharge(p_section_id, v_sem.id) = auth.uid(), false);
  IF NOT (v_heads OR v_incharge) THEN
    RAISE EXCEPTION 'You can invite students only into your own department''s sections (HOD) or your own section (Class In-Charge).'
      USING ERRCODE = '42501';
  END IF;
  IF v_sec.status <> 'active' OR v_sec.programme_status <> 'active' THEN
    RAISE EXCEPTION 'That section is not accepting students.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_enr = '' OR length(v_enr) > 50 THEN
    RAISE EXCEPTION 'Enter an enrollment number (up to 50 characters).' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.students WHERE college_id = v_college AND lower(enrollment_number) = lower(v_enr))
     OR EXISTS (SELECT 1 FROM public.student_invitation_placements pl
                JOIN public.invitations i ON i.id = pl.invitation_id
                WHERE pl.college_id = v_college AND pl.consumed_at IS NULL AND i.status = 'pending'
                  AND lower(pl.enrollment_number) = lower(v_enr)) THEN
    RAISE EXCEPTION 'That enrollment number is already in use.' USING ERRCODE = 'unique_violation';
  END IF;
  IF p_programme_semester IS NULL OR p_programme_semester < 1 OR p_programme_semester > v_sec.duration_semesters THEN
    RAISE EXCEPTION 'The programme semester must be between 1 and %.', v_sec.duration_semesters USING ERRCODE = 'check_violation';
  END IF;

  RETURN jsonb_build_object(
    'college_id', v_college, 'department_id', v_sec.department_id, 'programme_id', v_sec.programme_id,
    'section_id', v_sec.id, 'semester_id', v_sem.id, 'batch_year', v_sec.batch_year,
    'enrollment_number', v_enr, 'programme_semester', p_programme_semester,
    'section_label', v_sec.programme_code || ' ' || v_sec.name || ' (' || v_sec.batch_year || ')');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- Read-only preflight, called BEFORE any account is created, so an invalid
-- placement never leaves a half-created invitee behind (defect 1).
CREATE OR REPLACE FUNCTION public.student_invitation_preflight(p_section_id uuid, p_enrollment_number text, p_programme_semester integer)
RETURNS jsonb AS $$
  SELECT public.student_placement_check(p_section_id, p_enrollment_number, p_programme_semester);
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.create_student_invitation_placement(
  p_invitation_id uuid, p_section_id uuid, p_enrollment_number text, p_programme_semester integer,
  p_parent_name text DEFAULT NULL, p_parent_email text DEFAULT NULL, p_parent_phone text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_check jsonb := public.student_placement_check(p_section_id, p_enrollment_number, p_programme_semester);
  v_inv   record;
  v_row   public.student_invitation_placements;
BEGIN
  SELECT * INTO v_inv FROM public.invitations WHERE id = p_invitation_id FOR UPDATE;
  IF v_inv.id IS NULL OR v_inv.invited_by <> auth.uid() OR v_inv.college_id <> (v_check->>'college_id')::uuid THEN
    RAISE EXCEPTION 'Invitation not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_inv.role IS DISTINCT FROM 'student' OR v_inv.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'Only a pending student invitation can be given a placement.' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.student_invitation_placements WHERE invitation_id = p_invitation_id) THEN
    RAISE EXCEPTION 'This invitation already has a placement.' USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO public.student_invitation_placements
    (invitation_id, college_id, department_id, programme_id, section_id, semester_id, programme_semester,
     enrollment_number, parent_name, parent_email, parent_phone, invited_by)
  VALUES (p_invitation_id, (v_check->>'college_id')::uuid, (v_check->>'department_id')::uuid, (v_check->>'programme_id')::uuid,
          p_section_id, (v_check->>'semester_id')::uuid, p_programme_semester, v_check->>'enrollment_number',
          nullif(btrim(coalesce(p_parent_name, '')), ''), nullif(btrim(coalesce(p_parent_email, '')), ''),
          nullif(btrim(coalesce(p_parent_phone, '')), ''), auth.uid())
  RETURNING * INTO v_row;

  -- The invitation's department is the RESOLVED one, whatever the caller
  -- wrote when inserting the bookkeeping row.
  UPDATE public.invitations SET department_id = v_row.department_id WHERE id = p_invitation_id;

  PERFORM public.academic_audit(v_row.college_id, 'student_invitation.placed', 'student_invitation_placements', p_invitation_id::text,
    NULL, jsonb_build_object('section_id', p_section_id, 'department_id', v_row.department_id,
                             'programme_semester', p_programme_semester, 'enrollment_number', v_row.enrollment_number));
  RETURN to_jsonb(v_row) || jsonb_build_object('section_label', v_check->>'section_label');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

-- Acceptance, called by the still-PENDING invitee. One transaction creates
-- the student record, opens the section assignment, enrols the student,
-- activates the profile, marks the invitation accepted and consumes the
-- placement — so a failure anywhere leaves nothing half-done.
--
-- A pending account is refused by 053/054's write gate, so this one
-- function opens the sanctioned channel app.academic_service (§16) for its
-- own transaction, exactly as 054's session functions do.
CREATE OR REPLACE FUNCTION public.accept_student_invitation(p_invitation_id uuid)
RETURNS jsonb AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_inv      record;
  v_profile  record;
  v_pl       public.student_invitation_placements;
  v_section  record;
  v_student  uuid;
  v_sem      uuid;
  v_enrolled integer := 0;
  r          record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Your session has expired. Open the invitation email link again.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_inv FROM public.invitations WHERE id = p_invitation_id FOR UPDATE;
  IF v_inv.id IS NULL OR v_inv.user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'No pending invitation found for this account.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_inv.status <> 'pending' THEN
    RAISE EXCEPTION 'This invitation is no longer valid (%).', v_inv.status USING ERRCODE = 'check_violation';
  END IF;
  IF v_inv.expires_at < now() THEN
    RAISE EXCEPTION 'This invitation has expired. Ask whoever invited you to resend it.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_inv.role <> 'student' THEN
    RAISE EXCEPTION 'This is not a student invitation.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = v_uid;
  IF v_profile.id IS NULL OR v_profile.status IS DISTINCT FROM 'pending' OR v_profile.role IS DISTINCT FROM 'student'
     OR v_profile.college_id IS DISTINCT FROM v_inv.college_id THEN
    RAISE EXCEPTION 'This invitation has already been accepted — sign in normally instead.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.colleges WHERE id = v_inv.college_id AND lifecycle_state = 'ACTIVE') THEN
    RAISE EXCEPTION 'Your college is currently unavailable. Try again later.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_pl FROM public.student_invitation_placements WHERE invitation_id = p_invitation_id FOR UPDATE;
  IF v_pl.invitation_id IS NULL OR v_pl.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'This invitation has no class placement. Ask whoever invited you to send a new invitation.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT s.*, p.department_id INTO v_section
  FROM public.sections s JOIN public.programmes p ON p.id = s.programme_id WHERE s.id = v_pl.section_id;
  IF v_section.id IS NULL OR v_section.status IS DISTINCT FROM 'active' OR v_section.department_id IS DISTINCT FROM v_pl.department_id THEN
    RAISE EXCEPTION 'The class you were invited to is no longer accepting students. Ask whoever invited you to send a new invitation.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.academic_service', 'on', true);

  BEGIN
    INSERT INTO public.students (college_id, user_id, department_id, enrollment_number, batch_year, semester,
                                 admission_date, parent_name, parent_email, parent_phone)
    VALUES (v_inv.college_id, v_uid, v_pl.department_id, v_pl.enrollment_number, v_section.batch_year, v_pl.programme_semester,
            current_date, v_pl.parent_name, v_pl.parent_email, v_pl.parent_phone)
    RETURNING id INTO v_student;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'That enrollment number is already in use. Ask whoever invited you to send a new invitation.'
      USING ERRCODE = 'unique_violation';
  END;

  v_sem := public.active_semester_id(v_inv.college_id);
  INSERT INTO public.student_section_assignments
    (college_id, student_id, section_id, started_semester_id, start_source, start_reason, assigned_by)
  VALUES (v_inv.college_id, v_student, v_pl.section_id, v_sem, 'invitation', 'Accepted invitation', v_pl.invited_by);

  IF v_sem IS NOT NULL THEN
    FOR r IN SELECT id FROM public.course_offerings WHERE section_id = v_pl.section_id AND semester_id = v_sem LOOP
      v_enrolled := v_enrolled + public.enroll_section_into_offering(r.id);
    END LOOP;
  END IF;

  UPDATE public.profiles SET status = 'active' WHERE id = v_uid;
  UPDATE public.invitations SET status = 'accepted', accepted_at = now(), accepted_by = v_uid WHERE id = p_invitation_id;
  UPDATE public.student_invitation_placements SET consumed_at = now(), consumed_student_id = v_student
   WHERE invitation_id = p_invitation_id;

  INSERT INTO public.audit_logs (college_id, user_id, action, table_name, record_id, new_value)
  VALUES (v_inv.college_id, v_uid, 'student_invitation.accepted', 'invitations', p_invitation_id::text,
          jsonb_build_object('student_id', v_student, 'section_id', v_pl.section_id, 'enrollments_created', v_enrolled));
  INSERT INTO public.notifications (college_id, title, message, receiver_id, sender_id, type, link)
  VALUES (v_inv.college_id, 'Invitation accepted',
          coalesce(v_profile.full_name, v_inv.email) || ' accepted your invitation and joined their section.',
          v_pl.invited_by, v_uid, 'success', NULL);

  PERFORM set_config('app.academic_service', '', true);

  RETURN jsonb_build_object('student_id', v_student, 'section_id', v_pl.section_id, 'enrollments_created', v_enrolled);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;

-- ────────────────────────────────────────────────────────────
-- §15. my_academic_context() — the caller's current academic state, the
--      ONE read both web and mobile use, so they cannot disagree.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.my_academic_context()
RETURNS jsonb AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_role    text := public.my_operational_role();
  v_college uuid := public.my_operational_college_id();
  v_term    jsonb;
  v_sem     record;
  v_out     jsonb;
  v_student record;
  v_section record;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN RETURN NULL; END IF;

  SELECT s.id, s.name, s.start_date, s.end_date, ay.name AS year_name, ay.start_date AS year_start
    INTO v_sem
  FROM public.semesters s LEFT JOIN public.academic_years ay ON ay.id = s.academic_year_id
  WHERE s.college_id = v_college AND s.status = 'active';
  v_term := CASE WHEN v_sem.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id', v_sem.id, 'name', v_sem.name, 'start_date', v_sem.start_date, 'end_date', v_sem.end_date,
    'academic_year', v_sem.year_name) END;
  v_out := jsonb_build_object('role', v_role, 'term', v_term);

  IF v_role = 'student' THEN
    SELECT st.id, st.enrollment_number, st.semester, st.status, d.id AS dept_id, d.name AS dept_name
      INTO v_student
    FROM public.students st JOIN public.departments d ON d.id = st.department_id
    WHERE st.user_id = v_uid;
    IF v_student.id IS NULL THEN RETURN v_out; END IF;

    SELECT s.id, s.name, s.batch_year, p.id AS programme_id, p.name AS programme_name, p.code AS programme_code
      INTO v_section
    FROM public.student_section_assignments a
    JOIN public.sections s ON s.id = a.section_id
    JOIN public.programmes p ON p.id = s.programme_id
    WHERE a.student_id = v_student.id AND a.ended_at IS NULL;

    v_out := v_out || jsonb_build_object(
      'student', jsonb_build_object('id', v_student.id, 'enrollment_number', v_student.enrollment_number,
        'programme_semester', v_student.semester, 'status', v_student.status,
        'department', jsonb_build_object('id', v_student.dept_id, 'name', v_student.dept_name)),
      'section', CASE WHEN v_section.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', v_section.id, 'name', v_section.name, 'batch_year', v_section.batch_year,
        'programme', jsonb_build_object('id', v_section.programme_id, 'name', v_section.programme_name, 'code', v_section.programme_code),
        'year_of_study', CASE WHEN v_sem.year_start IS NULL THEN NULL
                              ELSE extract(year FROM v_sem.year_start)::int - v_section.batch_year + 1 END,
        'class_incharge', (SELECT jsonb_build_object('id', pr.id, 'full_name', pr.full_name)
                           FROM public.profiles pr WHERE pr.id = public.current_class_incharge(v_section.id, v_sem.id))) END,
      'department_term', (SELECT dt.status FROM public.department_terms dt
                          WHERE dt.department_id = v_student.dept_id AND dt.semester_id = v_sem.id),
      'offering_ids', (SELECT coalesce(jsonb_agg(e.offering_id), '[]'::jsonb)
                       FROM public.course_enrollments e JOIN public.course_offerings o ON o.id = e.offering_id
                       WHERE e.student_id = v_student.id AND e.status = 'enrolled' AND o.semester_id = v_sem.id));
  ELSIF v_role IN ('teacher', 'hod') THEN
    v_out := v_out || jsonb_build_object(
      'offering_ids', (SELECT coalesce(jsonb_agg(o.id), '[]'::jsonb) FROM public.course_offerings o
                       WHERE o.instructor_id = v_uid AND o.semester_id = v_sem.id AND o.status <> 'cancelled'),
      'incharge_sections', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                               'section_id', s.id, 'name', s.name, 'batch_year', s.batch_year,
                               'programme_code', p.code, 'programme_name', p.name)
                             ORDER BY p.code, s.batch_year DESC, s.name), '[]'::jsonb)
                            FROM public.section_class_incharges ci
                            JOIN public.sections s ON s.id = ci.section_id
                            JOIN public.programmes p ON p.id = s.programme_id
                            WHERE ci.teacher_id = v_uid AND ci.semester_id = v_sem.id AND ci.ended_at IS NULL));
  END IF;
  RETURN v_out;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- ────────────────────────────────────────────────────────────
-- §16. 054's write gate plus one sanctioned channel, app.academic_service,
--      set transaction-locally only inside accept_student_invitation().
-- ────────────────────────────────────────────────────────────
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

  IF coalesce(current_setting('app.academic_service', true), '') = 'on' THEN
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
-- §17. RLS, gates and grants for the new tables.
--
-- Read policies only — there are NO write policies on any of them. Staff
-- reads follow 036's academic staff set (teacher, hod, director, admin).
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.department_terms                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.section_class_incharges         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_section_assignments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_hod_assignments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offering_instructor_history     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_teaching_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_invitation_placements   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "department_terms_read" ON public.department_terms;
CREATE POLICY "department_terms_read" ON public.department_terms
  FOR SELECT USING (college_id = public.get_my_college_id());

DROP POLICY IF EXISTS "class_incharges_read" ON public.section_class_incharges;
CREATE POLICY "class_incharges_read" ON public.section_class_incharges
  FOR SELECT USING (college_id = public.get_my_college_id());

DROP POLICY IF EXISTS "student_sections_read_own" ON public.student_section_assignments;
CREATE POLICY "student_sections_read_own" ON public.student_section_assignments
  FOR SELECT USING (EXISTS (SELECT 1 FROM public.students s WHERE s.id = student_section_assignments.student_id AND s.user_id = auth.uid()));
DROP POLICY IF EXISTS "student_sections_read_staff" ON public.student_section_assignments;
CREATE POLICY "student_sections_read_staff" ON public.student_section_assignments
  FOR SELECT USING (college_id = public.get_my_college_id() AND public.get_my_role() IN ('teacher', 'hod', 'director', 'admin'));

DROP POLICY IF EXISTS "hod_history_read" ON public.department_hod_assignments;
CREATE POLICY "hod_history_read" ON public.department_hod_assignments
  FOR SELECT USING (college_id = public.get_my_college_id() AND public.get_my_role() IN ('teacher', 'hod', 'director', 'admin'));

DROP POLICY IF EXISTS "instructor_history_read" ON public.offering_instructor_history;
CREATE POLICY "instructor_history_read" ON public.offering_instructor_history
  FOR SELECT USING (college_id = public.get_my_college_id() AND public.get_my_role() IN ('teacher', 'hod', 'director', 'admin'));

DROP POLICY IF EXISTS "external_teaching_read" ON public.external_teaching_authorizations;
CREATE POLICY "external_teaching_read" ON public.external_teaching_authorizations
  FOR SELECT USING (college_id = public.get_my_college_id() AND public.get_my_role() IN ('teacher', 'hod', 'director', 'admin'));

DROP POLICY IF EXISTS "placements_read" ON public.student_invitation_placements;
CREATE POLICY "placements_read" ON public.student_invitation_placements
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND (
      invited_by = auth.uid()
      OR public.get_my_role() IN ('admin', 'director')
      OR (public.get_my_role() = 'hod'
          AND EXISTS (SELECT 1 FROM public.departments d WHERE d.id = student_invitation_placements.department_id AND d.hod_id = auth.uid()))
    )
  );

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['department_terms', 'section_class_incharges', 'student_section_assignments',
                           'department_hod_assignments', 'offering_instructor_history',
                           'external_teaching_authorizations', 'student_invitation_placements'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_access_gate ON public.%I', t);
    EXECUTE format('CREATE POLICY tenant_access_gate ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
                   'USING ((SELECT public.app_access_allowed())) WITH CHECK ((SELECT public.app_access_allowed()))', t);
    EXECUTE format('DROP TRIGGER IF EXISTS guard_tenant_write_access ON public.%I', t);
    EXECUTE format('CREATE TRIGGER guard_tenant_write_access BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION public.guard_tenant_write_access()', t);
  END LOOP;
END $$;

-- 054 keeps user_sessions OUT of the write gate (its functions must work for
-- a refused session). On a first apply 053 runs before user_sessions exists,
-- but REPLAYING 053 attaches the gate to every RLS table, user_sessions
-- included. Restating 054's intent here makes a replayed chain converge.
DROP TRIGGER IF EXISTS guard_tenant_write_access ON public.user_sessions;

-- Internal helpers: not callable through PostgREST.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.academic_notify(uuid,uuid,text,text,text,text)',
    'public.academic_audit(uuid,text,text,text,jsonb,jsonb)',
    'public.enroll_section_into_offering(uuid)',
    'public.timetable_teacher_clash(uuid,uuid,integer,time,time,uuid)',
    'public.student_placement_check(uuid,text,integer)',
    'public.guard_academic_history()', 'public.guard_department_term_status()',
    'public.guard_student_section_assignment()', 'public.record_department_hod()',
    'public.record_offering_instructor()', 'public.guard_offering_assignment()',
    'public.offering_auto_enroll()', 'public.guard_offering_open_for_records()',
    'public.guard_enrollment_unique_course()', 'public.guard_academic_structure()',
    'public.audit_academic_structure()', 'public.end_department_terms_with_semester()',
    'public.guard_timetable_slot()', 'public.guard_academic_tenant()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.active_semester_id(uuid)', 'public.section_department_id(uuid)',
    'public.can_manage_department(uuid)', 'public.is_department_staff(uuid,uuid)',
    'public.instructor_eligible(uuid,uuid)', 'public.current_class_incharge(uuid,uuid)',
    'public.academic_actor_role()', 'public.department_term_readiness(uuid)',
    'public.start_department_term(uuid,boolean)', 'public.end_department_term(uuid,text)',
    'public.assign_class_incharge(uuid,uuid,text)', 'public.end_class_incharge(uuid,text)',
    'public.grant_external_teaching(uuid,uuid,text)', 'public.revoke_external_teaching(uuid,text)',
    'public.assign_student_section(uuid,uuid,text)', 'public.students_without_section(uuid)',
    'public.student_section_at(uuid,uuid)', 'public.can_schedule_offering(uuid)',
    'public.create_timetable_slot(uuid,integer,time,time,text)',
    'public.update_timetable_slot(uuid,integer,time,time,text)', 'public.delete_timetable_slot(uuid)',
    'public.my_timetable_offering_ids()', 'public.student_invitation_preflight(uuid,text,integer)',
    'public.create_student_invitation_placement(uuid,uuid,text,integer,text,text,text)',
    'public.accept_student_invitation(uuid)', 'public.my_academic_context()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────
-- §18. Backfill — derived from data that exists, nothing invented.
--
-- Runs as the migration role (auth.uid() NULL), so the service exemptions
-- above apply and no audit/notification rows are fabricated.
-- ────────────────────────────────────────────────────────────

-- HOD history: one open row per department that has an HOD today.
INSERT INTO public.department_hod_assignments (college_id, department_id, hod_id, source)
SELECT d.college_id, d.id, d.hod_id, 'backfill'
FROM public.departments d
WHERE d.hod_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.department_hod_assignments h WHERE h.department_id = d.id AND h.ended_at IS NULL);

-- Instructor history: the current instructor of every offering.
INSERT INTO public.offering_instructor_history (college_id, offering_id, instructor_id, source, started_at)
SELECT o.college_id, o.id, o.instructor_id, 'backfill', o.created_at
FROM public.course_offerings o
WHERE o.instructor_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.offering_instructor_history h WHERE h.offering_id = o.id AND h.ended_at IS NULL);

-- Department terms: a department that already has (non-cancelled) offerings
-- of its own courses in the active college term is already operating in it.
INSERT INTO public.department_terms (college_id, department_id, semester_id, status, start_source, started_at)
SELECT DISTINCT d.college_id, d.id, s.id, 'active', 'backfill', now()
FROM public.departments d
JOIN public.semesters s ON s.college_id = d.college_id AND s.status = 'active'
WHERE EXISTS (
  SELECT 1 FROM public.course_offerings o JOIN public.courses c ON c.id = o.course_id
  WHERE o.semester_id = s.id AND c.department_id = d.id AND o.status <> 'cancelled'
)
ON CONFLICT (department_id, semester_id) DO NOTHING;

-- Student sections: only where the student's enrolled active-term offerings
-- all point to exactly ONE section of their own department. Everyone else
-- appears on students_without_section() for an explicit decision.
INSERT INTO public.student_section_assignments (college_id, student_id, section_id, started_semester_id, start_source, start_reason)
SELECT st.college_id, st.id, min(o.section_id::text)::uuid, sem.id, 'backfill',
       'Derived from the student''s enrolments in the active term (migration 055)'
FROM public.students st
JOIN public.course_enrollments e ON e.student_id = st.id AND e.status = 'enrolled'
JOIN public.course_offerings o ON o.id = e.offering_id
JOIN public.semesters sem ON sem.id = o.semester_id AND sem.status = 'active'
WHERE NOT EXISTS (SELECT 1 FROM public.student_section_assignments a WHERE a.student_id = st.id AND a.ended_at IS NULL)
GROUP BY st.college_id, st.id, st.department_id, sem.id
HAVING count(DISTINCT o.section_id) = 1
   AND public.section_department_id(min(o.section_id::text)::uuid) = st.department_id
   AND EXISTS (SELECT 1 FROM public.sections s WHERE s.id = min(o.section_id::text)::uuid AND s.status = 'active');

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
--   SELECT count(*) FROM public.department_hod_assignments WHERE ended_at IS NULL;  -- = departments with hod_id
--   SELECT count(*) FROM public.department_terms;                                     -- departments operating now
--   SELECT * FROM public.students_without_section('<dept>');                          -- as that HOD
--
-- ROLLBACK (manual, for reference — not executed)
--   Re-apply 054's guard_tenant_write_access(), 051's guard_closed_semester()
--   and can_invite_role(), 047's course_enrollments_manage_staff and 006's
--   timetable_read, 019's invitations_update_by_invitee; then:
--   DROP TRIGGER guard_offering_assignment, record_offering_instructor, offering_auto_enroll,
--     audit_academic_structure ON public.course_offerings;
--   DROP TRIGGER guard_offering_open_for_records ON public.attendance, public.marks;
--   DROP TRIGGER guard_enrollment_unique_course ON public.course_enrollments;
--   DROP TRIGGER guard_academic_structure, audit_academic_structure ON public.programmes, public.sections, public.courses;
--   DROP TRIGGER record_department_hod ON public.departments;
--   DROP TRIGGER end_department_terms_with_semester ON public.semesters;
--   DROP TRIGGER guard_timetable_slot ON public.timetable_slots;
--   DROP POLICY programmes_hod_insert, programmes_hod_update ON public.programmes;
--   DROP POLICY course_enrollments_manage_admin ON public.course_enrollments;
--   DROP POLICY timetable_read_staff, timetable_read_enrolled ON public.timetable_slots;
--   DROP TABLE public.student_invitation_placements, public.external_teaching_authorizations,
--     public.offering_instructor_history, public.department_hod_assignments,
--     public.student_section_assignments, public.section_class_incharges, public.department_terms;
--   DROP FUNCTION (every function created in §1-§15).
-- ════════════════════════════════════════════════════════════════════
