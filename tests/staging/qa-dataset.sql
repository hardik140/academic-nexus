-- ============================================================
-- QA-2026 synthetic institutional dataset.
--
-- Every row here is prefixed QA- and lives in two colleges created by this
-- file. Nothing touches the demo college migration 008 seeds, so a database
-- that already holds data keeps it.
--
-- The dataset exists to make the offering model FALSIFIABLE. Three of its
-- choices carry the whole suite:
--
--   1. Data Structures is delivered THREE times - CSE-A/Sem3, CSE-B/Sem3
--      and CSE-A/Sem5 - by three different teachers. Any authority check
--      that resolves through the course rather than the offering grants all
--      three at once, and the section-isolation tests catch it.
--
--   2. Student C is enrolled ONLY in the CSE-B delivery. A roster query
--      that widens to the course would pull Student C into Teacher A's
--      CSE-A class, which is what a cross-section leak looks like in
--      production.
--
--   3. HOD-CSE is independently assigned as instructor of one offering.
--      That separates "can write because they hold the offering" from
--      "can write because they are an HOD" - the distinction the whole
--      authority model rests on, and one a single-role fixture cannot test.
--
-- UUIDs are fixed and grouped by entity so a failing assertion names
-- something readable: 0000000a-... is always an offering, 00000004-...
-- always a student row.
--
-- Users are created the way the application creates them: INSERT into
-- auth.users, let 043's hardened handle_new_user() trigger mint an inert
-- ('student','pending') profile, then elevate through what is, in
-- production, the service-role path. Seeding public.profiles directly
-- would skip the trigger this schema actually has.
-- ============================================================

-- --- Colleges (two, for tenancy isolation) ---
INSERT INTO public.colleges (id, name, code, city, country) VALUES
  ('00000001-0000-4000-8000-000000000001', 'QA Institute of Technology', 'QA-COL-A', 'Pune', 'India'),
  ('00000001-0000-4000-8000-000000000002', 'QA College of Engineering', 'QA-COL-B', 'Hyderabad', 'India');

-- --- Departments ---
INSERT INTO public.departments (id, college_id, name, code) VALUES
  ('00000002-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', 'QA Computer Science', 'QA-CSE'),
  ('00000002-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000001', 'QA Electronics', 'QA-ECE'),
  ('00000002-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000001', 'QA Mechanical', 'QA-MECH'),
  ('00000002-0000-4000-8000-000000000004', '00000001-0000-4000-8000-000000000002', 'QA-B Computer Science', 'QA-B-CSE');

