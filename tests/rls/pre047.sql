-- ============================================================
-- POST-046 / PRE-047 schema, for the migration-applies test.
--
-- This is the shape migration 047 expects to find: 046's academic period
-- tables already present, and the six transaction tables still carrying
-- course_id / semester_id / instructor_id. Running the real 047 file
-- against this answers a question the policy tests cannot — does the
-- migration actually apply, in order, without Postgres refusing a step.
--
-- The six restructured tables are deliberately left EMPTY, because that is
-- what they are in the real database (047's header records the verified
-- counts). It is also what makes the migration legal at all: it adds
-- `offering_id UUID NOT NULL` with no default, which any existing row
-- would reject.
--
-- Constraint names matter here. 047 drops constraints by name, and a
-- fixture that invented different names would let a broken DROP pass
-- unnoticed, so these match what Postgres generates for the original
-- table definitions.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('test.user_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;

-- Supabase's PostgREST roles; 047 REVOKEs from both by name.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;

CREATE TABLE public.colleges (id UUID PRIMARY KEY, name TEXT NOT NULL);

CREATE TABLE public.profiles (
  id UUID PRIMARY KEY,
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  full_name TEXT
);

CREATE TABLE public.departments (
  id UUID PRIMARY KEY,
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  hod_id UUID REFERENCES public.profiles(id)
);

CREATE TABLE public.courses (
  id UUID PRIMARY KEY,
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  department_id UUID REFERENCES public.departments(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  instructor_id UUID REFERENCES public.profiles(id)
);

CREATE TABLE public.students (
  id UUID PRIMARY KEY,
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  user_id UUID REFERENCES public.profiles(id),
  department_id UUID REFERENCES public.departments(id),
  enrollment_number TEXT,
  cgpa NUMERIC,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE public.fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  student_id UUID NOT NULL REFERENCES public.students(id),
  amount NUMERIC NOT NULL,
  paid_amount NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE public.student_placement_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  student_id UUID NOT NULL REFERENCES public.students(id),
  placement_status TEXT NOT NULL DEFAULT 'unplaced'
);

-- ------------------------------------------------- 046's period tables

CREATE TABLE public.academic_years (
  id UUID PRIMARY KEY,
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned'
);

CREATE TABLE public.semesters (
  id UUID PRIMARY KEY,
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  academic_year_id UUID REFERENCES public.academic_years(id),
  name TEXT NOT NULL,
  sequence_no INT,
  status TEXT NOT NULL DEFAULT 'planned',
  is_current BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE public.programmes (
  id UUID PRIMARY KEY,
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  department_id UUID NOT NULL REFERENCES public.departments(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL
);

CREATE TABLE public.sections (
  id UUID PRIMARY KEY,
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  programme_id UUID NOT NULL REFERENCES public.programmes(id),
  batch_year INT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE public.course_offerings (
  id UUID PRIMARY KEY,
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  semester_id UUID NOT NULL REFERENCES public.semesters(id),
  course_id UUID NOT NULL REFERENCES public.courses(id),
  section_id UUID NOT NULL REFERENCES public.sections(id),
  instructor_id UUID REFERENCES public.profiles(id),
  status TEXT NOT NULL DEFAULT 'planned'
);

-- --------------------------------- the six tables 047 restructures

CREATE TABLE public.course_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  student_id UUID NOT NULL REFERENCES public.profiles(id),   -- the id-space bug
  course_id UUID NOT NULL REFERENCES public.courses(id),
  semester_id UUID REFERENCES public.semesters(id),
  status TEXT NOT NULL DEFAULT 'enrolled',
  grade TEXT,
  grade_points NUMERIC,
  UNIQUE (student_id, course_id, semester_id)
);

CREATE TABLE public.attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  student_id UUID NOT NULL REFERENCES public.students(id),
  course_id UUID NOT NULL REFERENCES public.courses(id),
  date DATE NOT NULL,
  status TEXT NOT NULL,
  marked_by UUID REFERENCES public.profiles(id),
  remarks TEXT,
  UNIQUE (student_id, course_id, date)
);

CREATE TABLE public.marks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  student_id UUID NOT NULL REFERENCES public.students(id),
  course_id UUID NOT NULL REFERENCES public.courses(id),
  exam_type TEXT NOT NULL,
  semester INT,
  max_marks NUMERIC,
  obtained_marks NUMERIC,
  entered_by UUID REFERENCES public.profiles(id),
  remarks TEXT,
  UNIQUE (student_id, course_id, exam_type)
);

CREATE TABLE public.timetable_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  course_id UUID NOT NULL REFERENCES public.courses(id),
  day_of_week INT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  room TEXT,
  instructor_id UUID REFERENCES public.profiles(id),
  semester_id UUID REFERENCES public.semesters(id)
);

CREATE TABLE public.attendance_correction_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  attendance_id UUID NOT NULL REFERENCES public.attendance(id),
  student_id UUID NOT NULL REFERENCES public.students(id),
  course_id UUID NOT NULL REFERENCES public.courses(id),
  date DATE NOT NULL,
  current_status TEXT NOT NULL,
  requested_status TEXT NOT NULL,
  reason TEXT,
  evidence_note TEXT,
  submitted_by UUID NOT NULL REFERENCES public.profiles(id),
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by UUID REFERENCES public.profiles(id),
  reviewed_at TIMESTAMPTZ
);

