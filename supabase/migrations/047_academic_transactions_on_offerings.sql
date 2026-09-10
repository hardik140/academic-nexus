-- ============================================================
-- !!  DO NOT APPLY THIS MIGRATION ON ITS OWN  !!
--
-- Unlike 042-046, this one is BREAKING. It drops attendance.course_id,
-- marks.course_id, timetable_slots.course_id/instructor_id and
-- course_enrollments.course_id/semester_id, all of which live application
-- code still reads. Applying it before the matching application changes ship
-- takes teacher attendance, teacher grading, the timetable and the HOD /
-- Director faculty-workload screens down immediately.
--
-- Apply only together with the application changes in the same PR, on a
-- branch database first. 046 was safe to apply immediately because it was
-- purely additive; this is not.
--
-- Section 7 additionally NARROWS academic write authorization (C1). Any
-- integration that writes attendance or marks with a user token while not
-- being the offering's assigned instructor will start being refused by the
-- database. That is the intent, but it is a behaviour change beyond the
-- column moves, so it needs the same sign-off.
-- ============================================================

-- ============================================================
-- Migration 047: repoint academic transactions onto course_offerings
--
-- DEPENDS ON 046 (academic_years, programmes, sections, course_offerings).
-- 046 is applied; verified live before writing this.
--
-- ============================================================
-- BASELINE AT MIGRATION TIME (§15 — verified by direct count, not assumed)
--
--   attendance          0 rows
--   marks               0 rows
--   course_enrollments  0 rows
--   timetable_slots     0 rows
--
-- Every table this migration restructures is EMPTY. There is therefore no
-- production transactional data migration, and NOT NULL columns can be added
-- directly rather than through the usual nullable -> backfill -> enforce
-- dance. This is the entire reason the change is safe to make now and would
-- not be safe later.
--
-- ============================================================
-- ROOT CAUSE
--
-- A `course` is CATALOG data: "CS301 Database Management Systems, 4 credits".
-- What actually gets taught is an OFFERING of that course: one semester, one
-- section, one instructor. Today the schema has no such concept, so:
--
--   * attendance's UNIQUE(student_id, course_id, date) makes two sections of
--     one course on one day a constraint violation. Sections are not merely
--     unsupported — they are actively prevented.
--   * courses.instructor_id puts the teacher on the CATALOG row, so CS301 has
--     exactly one instructor for the entire institution, forever.
--   * marks' UNIQUE(student_id, course_id, exam_type) means a student who
--     retakes a course in a later semester overwrites their earlier result.
--     Academic history is silently destroyed by a repeat attempt.
--   * nothing carries an academic period, so "this semester's attendance" is
--     not an expressible query.
--
-- After this migration the identity of every academic transaction is the
-- offering, which resolves transitively to academic year, semester, course,
-- section and instructor.
--
-- ============================================================
-- THE course_id / semester_id COLUMNS ARE DROPPED, NOT KEPT
--
-- Both are reachable through offering_id. Keeping them would create a second,
-- independently-writable source of truth for "which course is this attendance
-- row about" — the exact duplication this schema already suffers from
-- elsewhere. They go.
--
-- ============================================================
-- courses.instructor_id IS DEPRECATED HERE, NOT DROPPED
--
-- Instructor assignment genuinely belongs on the offering, and
-- course_offerings.instructor_id (046) is now its home. But dropping the
-- column in this migration would break ~30 live call sites across the web app
-- AND the React Native app (teacher dashboard/courses/attendance/grading/
-- timetable, hod/courses, hod+director faculty workload, student courses and
-- schedule, admin courses, and nine mobile screens) at a moment when
-- course_offerings contains ZERO rows — because programmes and sections are
-- institutional master data that has not been entered yet, and this migration
-- is explicitly forbidden from inventing it.
--
-- Dropping it now would take every teacher screen dark with nothing to fall
-- back on. So: the column stays, marked deprecated, and no NEW code reads it.
-- Migration 048 drops it once real programmes/sections/offerings exist and
-- the application reads offerings instead. This is the same
-- deprecate-then-remove discipline this schema's own status columns follow.
--
-- Sign-off: REQUIRED. Breaking schema change on the academic core.
-- ============================================================

-- ---------------------------------------------------------------
-- 0. Drop dependent objects FIRST.
--
-- Not optional and not cosmetic: mv_attendance_summary_raw selects
-- attendance.course_id, so `ALTER TABLE attendance DROP COLUMN course_id`
-- fails outright ("cannot drop ... because other objects depend on it")
-- unless the view is gone first. Postgres refuses rather than cascading,
-- which is correct behaviour and the reason this section exists.
--
-- mv_department_health_raw has no hard dependency on a dropped column, but
-- its dept_backlog CTE joins `students s ON s.user_id = ce.student_id` —
-- correct only while course_enrollments.student_id referenced profiles(id).
-- After section 1 repoints it at students(id) that join silently matches
-- nothing and every department's backlog rate quietly reads zero. It is
-- rebuilt here for that reason, not because Postgres forced it.
--
-- Both are recreated in section 8 against the offering model.
--
-- AN RLS POLICY IS A DEPENDENT OBJECT TOO. This is the same class of
-- failure as the matview above and is easy to miss, because policies are
-- not what comes to mind when Postgres says "other objects depend on it":
--
--   substitution_read_enrolled_student (039) reads ce.course_id and
--   substitution_assignments.course_id, so section 1's
--   `ALTER TABLE course_enrollments DROP COLUMN course_id` is refused
--   outright while it exists. Found by running this migration against a
--   disposable database rather than by reading it -- the first attempt
--   aborted here (tests/migration-047-applies.test.ts now runs the whole
--   file on every test run so this cannot regress silently).
--
-- It is dropped here and rebuilt on offering_id in section 7c. Nothing
-- else in the schema references a column this migration drops: the other
-- matviews (007) read only students/departments/placements, and function
-- bodies are not tracked as dependencies.
-- ---------------------------------------------------------------
DROP VIEW IF EXISTS public.mv_attendance_summary;
DROP MATERIALIZED VIEW IF EXISTS public.mv_attendance_summary_raw;
DROP VIEW IF EXISTS public.mv_department_health;
DROP MATERIALIZED VIEW IF EXISTS public.mv_department_health_raw;