-- --- Users ---
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000003-0000-4000-8000-000000000001', 'qa.hod.cse@qa.test',   jsonb_build_object('full_name','QA HOD CSE (teaching)','college_id','00000001-0000-4000-8000-000000000001')),
  ('00000003-0000-4000-8000-000000000002', 'qa.hod.ece@qa.test',   jsonb_build_object('full_name','QA HOD ECE','college_id','00000001-0000-4000-8000-000000000001')),
  ('00000003-0000-4000-8000-000000000003', 'qa.teacher.a@qa.test', jsonb_build_object('full_name','QA Teacher A','college_id','00000001-0000-4000-8000-000000000001')),
  ('00000003-0000-4000-8000-000000000004', 'qa.teacher.b@qa.test', jsonb_build_object('full_name','QA Teacher B','college_id','00000001-0000-4000-8000-000000000001')),
  ('00000003-0000-4000-8000-000000000005', 'qa.teacher.c@qa.test', jsonb_build_object('full_name','QA Teacher C','college_id','00000001-0000-4000-8000-000000000001')),
  ('00000003-0000-4000-8000-000000000006', 'qa.student.a@qa.test', jsonb_build_object('full_name','QA Student A','college_id','00000001-0000-4000-8000-000000000001')),
  ('00000003-0000-4000-8000-000000000007', 'qa.student.b@qa.test', jsonb_build_object('full_name','QA Student B','college_id','00000001-0000-4000-8000-000000000001')),
  ('00000003-0000-4000-8000-000000000008', 'qa.student.c@qa.test', jsonb_build_object('full_name','QA Student C','college_id','00000001-0000-4000-8000-000000000001')),
  ('00000003-0000-4000-8000-000000000009', 'qa.student.d@qa.test', jsonb_build_object('full_name','QA Student D','college_id','00000001-0000-4000-8000-000000000001')),
  ('00000003-0000-4000-8000-00000000000a', 'qa.student.e@qa.test', jsonb_build_object('full_name','QA Student E','college_id','00000001-0000-4000-8000-000000000001')),
  ('00000003-0000-4000-8000-00000000000b', 'qa.student.f@qa.test', jsonb_build_object('full_name','QA Student F','college_id','00000001-0000-4000-8000-000000000001')),
  ('00000003-0000-4000-8000-00000000000c', 'qa.director@qa.test',  jsonb_build_object('full_name','QA Director','college_id','00000001-0000-4000-8000-000000000001')),
  ('00000003-0000-4000-8000-00000000000d', 'qa.finance@qa.test',   jsonb_build_object('full_name','QA Finance','college_id','00000001-0000-4000-8000-000000000001')),
  ('00000003-0000-4000-8000-00000000000e', 'qa.warden@qa.test',    jsonb_build_object('full_name','QA Warden','college_id','00000001-0000-4000-8000-000000000001')),
  ('00000003-0000-4000-8000-00000000000f', 'qa.admin@qa.test',     jsonb_build_object('full_name','QA Admin','college_id','00000001-0000-4000-8000-000000000001')),
  ('00000003-0000-4000-8000-000000000010', 'qa.super@qa.test',     jsonb_build_object('full_name','QA Super Admin','college_id','00000001-0000-4000-8000-000000000001')),
  ('00000003-0000-4000-8000-000000000011', 'qa.b.teacher@qa.test', jsonb_build_object('full_name','QA-B Teacher','college_id','00000001-0000-4000-8000-000000000002')),
  ('00000003-0000-4000-8000-000000000012', 'qa.b.student@qa.test', jsonb_build_object('full_name','QA-B Student','college_id','00000001-0000-4000-8000-000000000002')),
  ('00000003-0000-4000-8000-000000000013', 'qa.b.hod@qa.test',     jsonb_build_object('full_name','QA-B HOD','college_id','00000001-0000-4000-8000-000000000002')),
  ('00000003-0000-4000-8000-000000000014', 'qa.hod.mech@qa.test',  jsonb_build_object('full_name','QA HOD MECH','college_id','00000001-0000-4000-8000-000000000001'));

UPDATE public.profiles SET role = 'hod', status = 'active', department_id = '00000002-0000-4000-8000-000000000001' WHERE id = '00000003-0000-4000-8000-000000000001';
UPDATE public.profiles SET role = 'hod', status = 'active', department_id = '00000002-0000-4000-8000-000000000002' WHERE id = '00000003-0000-4000-8000-000000000002';
UPDATE public.profiles SET role = 'teacher', status = 'active', department_id = '00000002-0000-4000-8000-000000000001' WHERE id IN
  ('00000003-0000-4000-8000-000000000003','00000003-0000-4000-8000-000000000004','00000003-0000-4000-8000-000000000005');
UPDATE public.profiles SET role = 'student', status = 'active', department_id = '00000002-0000-4000-8000-000000000001' WHERE id IN
  ('00000003-0000-4000-8000-000000000006','00000003-0000-4000-8000-000000000007','00000003-0000-4000-8000-000000000008',
   '00000003-0000-4000-8000-000000000009','00000003-0000-4000-8000-00000000000a','00000003-0000-4000-8000-00000000000b');
