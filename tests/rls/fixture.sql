-- ============================================================
-- Test fixture for tests/rls-offering-authority.test.ts
--
-- The minimum schema migration 047's section 7 needs in order to be
-- executed and exercised for real. This is NOT a second copy of the
-- production schema and must not grow into one: it exists so the policies
-- under test can be evaluated by an actual PostgreSQL RLS engine rather
-- than asserted about in prose.
--
-- Tables are in their POST-047 shape (offering_id, no course_id) because
-- that is the schema the policies address. Columns no policy reads are
-- omitted, and substitution_assignments.leave_request_id is nullable here
-- rather than pulling in leave_requests — no policy under test references
-- it.
--
-- The OLD policies from 006/037/038 are installed below on purpose. RLS
-- policies are permissive and OR together, so a new narrow policy proves
-- nothing unless the broad one it replaces is actually gone. Installing
-- them first means the tests fail if 047 ever stops dropping them.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS auth;

-- Stands in for Supabase GoTrue's auth.uid(). Reads a session GUC the test
-- harness sets, which is how a test "logs in" as a given user.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('test.user_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------- tables

CREATE TABLE public.colleges (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL
);

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
  hod_id UUID REFERENCES public.profiles(id)   -- deliberately NOT unique (002)
);

CREATE TABLE public.courses (
  id UUID PRIMARY KEY,
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  department_id UUID REFERENCES public.departments(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  instructor_id UUID REFERENCES public.profiles(id)   -- deprecated by 047
);

CREATE TABLE public.programmes (
  id UUID PRIMARY KEY,
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  department_id UUID NOT NULL REFERENCES public.departments(id),
  name TEXT NOT NULL
);

CREATE TABLE public.sections (
  id UUID PRIMARY KEY,
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  programme_id UUID NOT NULL REFERENCES public.programmes(id),
  name TEXT NOT NULL
);

CREATE TABLE public.semesters (
  id UUID PRIMARY KEY,
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE public.students (
  id UUID PRIMARY KEY,
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  user_id UUID REFERENCES public.profiles(id),
  department_id UUID REFERENCES public.departments(id),
  enrollment_number TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE public.course_offerings (
  id UUID PRIMARY KEY,
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  semester_id UUID NOT NULL REFERENCES public.semesters(id),
  course_id UUID NOT NULL REFERENCES public.courses(id),
  section_id UUID NOT NULL REFERENCES public.sections(id),
  instructor_id UUID REFERENCES public.profiles(id),
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE public.course_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  offering_id UUID NOT NULL REFERENCES public.course_offerings(id),
  student_id UUID NOT NULL REFERENCES public.students(id),
  status TEXT NOT NULL DEFAULT 'enrolled',
  UNIQUE (offering_id, student_id)
);

CREATE TABLE public.attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  offering_id UUID NOT NULL REFERENCES public.course_offerings(id),
  student_id UUID NOT NULL REFERENCES public.students(id),
  date DATE NOT NULL,
  status TEXT NOT NULL,
  marked_by UUID REFERENCES public.profiles(id),
  UNIQUE (offering_id, student_id, date)
);

CREATE TABLE public.marks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  offering_id UUID NOT NULL REFERENCES public.course_offerings(id),
  student_id UUID NOT NULL REFERENCES public.students(id),
  exam_type TEXT NOT NULL,
  max_marks NUMERIC,
  obtained_marks NUMERIC,
  entered_by UUID REFERENCES public.profiles(id),
  UNIQUE (offering_id, student_id, exam_type)
);

CREATE TABLE public.attendance_correction_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  attendance_id UUID NOT NULL REFERENCES public.attendance(id),
  student_id UUID NOT NULL REFERENCES public.students(id),
  offering_id UUID NOT NULL REFERENCES public.course_offerings(id),
  date DATE NOT NULL,
  current_status TEXT NOT NULL,
  requested_status TEXT NOT NULL,
  reason TEXT,
  submitted_by UUID NOT NULL REFERENCES public.profiles(id),
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by UUID REFERENCES public.profiles(id),
  reviewed_at TIMESTAMPTZ
);