DROP POLICY IF EXISTS "substitution_read_enrolled_student" ON public.substitution_assignments;

-- ---------------------------------------------------------------
-- 1. course_enrollments — offering-scoped, and the id-space bug fixed
--
-- course_enrollments.student_id references profiles(id), while
-- attendance/marks/fees/gate_passes all reference students(id). Two different
-- id spaces both called "student_id", which is why lib/course-enrollment.ts,
-- migration 032's dept_backlog CTE and migration 039's RLS policy each carry
-- a comment explaining how to bridge them. A wrong join returns zero rows
-- rather than an error.
--
-- The table is empty, so this is the one moment the correction is free.
-- ---------------------------------------------------------------
ALTER TABLE public.course_enrollments
  DROP CONSTRAINT IF EXISTS course_enrollments_student_id_course_id_semester_id_key;

ALTER TABLE public.course_enrollments
  DROP CONSTRAINT IF EXISTS course_enrollments_student_id_fkey;

ALTER TABLE public.course_enrollments
  ADD CONSTRAINT course_enrollments_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE RESTRICT;

ALTER TABLE public.course_enrollments
  ADD COLUMN IF NOT EXISTS offering_id UUID NOT NULL
    REFERENCES public.course_offerings(id) ON DELETE RESTRICT;

ALTER TABLE public.course_enrollments
  DROP COLUMN IF EXISTS course_id,
  DROP COLUMN IF EXISTS semester_id;

ALTER TABLE public.course_enrollments
  ADD CONSTRAINT course_enrollments_offering_student_key UNIQUE (offering_id, student_id);

CREATE INDEX IF NOT EXISTS idx_course_enrollments_offering ON public.course_enrollments(offering_id);

-- ---------------------------------------------------------------
-- 2. attendance — identity becomes (offering, student, date)
-- ---------------------------------------------------------------
ALTER TABLE public.attendance
  DROP CONSTRAINT IF EXISTS attendance_student_id_course_id_date_key;

ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS offering_id UUID NOT NULL
    REFERENCES public.course_offerings(id) ON DELETE RESTRICT;

ALTER TABLE public.attendance
  DROP COLUMN IF EXISTS course_id;

ALTER TABLE public.attendance
  ADD CONSTRAINT attendance_offering_student_date_key UNIQUE (offering_id, student_id, date);

CREATE INDEX IF NOT EXISTS idx_attendance_offering ON public.attendance(offering_id);

-- ---------------------------------------------------------------
-- 3. marks — identity becomes (offering, student, exam_type)
--
-- This is the change that makes a course retake expressible. Under
-- UNIQUE(student_id, course_id, exam_type) a student repeating CS301 in a
-- later semester overwrote their original mark; under the offering key both
-- attempts coexist, each tied to its own semester.
-- ---------------------------------------------------------------
ALTER TABLE public.marks
  DROP CONSTRAINT IF EXISTS marks_student_id_course_id_exam_type_key;

ALTER TABLE public.marks
  ADD COLUMN IF NOT EXISTS offering_id UUID NOT NULL
    REFERENCES public.course_offerings(id) ON DELETE RESTRICT;

ALTER TABLE public.marks
  DROP COLUMN IF EXISTS course_id,
  DROP COLUMN IF EXISTS semester;

ALTER TABLE public.marks
  ADD CONSTRAINT marks_offering_student_exam_key UNIQUE (offering_id, student_id, exam_type);

CREATE INDEX IF NOT EXISTS idx_marks_offering ON public.marks(offering_id);

-- ---------------------------------------------------------------
-- 4. timetable_slots — scheduled sessions of an offering
--
-- instructor_id is dropped outright here (unlike on `courses`): the offering
-- owns the instructor, and a timetable slot carrying its own independent
-- instructor is a second source of truth that can silently disagree with the
-- offering it belongs to. §7 of the brief calls this out directly.
-- semester_id goes too — reachable via offering.
-- ---------------------------------------------------------------
ALTER TABLE public.timetable_slots
  ADD COLUMN IF NOT EXISTS offering_id UUID NOT NULL
    REFERENCES public.course_offerings(id) ON DELETE RESTRICT;

ALTER TABLE public.timetable_slots
  DROP COLUMN IF EXISTS course_id,
  DROP COLUMN IF EXISTS semester_id,
  DROP COLUMN IF EXISTS instructor_id;

CREATE INDEX IF NOT EXISTS idx_timetable_offering ON public.timetable_slots(offering_id);

-- A room cannot host two classes at the same time on the same day.
-- Partial: `room` is nullable and an unassigned room must not collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_timetable_no_room_clash
  ON public.timetable_slots(college_id, room, day_of_week, start_time)
  WHERE room IS NOT NULL;