UPDATE public.profiles SET role = 'director',    status = 'active' WHERE id = '00000003-0000-4000-8000-00000000000c';
UPDATE public.profiles SET role = 'finance',     status = 'active' WHERE id = '00000003-0000-4000-8000-00000000000d';
UPDATE public.profiles SET role = 'warden',      status = 'active' WHERE id = '00000003-0000-4000-8000-00000000000e';
UPDATE public.profiles SET role = 'admin',       status = 'active' WHERE id = '00000003-0000-4000-8000-00000000000f';
UPDATE public.profiles SET role = 'super_admin', status = 'active' WHERE id = '00000003-0000-4000-8000-000000000010';
UPDATE public.profiles SET role = 'teacher', status = 'active', department_id = '00000002-0000-4000-8000-000000000004' WHERE id = '00000003-0000-4000-8000-000000000011';
UPDATE public.profiles SET role = 'student', status = 'active', department_id = '00000002-0000-4000-8000-000000000004' WHERE id = '00000003-0000-4000-8000-000000000012';
UPDATE public.profiles SET role = 'hod',     status = 'active', department_id = '00000002-0000-4000-8000-000000000004' WHERE id = '00000003-0000-4000-8000-000000000013';
UPDATE public.profiles SET role = 'hod',     status = 'active', department_id = '00000002-0000-4000-8000-000000000003' WHERE id = '00000003-0000-4000-8000-000000000014';

-- departments.hod_id is the ONLY source of HOD review scope
-- (resolveHodDepartmentIds reads exactly this).
UPDATE public.departments SET hod_id = '00000003-0000-4000-8000-000000000001' WHERE id = '00000002-0000-4000-8000-000000000001';
UPDATE public.departments SET hod_id = '00000003-0000-4000-8000-000000000002' WHERE id = '00000002-0000-4000-8000-000000000002';
UPDATE public.departments SET hod_id = '00000003-0000-4000-8000-000000000013' WHERE id = '00000002-0000-4000-8000-000000000004';
UPDATE public.departments SET hod_id = '00000003-0000-4000-8000-000000000014' WHERE id = '00000002-0000-4000-8000-000000000003';

-- --- Student records ---
INSERT INTO public.students (id, college_id, user_id, department_id, enrollment_number, batch_year, semester) VALUES
  ('00000004-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', '00000003-0000-4000-8000-000000000006', '00000002-0000-4000-8000-000000000001', 'QA-2026-CSE-001', 2024, 3),
  ('00000004-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000001', '00000003-0000-4000-8000-000000000007', '00000002-0000-4000-8000-000000000001', 'QA-2026-CSE-002', 2024, 3),
  ('00000004-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000001', '00000003-0000-4000-8000-000000000008', '00000002-0000-4000-8000-000000000001', 'QA-2026-CSE-003', 2024, 3),
  ('00000004-0000-4000-8000-000000000004', '00000001-0000-4000-8000-000000000001', '00000003-0000-4000-8000-000000000009', '00000002-0000-4000-8000-000000000001', 'QA-2026-CSE-004', 2024, 3),
  ('00000004-0000-4000-8000-000000000005', '00000001-0000-4000-8000-000000000001', '00000003-0000-4000-8000-00000000000a', '00000002-0000-4000-8000-000000000001', 'QA-2026-CSE-005', 2023, 5),
  ('00000004-0000-4000-8000-000000000006', '00000001-0000-4000-8000-000000000001', '00000003-0000-4000-8000-00000000000b', '00000002-0000-4000-8000-000000000001', 'QA-2026-CSE-006', 2023, 5),
  ('00000004-0000-4000-8000-000000000007', '00000001-0000-4000-8000-000000000002', '00000003-0000-4000-8000-000000000012', '00000002-0000-4000-8000-000000000004', 'QA-2026-BCSE-001', 2024, 3);

-- --- Academic years ---
INSERT INTO public.academic_years (id, college_id, name, start_date, end_date, status) VALUES
  ('00000005-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', 'QA 2026-27', '2026-06-01', '2027-05-31', 'active'),
  ('00000005-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000001', 'QA 2025-26', '2025-06-01', '2026-05-31', 'closed'),
  ('00000005-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000002', 'QA-B 2026-27', '2026-06-01', '2027-05-31', 'active');

