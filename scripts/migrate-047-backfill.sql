-- ============================================================
-- LEGACY BACKFILL for migration 047 — run ONCE, AFTER 046 and BEFORE 047,
-- on any database that already holds pre-046 academic rows (attendance,
-- marks, course_enrollments, timetable_slots carrying course_id/semester).
--
-- Phase 2 proved 047's `ADD COLUMN offering_id UUID NOT NULL` aborts on a
-- populated table (no default, no backfill) and half-applies. This script
-- creates the offering rows those legacy records imply, adds offering_id
-- NULLABLE, backfills it, validates 100% coverage, then sets NOT NULL — so
-- when 047 runs, its `ADD COLUMN IF NOT EXISTS offering_id … NOT NULL` finds
-- the column already present and populated and skips the add. The rest of 047
-- (dropping course_id, rebuilding the offering-keyed uniques) then applies
-- cleanly.
--
-- Properties: deterministic, idempotent (safe to re-run), auditable (raises
-- with a count if any row cannot be mapped), and a no-op on an empty database.
-- It NEVER deletes or rewrites a legacy academic value.
-- ============================================================
DO $backfill$
DECLARE
  v_unmapped INTEGER;
BEGIN
  -- Nothing to do if the offering model is already in place (047 applied) or
  -- there is no legacy data.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='attendance' AND column_name='course_id'
  ) THEN
    RAISE NOTICE 'backfill: attendance.course_id absent — 047 already applied or fresh schema; nothing to do.';
    RETURN;
  END IF;

  -- 0. course_enrollments.student_id referenced profiles(id) (a USER id) in the
  --    pre-047 schema; 047 re-points the FK to students(id) without translating
  --    the values, so a populated table would also fail 047's FK re-add. Drop
  --    the old FK and translate user_id -> students.id here, before 047. Any
  --    enrollment whose user has no student row is left untranslated and will
  --    be caught by 047's FK (the "resolve failures" path).
  ALTER TABLE public.course_enrollments DROP CONSTRAINT IF EXISTS course_enrollments_student_id_fkey;
  UPDATE public.course_enrollments ce SET student_id = st.id
  FROM public.students st WHERE st.user_id = ce.student_id;

  -- 1. One programme + section per (department, batch_year) present in students,
  --    so every legacy course+cohort has a section to hang an offering on.
  INSERT INTO public.programmes (college_id, department_id, name, code, degree_type, duration_semesters)
  SELECT DISTINCT s.college_id, s.department_id,
         'Legacy Programme ' || d.code, 'LEG-' || d.code, 'undergraduate', 8
  FROM public.students s JOIN public.departments d ON d.id = s.department_id
  ON CONFLICT (college_id, code) DO NOTHING;

  INSERT INTO public.sections (college_id, programme_id, batch_year, name, capacity)
  SELECT DISTINCT s.college_id, p.id, s.batch_year, 'LEG', 999
  FROM public.students s
  JOIN public.programmes p ON p.department_id = s.department_id AND p.code = 'LEG-' ||
        (SELECT code FROM public.departments d WHERE d.id = s.department_id)
  ON CONFLICT (programme_id, batch_year, name) DO NOTHING;

  -- 2. One offering per (semester, course, section) actually referenced by a
  --    legacy academic row, carrying the catalog instructor_id if present.
  INSERT INTO public.course_offerings (college_id, semester_id, course_id, section_id, instructor_id, status)
  SELECT DISTINCT c.college_id, sem.id, c.id, sec.id, c.instructor_id, 'completed'
  FROM (
    SELECT college_id, course_id, student_id FROM public.attendance
    UNION SELECT college_id, course_id, student_id FROM public.marks
    UNION SELECT college_id, course_id, student_id FROM public.course_enrollments
  ) legacy
  JOIN public.courses c   ON c.id = legacy.course_id
  JOIN public.students st ON st.id = legacy.student_id
  JOIN public.programmes p ON p.department_id = st.department_id AND p.code = 'LEG-' ||
        (SELECT code FROM public.departments d WHERE d.id = st.department_id)
  JOIN public.sections sec ON sec.programme_id = p.id AND sec.batch_year = st.batch_year AND sec.name = 'LEG'
  JOIN public.semesters sem ON sem.college_id = c.college_id
        AND sem.sequence_no = c.semester
  ON CONFLICT (semester_id, course_id, section_id) DO NOTHING;

  -- 3. offering_id NULLABLE on each academic table, then backfill by mapping
  --    each row's (course_id, its student's section+batch, course.semester).
  ALTER TABLE public.attendance         ADD COLUMN IF NOT EXISTS offering_id UUID;
  ALTER TABLE public.marks              ADD COLUMN IF NOT EXISTS offering_id UUID;
  ALTER TABLE public.course_enrollments ADD COLUMN IF NOT EXISTS offering_id UUID;
  ALTER TABLE public.timetable_slots    ADD COLUMN IF NOT EXISTS offering_id UUID;

  UPDATE public.attendance a SET offering_id = o.id
  FROM public.students st, public.courses c, public.sections sec, public.programmes p, public.semesters sem, public.course_offerings o
  WHERE a.offering_id IS NULL AND st.id = a.student_id AND c.id = a.course_id
    AND p.department_id = st.department_id AND p.code = 'LEG-' || (SELECT code FROM public.departments d WHERE d.id = st.department_id)
    AND sec.programme_id = p.id AND sec.batch_year = st.batch_year AND sec.name = 'LEG'
    AND sem.college_id = c.college_id AND sem.sequence_no = c.semester
    AND o.semester_id = sem.id AND o.course_id = c.id AND o.section_id = sec.id;

  UPDATE public.marks m SET offering_id = o.id
  FROM public.students st, public.courses c, public.sections sec, public.programmes p, public.semesters sem, public.course_offerings o
  WHERE m.offering_id IS NULL AND st.id = m.student_id AND c.id = m.course_id
    AND p.department_id = st.department_id AND p.code = 'LEG-' || (SELECT code FROM public.departments d WHERE d.id = st.department_id)
    AND sec.programme_id = p.id AND sec.batch_year = st.batch_year AND sec.name = 'LEG'
    AND sem.college_id = c.college_id AND sem.sequence_no = c.semester
    AND o.semester_id = sem.id AND o.course_id = c.id AND o.section_id = sec.id;

  UPDATE public.course_enrollments ce SET offering_id = o.id
  FROM public.students st, public.courses c, public.sections sec, public.programmes p, public.semesters sem, public.course_offerings o
  WHERE ce.offering_id IS NULL AND st.id = ce.student_id AND c.id = ce.course_id
    AND p.department_id = st.department_id AND p.code = 'LEG-' || (SELECT code FROM public.departments d WHERE d.id = st.department_id)
    AND sec.programme_id = p.id AND sec.batch_year = st.batch_year AND sec.name = 'LEG'
    AND sem.college_id = c.college_id AND sem.sequence_no = c.semester
    AND o.semester_id = sem.id AND o.course_id = c.id AND o.section_id = sec.id;

  -- timetable_slots carried course_id + a semester reference in the legacy
  -- schema; map through the same course+semester (section via any offering of
  -- that course+semester — one exists by construction).
  UPDATE public.timetable_slots ts SET offering_id = o.id
  FROM public.courses c, public.semesters sem, public.course_offerings o
  WHERE ts.offering_id IS NULL AND c.id = ts.course_id
    AND sem.college_id = c.college_id AND sem.sequence_no = c.semester
    AND o.semester_id = sem.id AND o.course_id = c.id
    AND o.id = (SELECT id FROM public.course_offerings o2 WHERE o2.semester_id = sem.id AND o2.course_id = c.id ORDER BY id LIMIT 1);

  -- 4. Validate 100% coverage BEFORE locking anything down. Any unmapped row
  --    aborts the whole backfill with a count — nothing is set NOT NULL on a
  --    partially-mapped table.
  SELECT
    (SELECT count(*) FROM public.attendance WHERE offering_id IS NULL)
  + (SELECT count(*) FROM public.marks WHERE offering_id IS NULL)
  + (SELECT count(*) FROM public.course_enrollments WHERE offering_id IS NULL)
  + (SELECT count(*) FROM public.timetable_slots WHERE offering_id IS NULL)
  INTO v_unmapped;

  IF v_unmapped > 0 THEN
    RAISE EXCEPTION 'backfill: % academic row(s) could not be mapped to an offering; resolve before 047', v_unmapped;
  END IF;

  -- 5. Now safe: set NOT NULL so 047's `ADD COLUMN IF NOT EXISTS … NOT NULL`
  --    finds a populated NOT NULL column and skips the add that would abort.
  ALTER TABLE public.attendance         ALTER COLUMN offering_id SET NOT NULL;
  ALTER TABLE public.marks              ALTER COLUMN offering_id SET NOT NULL;
  ALTER TABLE public.course_enrollments ALTER COLUMN offering_id SET NOT NULL;
  ALTER TABLE public.timetable_slots    ALTER COLUMN offering_id SET NOT NULL;

  RAISE NOTICE 'backfill: complete — every academic row mapped to an offering; 047 is now safe to apply.';
END $backfill$;