-- ---------------------------------------------------------------
-- 5. attendance_correction_requests and substitution_assignments
--
-- Both keyed on course_id + date, inheriting the same
-- one-session-per-course-per-day assumption attendance had. Both are empty.
-- ---------------------------------------------------------------
ALTER TABLE public.attendance_correction_requests
  ADD COLUMN IF NOT EXISTS offering_id UUID NOT NULL
    REFERENCES public.course_offerings(id) ON DELETE RESTRICT;

ALTER TABLE public.attendance_correction_requests
  DROP COLUMN IF EXISTS course_id;

CREATE INDEX IF NOT EXISTS idx_attendance_correction_offering
  ON public.attendance_correction_requests(offering_id);

-- ---------------------------------------------------------------
-- 5a. F2 — make the correction request's copied context provably match the
--     attendance row it names.
--
-- A correction request duplicates five columns that already exist on the
-- attendance row it points at: college_id, offering_id, student_id and date,
-- alongside attendance_id itself. The duplication is deliberate and stays —
-- every review policy filters on offering_id, and resolving it through a
-- join on each evaluation would put `attendance` inside the policy for
-- `attendance_correction_requests`, where that table's own RLS then applies
-- to the lookup. Denormalising it is what keeps the review predicate
-- self-contained.
--
-- What was missing is that nothing tied the copy to the original. The insert
-- policy checks `submitted_by = auth.uid()` and nothing else, so a request
-- could name attendance row X while declaring the offering, student and date
-- of row Y. All five values are client-supplied.
--
-- That state is not directly exploitable today: applying a correction is
-- authorised against the ATTENDANCE row's own offering
-- (attendance_update_approved_correction), not against the request's copy,
-- so a mismatched request fails closed at the last step. But it lets the
-- wrong HOD hold a reviewable request in their queue, and it makes the
-- audit trail disagree with itself about which class was corrected.
--
-- A composite foreign key rather than a trigger: this is a referential
-- statement, PostgreSQL expresses it natively, and a declarative constraint
-- cannot be bypassed by a path that forgets to fire it. It needs a matching
-- unique key on the parent — `id` alone is already unique, so widening it to
-- the four context columns adds no new restriction to `attendance`, only a
-- referencable target.
-- ---------------------------------------------------------------
ALTER TABLE public.attendance
  DROP CONSTRAINT IF EXISTS attendance_correction_target_key;
ALTER TABLE public.attendance
  ADD CONSTRAINT attendance_correction_target_key
  UNIQUE (id, college_id, offering_id, student_id, date);

-- Supersedes 037's single-column FK. attendance_id is still covered, because
-- it leads the composite.
ALTER TABLE public.attendance_correction_requests
  DROP CONSTRAINT IF EXISTS attendance_correction_requests_attendance_id_fkey;
ALTER TABLE public.attendance_correction_requests
  DROP CONSTRAINT IF EXISTS attendance_correction_requests_attendance_context_fkey;
ALTER TABLE public.attendance_correction_requests
  ADD CONSTRAINT attendance_correction_requests_attendance_context_fkey
  FOREIGN KEY (attendance_id, college_id, offering_id, student_id, date)
  REFERENCES public.attendance (id, college_id, offering_id, student_id, date)
  ON DELETE CASCADE;

-- ON DELETE CASCADE has to find the children by the referenced key; without
-- this the cascade degrades to a sequential scan as the table grows.
CREATE INDEX IF NOT EXISTS idx_attendance_correction_attendance
  ON public.attendance_correction_requests(attendance_id);

ALTER TABLE public.substitution_assignments
  DROP CONSTRAINT IF EXISTS substitution_assignments_course_id_date_key;

ALTER TABLE public.substitution_assignments
  ADD COLUMN IF NOT EXISTS offering_id UUID NOT NULL
    REFERENCES public.course_offerings(id) ON DELETE RESTRICT;

ALTER TABLE public.substitution_assignments
  DROP COLUMN IF EXISTS course_id;

ALTER TABLE public.substitution_assignments
  ADD CONSTRAINT substitution_assignments_offering_date_key UNIQUE (offering_id, date);

CREATE INDEX IF NOT EXISTS idx_substitution_offering ON public.substitution_assignments(offering_id);

-- ---------------------------------------------------------------
-- 6. Deprecate courses.instructor_id (see header for why it is not dropped)
-- ---------------------------------------------------------------
COMMENT ON COLUMN public.courses.instructor_id IS
  'DEPRECATED (migration 047). Instructor assignment belongs to '
  'course_offerings.instructor_id — a course is catalog data and can be '
  'taught by different teachers in different sections and semesters. Kept '
  'only so existing web and mobile screens keep functioning until '
  'programmes/sections/offerings hold real data. No new code may read it. '
  'Migration 048 drops it.';