-- --- Semesters ---
INSERT INTO public.semesters (id, college_id, name, start_date, end_date, academic_year, academic_year_id, sequence_no, status, is_current) VALUES
  -- NOTE: a row here is an institutional TERM (046: 'Fall 2026'), not a
  -- programme's semester number. "1st, 3rd and 5th semester running at
  -- once" is ONE active term with three sections of different batch_year,
  -- so idx_semesters_one_active is the right invariant. These rows are named
  -- "Semester N" for readability of the tests that reference them; only one
  -- is active because only one term is. (An earlier note here called the
  -- index a finding -- that was a misread of the model, corrected in Phase 11.)
  ('00000006-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', 'QA Semester 1', '2026-06-01', '2026-11-30', 'QA 2026-27', '00000005-0000-4000-8000-000000000001', 1, 'planned', false),
  ('00000006-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000001', 'QA Semester 3', '2026-06-01', '2026-11-30', 'QA 2026-27', '00000005-0000-4000-8000-000000000001', 3, 'active', true),
  ('00000006-0000-4000-8000-000000000005', '00000001-0000-4000-8000-000000000001', 'QA Semester 5', '2026-06-01', '2026-11-30', 'QA 2026-27', '00000005-0000-4000-8000-000000000001', 5, 'planned', false),
  -- Historical: same sequence number, one academic year back.
  ('00000006-0000-4000-8000-000000000009', '00000001-0000-4000-8000-000000000001', 'QA Semester 3 (2025-26)', '2025-06-01', '2025-11-30', 'QA 2025-26', '00000005-0000-4000-8000-000000000002', 3, 'closed', false),
  ('00000006-0000-4000-8000-00000000000b', '00000001-0000-4000-8000-000000000002', 'QA-B Semester 3', '2026-06-01', '2026-11-30', 'QA-B 2026-27', '00000005-0000-4000-8000-000000000003', 3, 'active', true);

-- --- Programmes ---
INSERT INTO public.programmes (id, college_id, department_id, name, code, degree_type, duration_semesters) VALUES
  ('00000007-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000001', 'QA B.Tech Computer Science', 'QA-BT-CSE', 'undergraduate', 8),
  ('00000007-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000002', 'QA B.Tech Electronics', 'QA-BT-ECE', 'undergraduate', 8),
  ('00000007-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003', 'QA B.Tech Mechanical', 'QA-BT-MECH', 'undergraduate', 8),
  ('00000007-0000-4000-8000-000000000004', '00000001-0000-4000-8000-000000000002', '00000002-0000-4000-8000-000000000004', 'QA-B B.Tech Computer Science', 'QA-B-BT-CSE', 'undergraduate', 8);

-- --- Sections ---
INSERT INTO public.sections (id, college_id, programme_id, batch_year, name, capacity) VALUES
  ('00000008-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', '00000007-0000-4000-8000-000000000001', 2024, 'CSE-A', 60),
  ('00000008-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000001', '00000007-0000-4000-8000-000000000001', 2024, 'CSE-B', 60),
  ('00000008-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000001', '00000007-0000-4000-8000-000000000002', 2024, 'ECE-A', 60),
  ('00000008-0000-4000-8000-000000000004', '00000001-0000-4000-8000-000000000001', '00000007-0000-4000-8000-000000000003', 2024, 'MECH-A', 60),
  ('00000008-0000-4000-8000-000000000005', '00000001-0000-4000-8000-000000000001', '00000007-0000-4000-8000-000000000001', 2023, 'CSE-A', 60),
  ('00000008-0000-4000-8000-000000000006', '00000001-0000-4000-8000-000000000002', '00000007-0000-4000-8000-000000000004', 2024, 'B-CSE-A', 60);

-- --- Courses (catalog master data) ---
-- instructor_id is deliberately NULL on every QA course. If any code path
-- still resolved authority through the catalog it would find nobody here,
-- so the offering tests fail loudly rather than pass on a stale value.
INSERT INTO public.courses (id, college_id, department_id, name, code, credits, semester, type) VALUES
  ('00000009-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000001', 'QA Data Structures', 'QA-CS201', 4, 3, 'core'),
  ('00000009-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000001', 'QA Database Management Systems', 'QA-CS301', 4, 3, 'core'),
  ('00000009-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000001', 'QA Operating Systems', 'QA-CS302', 4, 3, 'core'),
  ('00000009-0000-4000-8000-000000000004', '00000001-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000002', 'QA Computer Networks', 'QA-EC401', 3, 5, 'core'),
  ('00000009-0000-4000-8000-000000000005', '00000001-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000003', 'QA Engineering Mathematics', 'QA-MA101', 4, 1, 'core'),
  ('00000009-0000-4000-8000-000000000006', '00000001-0000-4000-8000-000000000002', '00000002-0000-4000-8000-000000000004', 'QA-B Data Structures', 'QA-B-CS201', 4, 3, 'core');

