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
-- 0. Drop the dependent analytics views FIRST.
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
-- ---------------------------------------------------------------
DROP VIEW IF EXISTS public.mv_attendance_summary;
DROP MATERIALIZED VIEW IF EXISTS public.mv_attendance_summary_raw;
DROP VIEW IF EXISTS public.mv_department_health;
DROP MATERIALIZED VIEW IF EXISTS public.mv_department_health_raw;

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
-- 7. RLS — the policies that referenced the dropped columns
--
-- substitution_read_enrolled_student (039) joined course_enrollments on
-- course_id AND compared ce.student_id to auth.uid() — which only worked
-- because student_id pointed at profiles. Both halves are now wrong, so the
-- policy is rebuilt on offering_id with the students(id) hop.
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

-- Teachers need to enrol/adjust students on offerings they own; hod/admin
-- college-wide with department ownership enforced app-side, matching the
-- split used by 037/039/040.
CREATE POLICY "course_enrollments_manage_staff" ON public.course_enrollments
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND (
      public.get_my_role() IN ('admin', 'hod')
      OR EXISTS (
        SELECT 1 FROM public.course_offerings o
        WHERE o.id = course_enrollments.offering_id AND o.instructor_id = auth.uid()
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
-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- Restore from the pre-migration schema: re-add course_id/semester_id/
-- instructor_id columns, re-create the original UNIQUE constraints, repoint
-- course_enrollments.student_id at profiles(id), and drop the offering_id
-- columns. Safe to do bluntly ONLY while these tables remain empty — once
-- real attendance/marks exist, a rollback needs its own data migration.