CREATE TABLE public.substitution_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  leave_request_id UUID,
  course_id UUID NOT NULL REFERENCES public.courses(id),
  timetable_slot_id UUID REFERENCES public.timetable_slots(id) ON DELETE SET NULL,
  original_teacher_id UUID NOT NULL REFERENCES public.profiles(id),
  substitute_teacher_id UUID REFERENCES public.profiles(id),
  date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'needed',
  UNIQUE (course_id, date)
);

-- ------------------------------------- indexes on to-be-dropped columns
--
-- Postgres drops an index automatically when its column goes, so these do
-- not block the migration -- but a fixture without them cannot prove that.
-- They are here so the harness exercises the real object graph rather than
-- a convenient subset.

CREATE INDEX idx_course_enrollments_student ON public.course_enrollments(student_id);
CREATE INDEX idx_course_enrollments_course  ON public.course_enrollments(course_id);
CREATE INDEX idx_attendance_student ON public.attendance(student_id);
CREATE INDEX idx_attendance_course  ON public.attendance(course_id);
CREATE INDEX idx_attendance_date    ON public.attendance(date);
CREATE INDEX idx_marks_student ON public.marks(student_id);
CREATE INDEX idx_timetable_course ON public.timetable_slots(course_id);
CREATE INDEX idx_substitution_assignments_substitute
  ON public.substitution_assignments(substitute_teacher_id);

-- ---------------------------------------------------- helpers + RLS

CREATE OR REPLACE FUNCTION public.get_my_college_id() RETURNS UUID AS $$
  SELECT college_id FROM public.profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.get_my_role() RETURNS TEXT AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

ALTER TABLE public.attendance                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marks                          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_enrollments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.substitution_assignments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_correction_requests ENABLE ROW LEVEL SECURITY;

-- The pre-047 policies 047 section 7 must drop or replace.
CREATE POLICY "attendance_teacher_mark" ON public.attendance
  FOR INSERT WITH CHECK (college_id = public.get_my_college_id() AND public.get_my_role() IN ('teacher','admin'));
CREATE POLICY "attendance_teacher_update" ON public.attendance
  FOR UPDATE USING (marked_by = auth.uid() OR public.get_my_role() = 'admin');
CREATE POLICY "attendance_hod_update" ON public.attendance
  FOR UPDATE USING (college_id = public.get_my_college_id() AND public.get_my_role() = 'hod');
CREATE POLICY "attendance_read_student" ON public.attendance
  FOR SELECT USING (student_id IN (SELECT id FROM public.students WHERE user_id = auth.uid()));
CREATE POLICY "attendance_read_staff" ON public.attendance
  FOR SELECT USING (college_id = public.get_my_college_id() AND public.get_my_role() IN ('teacher','hod','director','admin'));
CREATE POLICY "marks_teacher_manage" ON public.marks
  FOR ALL USING (college_id = public.get_my_college_id() AND public.get_my_role() IN ('teacher','admin'));
CREATE POLICY "marks_read_student" ON public.marks
  FOR SELECT USING (student_id IN (SELECT id FROM public.students WHERE user_id = auth.uid()));
CREATE POLICY "marks_read_staff" ON public.marks
  FOR SELECT USING (college_id = public.get_my_college_id() AND public.get_my_role() IN ('teacher','hod','director','admin'));
CREATE POLICY "attendance_correction_update_staff" ON public.attendance_correction_requests
  FOR UPDATE USING (college_id = public.get_my_college_id() AND public.get_my_role() IN ('hod','admin'));
CREATE POLICY "course_enrollments_read_own" ON public.course_enrollments
  FOR SELECT USING (student_id = auth.uid());