-- --- Course offerings: the deliberately overlapping structure ---
INSERT INTO public.course_offerings (id, college_id, semester_id, course_id, section_id, instructor_id, status, max_students) VALUES
  -- Data Structures delivered three times by three teachers.
  ('0000000a-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', '00000006-0000-4000-8000-000000000003', '00000009-0000-4000-8000-000000000001', '00000008-0000-4000-8000-000000000001', '00000003-0000-4000-8000-000000000003', 'active', 60),
  ('0000000a-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000001', '00000006-0000-4000-8000-000000000003', '00000009-0000-4000-8000-000000000001', '00000008-0000-4000-8000-000000000002', '00000003-0000-4000-8000-000000000004', 'active', 60),
  ('0000000a-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000001', '00000006-0000-4000-8000-000000000005', '00000009-0000-4000-8000-000000000001', '00000008-0000-4000-8000-000000000005', '00000003-0000-4000-8000-000000000005', 'active', 60),
  -- DBMS delivered twice.
  ('0000000a-0000-4000-8000-000000000004', '00000001-0000-4000-8000-000000000001', '00000006-0000-4000-8000-000000000003', '00000009-0000-4000-8000-000000000002', '00000008-0000-4000-8000-000000000001', '00000003-0000-4000-8000-000000000003', 'active', 60),
  ('0000000a-0000-4000-8000-000000000005', '00000001-0000-4000-8000-000000000001', '00000006-0000-4000-8000-000000000003', '00000009-0000-4000-8000-000000000002', '00000008-0000-4000-8000-000000000002', '00000003-0000-4000-8000-000000000004', 'active', 60),
  -- The teaching HOD's own offering.
  ('0000000a-0000-4000-8000-000000000006', '00000001-0000-4000-8000-000000000001', '00000006-0000-4000-8000-000000000003', '00000009-0000-4000-8000-000000000003', '00000008-0000-4000-8000-000000000001', '00000003-0000-4000-8000-000000000001', 'active', 60),
  -- An ECE-department offering, for HOD review-scope boundaries.
  ('0000000a-0000-4000-8000-000000000007', '00000001-0000-4000-8000-000000000001', '00000006-0000-4000-8000-000000000005', '00000009-0000-4000-8000-000000000004', '00000008-0000-4000-8000-000000000003', '00000003-0000-4000-8000-000000000005', 'active', 60),
  -- Historical: same course, same section name, previous academic year.
  ('0000000a-0000-4000-8000-000000000008', '00000001-0000-4000-8000-000000000001', '00000006-0000-4000-8000-000000000009', '00000009-0000-4000-8000-000000000001', '00000008-0000-4000-8000-000000000005', '00000003-0000-4000-8000-000000000003', 'completed', 60),
  -- Cancelled, with Teacher A STILL named as instructor: cancellation must
  -- be what stops the write, not the absence of an assignment.
  ('0000000a-0000-4000-8000-000000000009', '00000001-0000-4000-8000-000000000001', '00000006-0000-4000-8000-000000000003', '00000009-0000-4000-8000-000000000005', '00000008-0000-4000-8000-000000000004', '00000003-0000-4000-8000-000000000003', 'cancelled', 60),
  -- A SERVICE COURSE: owned by Mechanical, delivered to a CSE section. The
  -- teaching department (MECH, via courses.department_id) and the receiving
  -- department (CSE, via section -> programme) disagree, which is the only
  -- way to test which one the authority predicate actually uses.
  ('0000000a-0000-4000-8000-00000000000b', '00000001-0000-4000-8000-000000000001', '00000006-0000-4000-8000-000000000005', '00000009-0000-4000-8000-000000000005', '00000008-0000-4000-8000-000000000001', '00000003-0000-4000-8000-000000000005', 'active', 60),
  -- College B.
  ('0000000a-0000-4000-8000-00000000000a', '00000001-0000-4000-8000-000000000002', '00000006-0000-4000-8000-00000000000b', '00000009-0000-4000-8000-000000000006', '00000008-0000-4000-8000-000000000006', '00000003-0000-4000-8000-000000000011', 'active', 60);