-- ---------------------------------------------------------------
-- 7. RLS — offering-derived authority, enforced in the database
--
-- Two separate jobs in this section:
--
--   7a-7b  Authority functions + the academic write policies. This is the
--          C1 fix: until now the database enforced only ROLE, so the
--          instructor-assignment boundary existed solely in application
--          code and any teacher with a valid session could write any
--          offering's attendance and marks in their college by calling
--          PostgREST directly. The application layer was right; the
--          database was not enforcing the same model.
--
--   7c     The policies that referenced columns this migration drops.
--
-- THE INVARIANT THIS SECTION ESTABLISHES
--
--   A user denied by the application must also be denied when targeting
--   the database directly. lib/offerings.ts and this section are two
--   implementations of one rule, and they are named after each other so a
--   future reader can see they must move together:
--
--     canWriteOfferingRecords   <->  public.can_write_offering_records()
--     assertCanRecordAttendance <->  public.can_record_attendance()
--     assertOfferingInReviewScope <-> public.heads_offering_department()
--
-- WHY FUNCTIONS RATHER THAN INLINE EXISTS SUBQUERIES
--
-- A subquery inside an RLS policy is itself subject to the referenced
-- table's RLS. An inline `EXISTS (SELECT 1 FROM course_offerings ...)`
-- would therefore work only while course_offerings_read stays college-wide
-- for every role — narrowing that policy later would silently start
-- failing attendance writes for reasons unrelated to attendance. These are
-- SECURITY DEFINER so the authority question is answered independently of
-- who may read the offering table, which is the same reasoning that made
-- get_my_role()/get_my_college_id() SECURITY DEFINER in 006.
--
-- search_path is pinned on each one. The 006 helpers predate that habit;
-- a SECURITY DEFINER function without it resolves unqualified names — and
-- operators — through the caller's search_path.
-- ---------------------------------------------------------------

-- ---------------------------------------------------------------
-- 7a. Authority functions
-- ---------------------------------------------------------------