CREATE TABLE public.substitution_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id),
  leave_request_id UUID,
  offering_id UUID NOT NULL REFERENCES public.course_offerings(id),
  original_teacher_id UUID NOT NULL REFERENCES public.profiles(id),
  substitute_teacher_id UUID REFERENCES public.profiles(id),
  date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'needed',
  UNIQUE (offering_id, date)
);

-- --------------------------------------------------- helpers from 006

CREATE OR REPLACE FUNCTION public.get_my_college_id() RETURNS UUID AS $$
  SELECT college_id FROM public.profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.get_my_role() RETURNS TEXT AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ------------------------------------------------------------------ RLS

ALTER TABLE public.colleges                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.departments                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courses                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.programmes                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sections                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.semesters                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.students                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_offerings              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_enrollments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marks                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_correction_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.substitution_assignments      ENABLE ROW LEVEL SECURITY;

-- Supporting reads (046 / 006), unchanged by 047.
CREATE POLICY "course_offerings_read" ON public.course_offerings
  FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "courses_read" ON public.courses
  FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "departments_read" ON public.departments
  FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "students_read_staff" ON public.students
  FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "semesters_read" ON public.semesters
  FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "profiles_read" ON public.profiles
  FOR SELECT USING (college_id = public.get_my_college_id());

-- READ policies on the academic tables. 047 must NOT touch these; a test
-- asserts they survive.
CREATE POLICY "attendance_read_student" ON public.attendance
  FOR SELECT USING (
    student_id IN (SELECT id FROM public.students WHERE user_id = auth.uid())
  );
CREATE POLICY "attendance_read_staff" ON public.attendance
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('teacher', 'hod', 'director', 'admin')
  );
CREATE POLICY "marks_read_student" ON public.marks
  FOR SELECT USING (
    student_id IN (SELECT id FROM public.students WHERE user_id = auth.uid())
  );
CREATE POLICY "marks_read_staff" ON public.marks
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('teacher', 'hod', 'director', 'admin')
  );

-- ============================================================
-- THE PRE-047 WRITE POLICIES — the C1 defect itself.
--
-- Verbatim from migrations 006, 037 and 038. None of them reference a
-- column 047 drops, so they install unchanged on the post-047 shape.
-- Section 7 of 047 must drop every one of these; if it stops doing so,
-- these permissive policies OR back in and the tests below fail.
-- ============================================================

CREATE POLICY "attendance_teacher_mark" ON public.attendance
  FOR INSERT WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('teacher', 'admin')
  );

CREATE POLICY "attendance_teacher_update" ON public.attendance
  FOR UPDATE USING (
    marked_by = auth.uid()
    OR public.get_my_role() = 'admin'
  );

CREATE POLICY "attendance_hod_update" ON public.attendance
  FOR UPDATE USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() = 'hod'
  );

CREATE POLICY "marks_teacher_manage" ON public.marks
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('teacher', 'admin')
  );

CREATE POLICY "attendance_correction_read_staff" ON public.attendance_correction_requests
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('hod', 'admin')
  );

CREATE POLICY "attendance_correction_update_staff" ON public.attendance_correction_requests
  FOR UPDATE USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('hod', 'admin')
  );

CREATE POLICY "substitution_read_own" ON public.substitution_assignments
  FOR SELECT USING (
    original_teacher_id = auth.uid() OR substitute_teacher_id = auth.uid()
  );

CREATE POLICY "course_enrollments_read_staff" ON public.course_enrollments
  FOR SELECT USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('teacher', 'hod', 'director', 'admin')
  );

-- ----------------------------------------------------------- test role

CREATE ROLE authenticated NOLOGIN;
GRANT USAGE ON SCHEMA public, auth TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated;