-- --- Enrollments ---
-- Student C is on the CSE-B delivery ONLY. Student E is Sem 5 only.
-- Student F is historical only.
INSERT INTO public.course_enrollments (id, college_id, student_id, offering_id, status) VALUES
  ('0000000e-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', '00000004-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001', 'enrolled'),
  ('0000000e-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000001', '00000004-0000-4000-8000-000000000002', '0000000a-0000-4000-8000-000000000001', 'enrolled'),
  ('0000000e-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000001', '00000004-0000-4000-8000-000000000003', '0000000a-0000-4000-8000-000000000002', 'enrolled'),
  ('0000000e-0000-4000-8000-000000000004', '00000001-0000-4000-8000-000000000001', '00000004-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000004', 'enrolled'),
  ('0000000e-0000-4000-8000-000000000005', '00000001-0000-4000-8000-000000000001', '00000004-0000-4000-8000-000000000002', '0000000a-0000-4000-8000-000000000004', 'enrolled'),
  ('0000000e-0000-4000-8000-000000000006', '00000001-0000-4000-8000-000000000001', '00000004-0000-4000-8000-000000000004', '0000000a-0000-4000-8000-000000000004', 'enrolled'),
  ('0000000e-0000-4000-8000-000000000007', '00000001-0000-4000-8000-000000000001', '00000004-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000006', 'enrolled'),
  ('0000000e-0000-4000-8000-000000000008', '00000001-0000-4000-8000-000000000001', '00000004-0000-4000-8000-000000000005', '0000000a-0000-4000-8000-000000000003', 'enrolled'),
  ('0000000e-0000-4000-8000-000000000009', '00000001-0000-4000-8000-000000000001', '00000004-0000-4000-8000-000000000006', '0000000a-0000-4000-8000-000000000008', 'completed'),
  ('0000000e-0000-4000-8000-00000000000a', '00000001-0000-4000-8000-000000000002', '00000004-0000-4000-8000-000000000007', '0000000a-0000-4000-8000-00000000000a', 'enrolled');

-- --- Timetable ---
INSERT INTO public.timetable_slots (id, college_id, offering_id, day_of_week, start_time, end_time, room) VALUES
  ('0000000d-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001', 1, '09:00', '10:00', 'QA-R101'),
  ('0000000d-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000002', 1, '10:00', '11:00', 'QA-R102'),
  ('0000000d-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000004', 2, '09:00', '10:00', 'QA-R101'),
  ('0000000d-0000-4000-8000-000000000004', '00000001-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000006', 3, '09:00', '10:00', 'QA-R103');

-- --- Historical academic records ---
-- Only on the 2025-26 offering. A query resolving "Data Structures, CSE-A"
-- through the course instead of the offering would find these rows attached
-- to the CURRENT class.
INSERT INTO public.attendance (id, college_id, offering_id, student_id, date, status, marked_by) VALUES
  ('0000000b-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000008', '00000004-0000-4000-8000-000000000006', '2025-08-11', 'present', '00000003-0000-4000-8000-000000000003'),
  ('0000000b-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000008', '00000004-0000-4000-8000-000000000006', '2025-08-12', 'absent', '00000003-0000-4000-8000-000000000003');

INSERT INTO public.marks (id, college_id, offering_id, student_id, exam_type, max_marks, obtained_marks, entered_by) VALUES
  ('0000000c-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000008', '00000004-0000-4000-8000-000000000006', 'internal_1', 100, 72, '00000003-0000-4000-8000-000000000003');

-- --- A leave request, so substitution_assignments has a valid parent ---
INSERT INTO public.leave_requests (id, college_id, requested_by, leave_type, start_date, end_date, reason, status, approved_by, approved_at) VALUES
  ('0000000f-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', '00000003-0000-4000-8000-000000000003', 'sick', '2026-09-14', '2026-09-14', 'QA fixture: single-day sick leave', 'approved', '00000003-0000-4000-8000-000000000001', now());