-- The database half of canWriteOfferingRecords(): admin anywhere in their
-- own college, or the assigned instructor, and never a cancelled offering.
--
-- Note what is absent: no branch for 'hod'. A HOD who teaches matches the
-- instructor_id test like any other teacher; a HOD who does not teach the
-- section gets nothing here. Department standing is review authority and is
-- answered by heads_offering_department() below, never by this function.
CREATE OR REPLACE FUNCTION public.can_write_offering_records(p_offering_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.course_offerings o
    WHERE o.id = p_offering_id
      AND o.college_id = public.get_my_college_id()
      AND o.status <> 'cancelled'
      AND (
        public.get_my_role() = 'admin'
        OR o.instructor_id = auth.uid()
      )
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- The database half of assertCanRecordAttendance(): everything above, plus
-- the one legitimate widening — a substitute assigned to THIS offering on
-- THIS date.
--
-- Every clause is load-bearing. Dropping sa.date makes a single cover
-- assignment permanent access to the offering; dropping the status test
-- lets the 'needed' placeholder written at leave-approval time (before
-- anyone has agreed to cover) authorize writes; dropping the cancelled test
-- lets a stale assignment reopen a cancelled offering. This function is
-- attendance-only and is deliberately not referenced by any marks policy:
-- covering one class is not authority over a section's assessment record.
CREATE OR REPLACE FUNCTION public.can_record_attendance(p_offering_id UUID, p_date DATE)
RETURNS BOOLEAN AS $$
  SELECT public.can_write_offering_records(p_offering_id)
    OR EXISTS (
      SELECT 1
      FROM public.substitution_assignments sa
      JOIN public.course_offerings o ON o.id = sa.offering_id
      WHERE sa.offering_id = p_offering_id
        AND sa.date = p_date
        AND sa.substitute_teacher_id = auth.uid()
        AND sa.status = 'assigned'
        AND o.college_id = public.get_my_college_id()
        AND o.status <> 'cancelled'
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- Department standing, asked of a COURSE.
--
-- WHICH DEPARTMENT OWNS AN OFFERING — there are two candidate answers and
-- they disagree for service courses:
--
--   courses.department_id                        the TEACHING department
--   section -> programme -> programmes.dept_id   the RECEIVING department
--
-- Engineering Mathematics owned by Mathematics and delivered to a CSE
-- section has Mathematics as the first and CSE as the second. This codebase
-- uses the TEACHING department, and that is the right choice for an
-- authority predicate: what an HOD supervises is their own staff's academic
-- work. The instructor of that class is a Mathematics lecturer, reviewed by
-- the Mathematics HOD. Handing the CSE HOD approval rights over another
-- department's lecturer because the students happen to be theirs would
-- invert the reporting line.
--
-- Stated here rather than left implicit because 046's own comment names
-- "the course's department_id" and this is the only place the alternative is
-- ruled out on the record.
--
-- Takes the course id rather than the offering id so it can be applied to a
-- row's own column. That matters for WITH CHECK on course_offerings, where
-- the question is about the row being written, not a row already stored.
CREATE OR REPLACE FUNCTION public.heads_course_department(p_course_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.courses c
    JOIN public.departments d ON d.id = c.department_id
    WHERE c.id = p_course_id
      AND d.hod_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- Department REVIEW standing: does the caller head the department that owns
-- this offering's course? Grants no write authority by itself — it appears
-- only in review/approval policies.
--
-- Delegates to heads_course_department so there is ONE definition of "an
-- HOD's department scope". Two copies of this join is how the offering-
-- management policy and the review policies would drift apart.
--
-- EXISTS over the join rather than a scalar lookup, because departments.hod_id
-- carries no unique constraint (002) and one person heading two departments
-- is ordinary. The single-row form of this question resolves such a HOD to
-- NULL and silently denies them everything.
CREATE OR REPLACE FUNCTION public.heads_offering_department(p_offering_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.course_offerings o
    WHERE o.id = p_offering_id
      AND public.heads_course_department(o.course_id)
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_catalog;

-- ---------------------------------------------------------------
-- 7b. Academic write policies — the C1 fix
--
-- READ policies are NOT touched anywhere in this section. attendance_read_student
-- and marks_read_student already derive student ownership from
-- students.user_id = auth.uid(), which is correct and stays exactly as it is;
-- attendance_read_staff / marks_read_staff keep their college-wide staff read.
-- Read, write and review stay three separate policies on purpose.
-- ---------------------------------------------------------------

-- attendance: replaces attendance_teacher_mark + attendance_teacher_update
-- (006) and attendance_hod_update (038).
--
-- What 006 enforced was `role IN ('teacher','admin')` — any teacher, any
-- offering. What 038 added was worse: role = 'hod' with no further
-- qualification, i.e. every HOD could UPDATE every attendance row in the
-- institution, including departments they do not head, bypassing the
-- correction workflow entirely.
DROP POLICY IF EXISTS "attendance_teacher_mark"   ON public.attendance;
DROP POLICY IF EXISTS "attendance_teacher_update" ON public.attendance;
DROP POLICY IF EXISTS "attendance_hod_update"     ON public.attendance;

DROP POLICY IF EXISTS "attendance_insert_offering_authority" ON public.attendance;
CREATE POLICY "attendance_insert_offering_authority" ON public.attendance
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.can_record_attendance(offering_id, date)
  );

-- WITH CHECK is spelled out rather than left implicit. Postgres already
-- falls back to the USING expression when an UPDATE policy omits WITH CHECK,
-- so for a policy whose two halves are identical this changes no behaviour --
-- it states the post-image rule at the point a reader looks for it, and it
-- makes an accidental future divergence between the two visible in the diff
-- instead of silent. The post-image test is what stops an actor who may
-- update a row from rewriting its offering_id to an offering they hold no
-- authority over.
DROP POLICY IF EXISTS "attendance_update_offering_authority" ON public.attendance;
CREATE POLICY "attendance_update_offering_authority" ON public.attendance
  FOR UPDATE
  USING (
    college_id = public.get_my_college_id()
    AND public.can_record_attendance(offering_id, date)
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.can_record_attendance(offering_id, date)
  );

-- The correction workflow, expressed as authority derived from the workflow
-- artifact rather than from a role.
--
-- Removing attendance_hod_update leaves actOnAttendanceCorrectionCore unable
-- to apply an approved correction, so that capability has to come back — but
-- NOT as "hod may update attendance in their department", which is the
-- generic policy that would collapse request -> review -> approve back into
-- one actor. Instead: a reviewer may write exactly the attendance row that
-- an approved correction request points at, only where they are the recorded
-- reviewer, and only where they are not the submitter.
--
-- That last clause puts separation of duties in the DATABASE rather than
-- relying solely on assertNotSelfApproval in application code. A HOD who
-- teaches can raise a correction on their own record and cannot approve it,
-- at either layer.
--
-- The app updates the request to 'approved' before updating the attendance
-- row (see actOnAttendanceCorrectionCore's compare-and-swap ordering), so
-- the approved request exists by the time this policy is evaluated.
--
-- Residual, stated rather than papered over: RLS cannot see OLD vs NEW, so
-- no policy here can express "you may change status but not offering_id".
-- A reviewer applying a correction could in principle move the row to
-- another offering IN A DEPARTMENT THEY ALREADY HEAD -- the post-image test
-- confines it to that. Forbidding the column change itself needs a trigger,
-- which is a separate decision from this migration.
DROP POLICY IF EXISTS "attendance_update_approved_correction" ON public.attendance;
CREATE POLICY "attendance_update_approved_correction" ON public.attendance
  FOR UPDATE
  USING (
    college_id = public.get_my_college_id()
    AND public.heads_offering_department(offering_id)
    AND EXISTS (
      SELECT 1
      FROM public.attendance_correction_requests r
      WHERE r.attendance_id  = attendance.id
        AND r.status         = 'approved'
        AND r.reviewed_by    = auth.uid()
        AND r.submitted_by  <> auth.uid()
    )
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.heads_offering_department(offering_id)
    AND EXISTS (
      SELECT 1
      FROM public.attendance_correction_requests r
      WHERE r.attendance_id  = attendance.id
        AND r.status         = 'approved'
        AND r.reviewed_by    = auth.uid()
        AND r.submitted_by  <> auth.uid()
    )
  );

-- marks: replaces marks_teacher_manage (006), which was FOR ALL with
-- `role IN ('teacher','admin')` — one broad policy covering SELECT, INSERT,
-- UPDATE and DELETE for every teacher in the college. Split per command so
-- read authority and write authority stop sharing a definition, and so a
-- future change to one cannot silently widen the others.
--
-- No substitute clause anywhere here. That is the intended asymmetry with
-- attendance.
DROP POLICY IF EXISTS "marks_teacher_manage" ON public.marks;

DROP POLICY IF EXISTS "marks_insert_instructor" ON public.marks;
CREATE POLICY "marks_insert_instructor" ON public.marks
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.can_write_offering_records(offering_id)
  );

DROP POLICY IF EXISTS "marks_update_instructor" ON public.marks;
CREATE POLICY "marks_update_instructor" ON public.marks
  FOR UPDATE
  USING (
    college_id = public.get_my_college_id()
    AND public.can_write_offering_records(offering_id)
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.can_write_offering_records(offering_id)
  );

DROP POLICY IF EXISTS "marks_delete_instructor" ON public.marks;
CREATE POLICY "marks_delete_instructor" ON public.marks
  FOR DELETE USING (
    college_id = public.get_my_college_id()
    AND public.can_write_offering_records(offering_id)
  );

-- attendance_correction_requests: the review side of the same defect.
--
-- attendance_correction_update_staff (037) was `role IN ('hod','admin')`,
-- college-wide — any HOD could decide any other department's correction
-- request. Department scope was checked in application code only, so the
-- cross-department review path was open at the database exactly as the
-- cross-offering write path was.
DROP POLICY IF EXISTS "attendance_correction_update_staff" ON public.attendance_correction_requests;

DROP POLICY IF EXISTS "attendance_correction_review_scope" ON public.attendance_correction_requests;
CREATE POLICY "attendance_correction_review_scope" ON public.attendance_correction_requests
  FOR UPDATE
  USING (
    college_id = public.get_my_college_id()
    AND (
      public.get_my_role() = 'admin'
      OR public.heads_offering_department(offering_id)
    )
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    AND (
      public.get_my_role() = 'admin'
      OR public.heads_offering_department(offering_id)
    )
  );

-- ---------------------------------------------------------------
-- 7c. Policies that referenced columns this migration drops
--
-- substitution_read_enrolled_student (039) joined course_enrollments on
-- course_id AND compared ce.student_id to auth.uid() — which only worked
-- because student_id pointed at profiles. Both halves are now wrong, so the
-- policy is rebuilt on offering_id with the students(id) hop.
--
-- Already dropped in section 0 — it had to go before the columns it reads
-- could be dropped. The redundant DROP is kept so this block still reads as
-- a complete definition of the policy.
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "substitution_read_enrolled_student" ON public.substitution_assignments;

CREATE POLICY "substitution_read_enrolled_student" ON public.substitution_assignments
  FOR SELECT USING (
    status = 'assigned'
    AND EXISTS (
      SELECT 1
      FROM public.course_enrollments ce
      JOIN public.students s ON s.id = ce.student_id
      WHERE ce.offering_id = substitution_assignments.offering_id
        AND s.user_id = auth.uid()
        AND ce.status = 'enrolled'
    )
  );

-- course_enrollments_read_own (036) compared student_id = auth.uid(), which
-- was only correct while student_id referenced profiles. It must now hop
-- through students.user_id or every student silently sees nothing.
DROP POLICY IF EXISTS "course_enrollments_read_own" ON public.course_enrollments;

CREATE POLICY "course_enrollments_read_own" ON public.course_enrollments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.id = course_enrollments.student_id AND s.user_id = auth.uid()
    )
  );

-- Enrollment is administrative rather than an academic record, so a HOD does
-- act on it directly — but scoped to a department they actually head, not
-- college-wide. An earlier draft of this policy granted every HOD every
-- offering's enrollments, which is the same cross-department hole 7b closes
-- for attendance and marks.
DROP POLICY IF EXISTS "course_enrollments_manage_staff" ON public.course_enrollments;
CREATE POLICY "course_enrollments_manage_staff" ON public.course_enrollments
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND (
      public.get_my_role() = 'admin'
      OR public.can_write_offering_records(offering_id)
      OR public.heads_offering_department(offering_id)
    )
  );

