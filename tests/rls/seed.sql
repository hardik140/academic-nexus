-- ============================================================
-- Synthetic QA fixtures for the RLS authority tests.
--
-- Entirely fictional. Nothing here corresponds to a real institution,
-- person or student record, and this data never reaches a real database —
-- it is created inside an in-process PGlite instance that is discarded at
-- the end of each test.
--
-- Two departments, so cross-department denial is expressible; two teachers,
-- so cross-offering denial is expressible; two students, so cross-student
-- denial is expressible. A teaching HOD and a non-teaching HOD are separate
-- people because conflating them is exactly the case the authority model
-- turns on.
-- ============================================================

INSERT INTO public.colleges (id, name) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'QA College'),
  ('00000000-0000-4000-8000-0000000000c2', 'QA Other College');

INSERT INTO public.profiles (id, college_id, role, full_name) VALUES
  -- QA College
  ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-0000000000c1', 'teacher',   'QA Teacher A'),
  ('00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-0000000000c1', 'teacher',   'QA Teacher B'),
  ('00000000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-0000000000c1', 'hod',       'QA HOD A (non-teaching)'),
  ('00000000-0000-4000-8000-00000000a004', '00000000-0000-4000-8000-0000000000c1', 'hod',       'QA HOD B (non-teaching)'),
  ('00000000-0000-4000-8000-00000000a005', '00000000-0000-4000-8000-0000000000c1', 'hod',       'QA Teaching HOD'),
  ('00000000-0000-4000-8000-00000000a006', '00000000-0000-4000-8000-0000000000c1', 'teacher',   'QA Substitute'),
  ('00000000-0000-4000-8000-00000000a007', '00000000-0000-4000-8000-0000000000c1', 'admin',     'QA Admin'),
  ('00000000-0000-4000-8000-00000000a008', '00000000-0000-4000-8000-0000000000c1', 'finance',   'QA Finance'),
  ('00000000-0000-4000-8000-00000000a009', '00000000-0000-4000-8000-0000000000c1', 'warden',    'QA Warden'),
  ('00000000-0000-4000-8000-00000000a010', '00000000-0000-4000-8000-0000000000c1', 'director',  'QA Director'),
  ('00000000-0000-4000-8000-00000000a011', '00000000-0000-4000-8000-0000000000c1', 'student',   'QA Student A'),
  ('00000000-0000-4000-8000-00000000a012', '00000000-0000-4000-8000-0000000000c1', 'student',   'QA Student B'),
  ('00000000-0000-4000-8000-00000000a013', '00000000-0000-4000-8000-0000000000c1', 'super_admin','QA Super Admin'),
  ('00000000-0000-4000-8000-00000000a014', '00000000-0000-4000-8000-0000000000c1', 'student',   'QA Student C (enrolled nowhere)'),
  -- a different tenant entirely
  ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-0000000000c2', 'teacher',   'QA Foreign Teacher');

-- Department A is headed by HOD A *and* by the Teaching HOD is NOT true:
-- the teaching HOD heads Department A too would conflate the cases, so the
-- teaching HOD heads nothing and draws authority purely from an assignment.
INSERT INTO public.departments (id, college_id, name, hod_id) VALUES
  ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-0000000000c1', 'QA Dept A', '00000000-0000-4000-8000-00000000a003'),
  ('00000000-0000-4000-8000-00000000d002', '00000000-0000-4000-8000-0000000000c1', 'QA Dept B', '00000000-0000-4000-8000-00000000a004');

INSERT INTO public.courses (id, college_id, department_id, name, code) VALUES
  ('00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000d001', 'QA Course A', 'QA101'),
  ('00000000-0000-4000-8000-00000000e002', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000d002', 'QA Course B', 'QA201');

INSERT INTO public.programmes (id, college_id, department_id, name) VALUES
  ('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000d001', 'QA Programme A'),
  ('00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000d002', 'QA Programme B');

INSERT INTO public.sections (id, college_id, programme_id, name) VALUES
  ('00000000-0000-4000-8000-000000010001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000f001', 'A'),
  ('00000000-0000-4000-8000-000000010002', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000f001', 'B'),
  ('00000000-0000-4000-8000-000000010003', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000f002', 'C');

INSERT INTO public.semesters (id, college_id, name, status) VALUES
  ('00000000-0000-4000-8000-000000011001', '00000000-0000-4000-8000-0000000000c1', 'QA Sem 1', 'active');

INSERT INTO public.students (id, college_id, user_id, department_id, enrollment_number) VALUES
  ('00000000-0000-4000-8000-000000012001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000a011', '00000000-0000-4000-8000-00000000d001', 'QA-A'),
  ('00000000-0000-4000-8000-000000012002', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000a012', '00000000-0000-4000-8000-00000000d001', 'QA-B'),
  -- Student C is a real, active student of this college who is enrolled in
  -- NO offering. Needed to tell "this student does not exist" apart from
  -- "this student is not in this class" — the enrollment guard must reject
  -- the second case just as firmly as the first.
  ('00000000-0000-4000-8000-000000012003', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000a014', '00000000-0000-4000-8000-00000000d001', 'QA-C');

-- OFF_A  Dept A, Teacher A          OFF_B  Dept B, Teacher B
-- OFF_H  Dept A, Teaching HOD       OFF_X  Dept A, Teacher A, cancelled
INSERT INTO public.course_offerings (id, college_id, semester_id, course_id, section_id, instructor_id, status) VALUES
  ('00000000-0000-4000-8000-000000013001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000011001', '00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-000000010001', '00000000-0000-4000-8000-00000000a001', 'active'),
  ('00000000-0000-4000-8000-000000013002', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000011001', '00000000-0000-4000-8000-00000000e002', '00000000-0000-4000-8000-000000010003', '00000000-0000-4000-8000-00000000a002', 'active'),
  ('00000000-0000-4000-8000-000000013003', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000011001', '00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-000000010002', '00000000-0000-4000-8000-00000000a005', 'active'),
  ('00000000-0000-4000-8000-000000013004', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000011001', '00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-000000010001', '00000000-0000-4000-8000-00000000a001', 'cancelled');

INSERT INTO public.course_enrollments (college_id, offering_id, student_id, status) VALUES
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000013001', '00000000-0000-4000-8000-000000012001', 'enrolled'),
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000013001', '00000000-0000-4000-8000-000000012002', 'enrolled');

-- One existing attendance row on OFF_A, marked by Teacher A, so UPDATE
-- paths have something to target.
INSERT INTO public.attendance (id, college_id, offering_id, student_id, date, status, marked_by) VALUES
  ('00000000-0000-4000-8000-000000014001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000013001', '00000000-0000-4000-8000-000000012001', '2026-09-10', 'present', '00000000-0000-4000-8000-00000000a001');

INSERT INTO public.marks (id, college_id, offering_id, student_id, exam_type, max_marks, obtained_marks, entered_by) VALUES
  ('00000000-0000-4000-8000-000000015001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000013001', '00000000-0000-4000-8000-000000012001', 'midterm', 100, 70, '00000000-0000-4000-8000-00000000a001');