CREATE POLICY "substitution_read_enrolled_student" ON public.substitution_assignments
  FOR SELECT USING (
    status = 'assigned'
    AND EXISTS (
      SELECT 1 FROM public.course_enrollments ce
      WHERE ce.course_id = substitution_assignments.course_id
        AND ce.student_id = auth.uid()
        AND ce.status = 'enrolled'
    )
  );

-- The rest of the pre-047 policy set on these tables. None reference a
-- dropped column, so 047 leaves them alone -- which is exactly what the
-- final policy-inventory assertion needs to be able to see.
CREATE POLICY "course_enrollments_read_staff" ON public.course_enrollments
  FOR SELECT USING (college_id = public.get_my_college_id()
                    AND public.get_my_role() IN ('teacher','hod','director','admin'));
CREATE POLICY "timetable_read" ON public.timetable_slots
  FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "substitution_read_own" ON public.substitution_assignments
  FOR SELECT USING (original_teacher_id = auth.uid() OR substitute_teacher_id = auth.uid());
CREATE POLICY "substitution_read_staff" ON public.substitution_assignments
  FOR SELECT USING (college_id = public.get_my_college_id()
                    AND public.get_my_role() IN ('hod','admin'));
CREATE POLICY "substitution_insert_staff" ON public.substitution_assignments
  FOR INSERT WITH CHECK (college_id = public.get_my_college_id()
                         AND public.get_my_role() IN ('hod','admin'));
CREATE POLICY "substitution_update_staff" ON public.substitution_assignments
  FOR UPDATE USING (college_id = public.get_my_college_id()
                    AND public.get_my_role() IN ('hod','admin'));
CREATE POLICY "attendance_correction_read_own" ON public.attendance_correction_requests
  FOR SELECT USING (submitted_by = auth.uid());
CREATE POLICY "attendance_correction_read_staff" ON public.attendance_correction_requests
  FOR SELECT USING (college_id = public.get_my_college_id()
                    AND public.get_my_role() IN ('hod','admin'));
CREATE POLICY "attendance_correction_insert_own" ON public.attendance_correction_requests
  FOR INSERT WITH CHECK (submitted_by = auth.uid());

ALTER TABLE public.timetable_slots ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------- pre-047 analytics views
--
-- Section 0 of the migration must drop these before it can drop
-- attendance.course_id. If it ever stops doing so, applying 047 fails here
-- rather than in production.

CREATE MATERIALIZED VIEW public.mv_attendance_summary_raw AS
SELECT
  a.college_id, s.department_id, a.course_id,
  c.name AS course_name, c.code AS course_code,
  COUNT(*) FILTER (WHERE a.status = 'present') AS present_count,
  COUNT(*) FILTER (WHERE a.status = 'late') AS late_count,
  COUNT(*) FILTER (WHERE a.status = 'absent') AS absent_count,
  COUNT(*) AS total_count,
  ROUND(COUNT(*) FILTER (WHERE a.status IN ('present','late'))::NUMERIC / NULLIF(COUNT(*),0) * 100, 1) AS attendance_pct
FROM public.attendance a
JOIN public.students s ON a.student_id = s.id
JOIN public.courses c ON a.course_id = c.id
GROUP BY a.college_id, s.department_id, a.course_id, c.name, c.code;

REVOKE ALL ON public.mv_attendance_summary_raw FROM anon, authenticated;

CREATE VIEW public.mv_attendance_summary AS
  SELECT * FROM public.mv_attendance_summary_raw
  WHERE college_id = public.get_my_college_id();

CREATE MATERIALIZED VIEW public.mv_department_health_raw AS
WITH dept_students AS (
  SELECT s.college_id, s.department_id, d.name AS department_name, d.code AS department_code,
         COUNT(*) AS total_students, ROUND(AVG(s.cgpa), 2) AS avg_cgpa
  FROM public.students s JOIN public.departments d ON s.department_id = d.id
  WHERE s.status = 'active'
  GROUP BY s.college_id, s.department_id, d.name, d.code
)
SELECT ds.college_id, ds.department_id, ds.department_name, ds.department_code,
       ds.total_students, ds.avg_cgpa,
       NULL::NUMERIC AS attendance_pct, 0::BIGINT AS backlog_count,
       NULL::NUMERIC AS backlog_rate, NULL::NUMERIC AS fee_collection_pct,
       NULL::NUMERIC AS placement_rate
FROM dept_students ds;

REVOKE ALL ON public.mv_department_health_raw FROM anon, authenticated;

CREATE VIEW public.mv_department_health AS
  SELECT * FROM public.mv_department_health_raw
  WHERE college_id = public.get_my_college_id();