-- ============================================================
-- Hostel and finance fixtures (Phase 10).
--
-- Two wardens, two blocks, and students allocated across them — the shape
-- needed to ask whether block ownership is a real boundary or a comment.
-- ============================================================
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000003-0000-4000-8000-000000000015', 'qa.warden.b@qa.test', jsonb_build_object('full_name','QA Warden B','college_id','00000001-0000-4000-8000-000000000001'));
UPDATE public.profiles SET role = 'warden', status = 'active' WHERE id = '00000003-0000-4000-8000-000000000015';

INSERT INTO public.hostel_blocks (id, college_id, name, type, warden_id, total_rooms) VALUES
  ('00000010-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', 'QA Block A', 'boys', '00000003-0000-4000-8000-00000000000e', 2),
  ('00000010-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000001', 'QA Block B', 'boys', '00000003-0000-4000-8000-000000000015', 2),
  ('00000010-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000002', 'QA-B Block', 'boys', NULL, 1);

INSERT INTO public.hostel_rooms (id, college_id, block_id, block_name, room_number, capacity, occupancy, monthly_rent) VALUES
  ('00000011-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', '00000010-0000-4000-8000-000000000001', 'QA Block A', 'A-101', 2, 1, 5000),
  ('00000011-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000001', '00000010-0000-4000-8000-000000000001', 'QA Block A', 'A-102', 2, 0, 5000),
  ('00000011-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000001', '00000010-0000-4000-8000-000000000002', 'QA Block B', 'B-201', 2, 1, 5000),
  ('00000011-0000-4000-8000-000000000004', '00000001-0000-4000-8000-000000000001', '00000010-0000-4000-8000-000000000002', 'QA Block B', 'B-202', 1, 0, 6000),
  ('00000011-0000-4000-8000-000000000005', '00000001-0000-4000-8000-000000000002', '00000010-0000-4000-8000-000000000003', 'QA-B Block', 'X-1', 2, 1, 4000);

-- Student A lives in Block A (Warden A); Student C lives in Block B (Warden B).
INSERT INTO public.hostel_allocations (id, college_id, student_id, room_id, status) VALUES
  ('00000012-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', '00000004-0000-4000-8000-000000000001', '00000011-0000-4000-8000-000000000001', 'active'),
  ('00000012-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000001', '00000004-0000-4000-8000-000000000003', '00000011-0000-4000-8000-000000000003', 'active'),
  ('00000012-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000002', '00000004-0000-4000-8000-000000000007', '00000011-0000-4000-8000-000000000005', 'active');

-- Pending gate passes, one per block.
INSERT INTO public.gate_passes (id, college_id, student_id, destination, reason, exit_time, return_time, status) VALUES
  ('00000013-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', '00000004-0000-4000-8000-000000000001', 'Home', 'QA', '2026-09-13 08:00+00', '2026-09-13 20:00+00', 'pending'),
  ('00000013-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000001', '00000004-0000-4000-8000-000000000003', 'Market', 'QA', '2026-09-13 09:00+00', '2026-09-13 18:00+00', 'pending');

-- Fees: Student A owes 10,000 with nothing paid; Student C owes 8,000.
INSERT INTO public.fees (id, college_id, student_id, type, amount, due_date, status, paid_amount, semester, academic_year) VALUES
  ('00000014-0000-4000-8000-000000000001', '00000001-0000-4000-8000-000000000001', '00000004-0000-4000-8000-000000000001', 'tuition', 10000, '2026-10-01', 'pending', 0, 3, 'QA 2026-27'),
  ('00000014-0000-4000-8000-000000000002', '00000001-0000-4000-8000-000000000001', '00000004-0000-4000-8000-000000000003', 'tuition', 8000,  '2026-10-01', 'pending', 0, 3, 'QA 2026-27'),
  ('00000014-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000002', '00000004-0000-4000-8000-000000000007', 'tuition', 9000,  '2026-10-01', 'pending', 0, 3, 'QA-B 2026-27');