-- ---------------------------------------------------------------
-- 7d. F1 — offering management, scoped to the department an HOD heads
--
-- 046 created course_offerings_manage as role + tenancy:
--
--   college_id = get_my_college_id() AND get_my_role() IN ('admin','director','hod')
--
-- with the comment "Department ownership for hod is enforced app-side ...
-- RLS here is the role + tenancy backstop." There is no app side. A repo-wide
-- scan finds ZERO writes to course_offerings — no insert, no update, no
-- upsert, no delete, in the web app, the API routes or the React Native app.
-- The same is true of sections, programmes, semesters and academic_years.
-- So the "app-side" half of that split was never written, and the database
-- half was the only half there was.
--
-- What that permitted:
--
--   HOD of CSE
--     -> UPDATE course_offerings SET instructor_id = auth.uid()
--        WHERE id = <an ECE offering>          -- one PostgREST call
--     -> can_write_offering_records() now returns true for them
--     -> attendance and marks on another department's class
--
-- This is the exact shape section 7b exists to prevent, arriving through the
-- master-data table instead of the transaction tables. An authority check is
-- worth nothing if the subject can edit the record the check reads. That is
-- the invariant: a user must not be able to manufacture stronger authority
-- by modifying the row that subsequently authorises them.
--
-- Two properties are needed, and they are different questions:
--   the offering as it STANDS must be in the HOD's scope — blocks reaching
--     into another department at all;
--   the offering as it WILL STAND must also be in scope — blocks moving one
--     of their own offerings out of their department, and blocks creating
--     one outside it.
--
-- WITH CHECK is written out for the second, but it should not be read as
-- adding enforcement that would otherwise be missing: Postgres applies USING
-- to the new row as well when WITH CHECK is omitted, so deleting the clause
-- below changes nothing. Verified by mutation — removing it entirely leaves
-- the walk-out-of-scope update still refused, which is why the mutation test
-- replaces it with WITH CHECK (true) instead. It is here because the two
-- questions are genuinely distinct and the next reader should not have to
-- know that fallback rule to see that both are covered.
--
-- heads_course_department(course_id) takes the row's own column rather than
-- looking the offering up by id. A lookup-by-id function does resolve to the
-- new row inside WITH CHECK — verified, not assumed — but relying on
-- intra-statement visibility to get an authorization decision right is a
-- fragile thing to leave for the next reader.
--
-- admin and director keep college-wide management, unchanged from 046. That
-- is deliberate: 046 named both explicitly, and narrowing them would be
-- inventing a rule rather than enforcing the one that exists. It leaves a
-- smaller residual — a director, who otherwise holds read-only oversight of
-- academic records, can still name themselves instructor and gain write.
-- That is recorded as a test in tests/staging-security-f1-f2.test.ts and
-- reported rather than silently changed.
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "course_offerings_manage" ON public.course_offerings;