-- ------------------------------------------------------------- data
--
-- Master data only. The six restructured tables stay empty, matching the
-- real database and making 047's NOT NULL column additions legal.

INSERT INTO public.colleges VALUES ('00000000-0000-4000-8000-0000000000c1', 'QA College');
INSERT INTO public.profiles (id, college_id, role, full_name) VALUES
  ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-0000000000c1', 'teacher', 'QA Teacher A'),
  ('00000000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-0000000000c1', 'hod', 'QA HOD A');
INSERT INTO public.departments VALUES
  ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-0000000000c1', 'QA Dept A', 'QAA', '00000000-0000-4000-8000-00000000a003');
INSERT INTO public.courses (id, college_id, department_id, name, code) VALUES
  ('00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000d001', 'QA Course A', 'QA101');
INSERT INTO public.students (id, college_id, department_id, enrollment_number, cgpa) VALUES
  ('00000000-0000-4000-8000-000000012001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000d001', 'QA-A', 7.5);
INSERT INTO public.academic_years VALUES
  ('00000000-0000-4000-8000-000000019001', '00000000-0000-4000-8000-0000000000c1', 'QA 2026-27', 'active');
INSERT INTO public.semesters (id, college_id, academic_year_id, name, sequence_no, status) VALUES
  ('00000000-0000-4000-8000-000000011001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000019001', 'QA Sem 1', 1, 'active');
INSERT INTO public.programmes VALUES
  ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000d001', 'QA Programme A', 'QAP');
INSERT INTO public.sections VALUES
  ('00000000-0000-4000-8000-000000010001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000f001', 2024, 'A');
INSERT INTO public.course_offerings VALUES
  ('00000000-0000-4000-8000-000000013001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000011001',
   '00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-000000010001', '00000000-0000-4000-8000-00000000a001', 'active');

-- The analytics objects 047 does NOT touch. They matter because
-- refresh_analytics() names all six, and it uses REFRESH ... CONCURRENTLY,
-- which requires every one of them to carry a unique index and to have been
-- populated at least once. If 047 rebuilt a matview without its unique
-- index, nothing would fail during the migration -- the next scheduled
-- refresh would fail instead, in a cron job, where nobody is watching.

CREATE MATERIALIZED VIEW public.mv_department_enrollment_raw AS
SELECT s.college_id, s.department_id, d.name AS department_name,
       COUNT(*) AS total_students
FROM public.students s JOIN public.departments d ON s.department_id = d.id
GROUP BY s.college_id, s.department_id, d.name;
CREATE UNIQUE INDEX idx_mv_department_enrollment
  ON public.mv_department_enrollment_raw(college_id, department_id);

CREATE MATERIALIZED VIEW public.mv_fee_summary_raw AS
SELECT f.college_id, SUM(f.amount) AS total_billed, SUM(f.paid_amount) AS total_collected
FROM public.fees f GROUP BY f.college_id;
CREATE UNIQUE INDEX idx_mv_fee_summary ON public.mv_fee_summary_raw(college_id);

CREATE MATERIALIZED VIEW public.mv_placement_summary_raw AS
SELECT spp.college_id, COUNT(*) FILTER (WHERE spp.placement_status = 'placed') AS total_placed
FROM public.student_placement_profiles spp GROUP BY spp.college_id;
CREATE UNIQUE INDEX idx_mv_placement_summary ON public.mv_placement_summary_raw(college_id);

CREATE MATERIALIZED VIEW public.mv_placement_funnel_raw AS
SELECT s.college_id, s.department_id, COUNT(*) AS total_students
FROM public.students s
LEFT JOIN public.student_placement_profiles spp ON spp.student_id = s.id
GROUP BY s.college_id, s.department_id;
CREATE UNIQUE INDEX idx_mv_placement_funnel
  ON public.mv_placement_funnel_raw(college_id, department_id);

-- Verbatim from migration 033 -- the current definition.
CREATE OR REPLACE FUNCTION public.refresh_analytics()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_attendance_summary_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_fee_summary_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_department_enrollment_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_placement_summary_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_department_health_raw;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_placement_funnel_raw;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REFRESH MATERIALIZED VIEW public.mv_attendance_summary_raw;
REFRESH MATERIALIZED VIEW public.mv_department_health_raw;
REFRESH MATERIALIZED VIEW public.mv_department_enrollment_raw;
REFRESH MATERIALIZED VIEW public.mv_fee_summary_raw;
REFRESH MATERIALIZED VIEW public.mv_placement_summary_raw;
REFRESH MATERIALIZED VIEW public.mv_placement_funnel_raw;