CREATE POLICY "course_offerings_manage" ON public.course_offerings
  FOR ALL
  USING (
    college_id = public.get_my_college_id()
    AND (
      public.get_my_role() IN ('admin', 'director')
      OR (
        public.get_my_role() = 'hod'
        AND public.heads_course_department(course_id)
      )
    )
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    AND (
      public.get_my_role() IN ('admin', 'director')
      OR (
        public.get_my_role() = 'hod'
        AND public.heads_course_department(course_id)
      )
    )
  );

-- ---------------------------------------------------------------
-- 8. Rebuild the analytics views against the offering model.
--
-- Output columns are preserved exactly — director/analytics, hod/reports and
-- two mobile screens read these with select("*") and render named columns, so
-- dropping or renaming one would break four surfaces. semester_id and
-- offering_id are ADDED, and uniqueness moves to the offering, which is the
-- whole point: the old key aggregated every section and semester of a course
-- into one indistinguishable row.
-- ---------------------------------------------------------------
CREATE MATERIALIZED VIEW public.mv_attendance_summary_raw AS
SELECT
  a.college_id,
  p.department_id,
  a.offering_id,
  o.semester_id,
  o.course_id,
  c.name AS course_name,
  c.code AS course_code,
  COUNT(*) FILTER (WHERE a.status = 'present') AS present_count,
  COUNT(*) FILTER (WHERE a.status = 'late') AS late_count,
  COUNT(*) FILTER (WHERE a.status = 'absent') AS absent_count,
  COUNT(*) AS total_count,
  ROUND(
    COUNT(*) FILTER (WHERE a.status IN ('present', 'late'))::NUMERIC / NULLIF(COUNT(*), 0) * 100,
    1
  ) AS attendance_pct
FROM public.attendance a
JOIN public.course_offerings o ON o.id = a.offering_id
JOIN public.courses c ON c.id = o.course_id
JOIN public.sections sec ON sec.id = o.section_id
JOIN public.programmes p ON p.id = sec.programme_id
GROUP BY a.college_id, p.department_id, a.offering_id,
         o.semester_id, o.course_id, c.name, c.code;

-- department_id now derives from the offering's section -> programme, not
-- from each student's own row. Two students from different departments
-- sitting in one offering no longer split it across two rows.
CREATE UNIQUE INDEX idx_mv_attendance_summary
  ON public.mv_attendance_summary_raw(college_id, offering_id);

REVOKE ALL ON public.mv_attendance_summary_raw FROM anon, authenticated;

CREATE VIEW public.mv_attendance_summary AS
  SELECT * FROM public.mv_attendance_summary_raw
  WHERE college_id = public.get_my_college_id();

GRANT SELECT ON public.mv_attendance_summary TO authenticated;

CREATE MATERIALIZED VIEW public.mv_department_health_raw AS
WITH dept_students AS (
  SELECT s.college_id, s.department_id, d.name AS department_name, d.code AS department_code,
         COUNT(*) AS total_students,
         ROUND(AVG(s.cgpa), 2) AS avg_cgpa
  FROM public.students s
  JOIN public.departments d ON s.department_id = d.id
  WHERE s.status = 'active'
  GROUP BY s.college_id, s.department_id, d.name, d.code
),
dept_attendance AS (
  SELECT s.department_id,
         ROUND(COUNT(*) FILTER (WHERE a.status IN ('present', 'late'))::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1) AS attendance_pct
  FROM public.attendance a
  JOIN public.students s ON a.student_id = s.id
  GROUP BY s.department_id
),
dept_backlog AS (
  -- course_enrollments.student_id now references students(id) directly
  -- (section 1 of this migration fixed the profiles/students id-space split),
  -- so this joins on s.id. The previous `s.user_id = ce.student_id` hop would
  -- silently match zero rows against the corrected schema.
  SELECT s.department_id,
         COUNT(*) FILTER (WHERE ce.status = 'failed') AS backlog_count,
         ROUND(COUNT(*) FILTER (WHERE ce.status = 'failed')::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1) AS backlog_rate
  FROM public.course_enrollments ce
  JOIN public.students s ON s.id = ce.student_id
  GROUP BY s.department_id
),
dept_fees AS (
  SELECT s.department_id,
         ROUND(SUM(f.paid_amount)::NUMERIC / NULLIF(SUM(f.amount), 0) * 100, 1) AS fee_collection_pct
  FROM public.fees f
  JOIN public.students s ON f.student_id = s.id
  GROUP BY s.department_id
),
dept_placement AS (
  SELECT s.department_id,
         ROUND(COUNT(*) FILTER (WHERE spp.placement_status = 'placed')::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1) AS placement_rate
  FROM public.student_placement_profiles spp
  JOIN public.students s ON spp.student_id = s.id
  GROUP BY s.department_id
)
SELECT
  ds.college_id,
  ds.department_id,
  ds.department_name,
  ds.department_code,
  ds.total_students,
  ds.avg_cgpa,
  da.attendance_pct,
  COALESCE(db.backlog_count, 0) AS backlog_count,
  db.backlog_rate,
  df.fee_collection_pct,
  dp.placement_rate
FROM dept_students ds
LEFT JOIN dept_attendance da ON da.department_id = ds.department_id
LEFT JOIN dept_backlog db ON db.department_id = ds.department_id
LEFT JOIN dept_fees df ON df.department_id = ds.department_id
LEFT JOIN dept_placement dp ON dp.department_id = ds.department_id;

CREATE UNIQUE INDEX idx_mv_department_health
  ON public.mv_department_health_raw(college_id, department_id);

REVOKE ALL ON public.mv_department_health_raw FROM anon, authenticated;

CREATE VIEW public.mv_department_health AS
  SELECT * FROM public.mv_department_health_raw
  WHERE college_id = public.get_my_college_id();

GRANT SELECT ON public.mv_department_health TO authenticated;

-- Populate both immediately so no dashboard sits on an empty view between
-- this migration and the next scheduled refresh_analytics() run. Plain
-- REFRESH (not CONCURRENTLY): a freshly created matview has never been
-- populated, and CONCURRENTLY is rejected on an unpopulated view.
REFRESH MATERIALIZED VIEW public.mv_attendance_summary_raw;
REFRESH MATERIALIZED VIEW public.mv_department_health_raw;

-- ============================================================
-- Post-apply verification
-- ============================================================
--   -- the new identities exist and the old ones are gone
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.attendance'::regclass AND contype='u';
--     -- expect attendance_offering_student_date_key, NOT ..._course_id_date_key
--
--   -- dropped columns really are gone
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name IN ('attendance','marks','timetable_slots','course_enrollments')
--      AND column_name IN ('course_id','semester_id','semester','instructor_id');
--     -- expect zero rows
--
--   -- course_enrollments now points at students(id), not profiles(id)
--   SELECT confrelid::regclass FROM pg_constraint
--    WHERE conname = 'course_enrollments_student_id_fkey';   -- expect students
--
--   -- everything still empty; no data was harmed
--   SELECT (SELECT count(*) FROM attendance), (SELECT count(*) FROM marks),
--          (SELECT count(*) FROM course_enrollments), (SELECT count(*) FROM timetable_slots);
--
--   -- both analytics views rebuilt and refreshable in one call
--   SELECT public.refresh_analytics();
--   SELECT count(*) FROM public.mv_attendance_summary;   -- 0 until offerings exist
--   SELECT count(*) FROM public.mv_department_health;    -- one row per department
--
--   -- ---- C1: the database now enforces offering authority ----
--
--   -- the role-only academic write policies are gone
--   SELECT policyname FROM pg_policies
--    WHERE tablename IN ('attendance','marks')
--      AND policyname IN ('attendance_teacher_mark','attendance_teacher_update',
--                         'attendance_hod_update','marks_teacher_manage');
--     -- expect zero rows
--
--   -- and the offering-derived ones exist, split by command
--   SELECT policyname, cmd, qual IS NOT NULL AS has_using,
--          with_check IS NOT NULL AS has_with_check
--     FROM pg_policies WHERE tablename IN ('attendance','marks')
--    ORDER BY cmd, policyname;
--     -- every UPDATE policy must show has_with_check = true, or offering_id
--     -- can be rewritten to an offering the actor has no authority over
--
--   -- READ policies are untouched by this migration
--   SELECT policyname FROM pg_policies
--    WHERE tablename IN ('attendance','marks') AND cmd = 'SELECT';
--     -- expect attendance_read_student, attendance_read_staff,
--     --        marks_read_student, marks_read_staff
--
--   -- the authority functions are SECURITY DEFINER with a pinned search_path
--   SELECT proname, prosecdef, proconfig FROM pg_proc
--    WHERE proname IN ('can_write_offering_records','can_record_attendance',
--                      'heads_offering_department');
--     -- expect prosecdef = true and proconfig = {search_path=public, pg_catalog}
--
--   -- and the whole point, as the actual roles (run in a disposable DB):
--   --   SET LOCAL ROLE authenticated;
--   --   SET LOCAL request.jwt.claims = '{"sub":"<teacher-b-uuid>"}';
--   --   INSERT INTO attendance (..., offering_id = <teacher A's offering>);
--   --     -- expect: new row violates row-level security policy
--   -- Automated as tests/rls-offering-authority.test.ts, which runs this
--   -- migration's own SQL rather than a paraphrase of it.
--
-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- Restore from the pre-migration schema: re-add course_id/semester_id/
-- instructor_id columns, re-create the original UNIQUE constraints, repoint
-- course_enrollments.student_id at profiles(id), and drop the offering_id
-- columns. Safe to do bluntly ONLY while these tables remain empty — once
-- real attendance/marks exist, a rollback needs its own data migration.
--
-- The RLS half of a rollback, if it is ever needed independently. Note that
-- reverting these RESTORES the C1 defect: any teacher may write any
-- offering's records, and any HOD may update any attendance row in the
-- institution. Do not revert 7a/7b to work around a permission problem —
-- fix the policy instead.
--
--   DROP POLICY IF EXISTS "attendance_insert_offering_authority"  ON public.attendance;
--   DROP POLICY IF EXISTS "attendance_update_offering_authority"  ON public.attendance;
--   DROP POLICY IF EXISTS "attendance_update_approved_correction" ON public.attendance;
--   DROP POLICY IF EXISTS "marks_insert_instructor" ON public.marks;
--   DROP POLICY IF EXISTS "marks_update_instructor" ON public.marks;
--   DROP POLICY IF EXISTS "marks_delete_instructor" ON public.marks;
--   DROP POLICY IF EXISTS "attendance_correction_review_scope"
--     ON public.attendance_correction_requests;
--   DROP FUNCTION IF EXISTS public.can_record_attendance(UUID, DATE);
--   DROP FUNCTION IF EXISTS public.can_write_offering_records(UUID);
--   DROP FUNCTION IF EXISTS public.heads_offering_department(UUID);
--   -- then re-create attendance_teacher_mark / attendance_teacher_update from
--   -- migration 006, attendance_hod_update from 038, marks_teacher_manage from
--   -- 006, and attendance_correction_update_staff from 037.
