-- ============================================================
-- Migration 046: Phase 1 foundation — academic period, programme, section,
--                course offering
--
-- WHY NOW (the stop condition):
-- attendance, marks, course_enrollments and timetable_slots are ALL EMPTY in
-- the live database (verified by direct count, not assumed). Every academic
-- transaction table is at zero rows. This is the last moment the foundation
-- can be corrected without a data migration, and the reason this migration
-- comes before any further academic feature work.
--
-- WHAT IS WRONG TODAY
--
-- 1. No academic period. `semesters` exists with is_current/start_date/
--    end_date, and NO application code reads it. (Seed data does set
--    is_current on Fall 2026 — the value exists, nothing maintains or
--    consults it.) students.semester is a bare INTEGER written once at
--    creation and never advanced. So attendance and marks accumulate in one
--    undifferentiated pile with nothing to filter "this semester" on.
--
-- 2. No programme. Fees, credit requirements and duration are properties of
--    a programme (B.Tech CSE vs M.Tech CSE), but the schema stops at
--    department. students.credits_required defaults to 160 PER STUDENT ROW —
--    programme policy stored one student at a time.
--
-- 3. No section, and no course offering. courses.instructor_id puts the
--    teacher on the CATALOG entry, so "Data Structures" can have exactly one
--    teacher across the whole institution, forever. Two sections of one
--    course with different teachers cannot be expressed at all, and
--    attendance's UNIQUE(student_id, course_id, date) actively prevents it.
--
-- THE MODEL THIS ESTABLISHES
--
--   academic_years
--     └── semesters            (sequenced, exactly one active per college)
--
--   departments
--     └── programmes           (B.Tech CSE, M.Tech CSE — differing duration/credits)
--          └── sections        (per programme + batch year: "2026 A", "2026 B")
--
--   courses (catalog: what the institution teaches)
--     └── course_offerings     (semester + course + section + instructor:
--                               what is actually being taught, to whom, by whom)
--
-- course_offerings is the join that everything academic should hang off.
-- Migration 047 repoints attendance, marks, course_enrollments and
-- timetable_slots onto it and retires the course-level identity; that one is
-- breaking and ships together with its application changes. THIS migration is
-- purely additive and safe to apply on its own — nothing reads these tables
-- yet, so it cannot regress any existing screen.
--
-- DELIBERATELY NOT DONE HERE
-- No programmes or sections are invented. Which programmes a college runs is
-- institutional master data, not something a migration should fabricate — the
-- existing 12 departments and 17 courses are left untouched and unlinked
-- until someone enters the real programme structure. academic_years IS
-- backfilled, because that is derived from real values already in
-- semesters.academic_year rather than made up.
--
-- Sign-off: REQUIRED. Additive, but it is the schema foundation everything
-- else in Phases 1-3 builds on — per .agent/.rules §4 and §13.
-- ============================================================

-- ---------------------------------------------------------------
-- 1. Academic years
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.academic_years (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                       -- '2026-27'
  start_date DATE,
  end_date DATE,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'active', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (college_id, name)
);

CREATE INDEX IF NOT EXISTS idx_academic_years_college ON public.academic_years(college_id);
CREATE TRIGGER set_updated_at_academic_years BEFORE UPDATE ON public.academic_years
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- At most one active academic year per college. A partial unique index rather
-- than a trigger: the database enforces it even against a SQL console.
CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_years_one_active
  ON public.academic_years(college_id) WHERE status = 'active';

-- Backfill from the real values already present in semesters.academic_year.
INSERT INTO public.academic_years (college_id, name, start_date, end_date, status)
SELECT s.college_id,
       s.academic_year,
       MIN(s.start_date),
       MAX(s.end_date),
       -- Active iff it contains the semester currently flagged is_current.
       CASE WHEN bool_or(COALESCE(s.is_current, false)) THEN 'active' ELSE 'planned' END
FROM public.semesters s
WHERE s.academic_year IS NOT NULL
GROUP BY s.college_id, s.academic_year
ON CONFLICT (college_id, name) DO NOTHING;

-- ---------------------------------------------------------------
-- 2. Semesters — upgraded in place (the table already exists and is read by
--    nothing, so this is safe; its 2 rows are preserved and linked).
-- ---------------------------------------------------------------
ALTER TABLE public.semesters
  ADD COLUMN IF NOT EXISTS academic_year_id UUID REFERENCES public.academic_years(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS sequence_no INTEGER,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'active', 'closed')),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE public.semesters s
SET academic_year_id = ay.id
FROM public.academic_years ay
WHERE ay.college_id = s.college_id
  AND ay.name = s.academic_year
  AND s.academic_year_id IS NULL;

-- Carry the existing is_current flag into the new status vocabulary, and
-- order semesters within their year by start_date.
UPDATE public.semesters SET status = 'active' WHERE COALESCE(is_current, false) AND status = 'planned';

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY college_id, academic_year_id ORDER BY start_date) AS rn
  FROM public.semesters
)
UPDATE public.semesters s SET sequence_no = o.rn FROM ordered o
WHERE o.id = s.id AND s.sequence_no IS NULL;

-- Exactly one active semester per college — the invariant `is_current` never
-- had, which is why nothing could safely rely on it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_semesters_one_active
  ON public.semesters(college_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_semesters_academic_year ON public.semesters(academic_year_id);

-- ---------------------------------------------------------------
-- 3. Programmes
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.programmes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,                        -- 'B.Tech Computer Science'
  code TEXT NOT NULL,                        -- 'BTECH-CSE'
  degree_type TEXT NOT NULL DEFAULT 'undergraduate'
    CHECK (degree_type IN ('undergraduate', 'postgraduate', 'diploma', 'doctoral', 'certificate')),
  duration_semesters INTEGER NOT NULL DEFAULT 8,
  total_credits INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (college_id, code)
);

CREATE INDEX IF NOT EXISTS idx_programmes_college ON public.programmes(college_id);
CREATE INDEX IF NOT EXISTS idx_programmes_department ON public.programmes(department_id);
CREATE TRIGGER set_updated_at_programmes BEFORE UPDATE ON public.programmes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ---------------------------------------------------------------
-- 4. Sections — a cohort within a programme's intake year.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  programme_id UUID NOT NULL REFERENCES public.programmes(id) ON DELETE RESTRICT,
  batch_year INTEGER NOT NULL,               -- admission year, e.g. 2026
  name TEXT NOT NULL,                        -- 'A', 'B'
  capacity INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (programme_id, batch_year, name)
);

CREATE INDEX IF NOT EXISTS idx_sections_college ON public.sections(college_id);
CREATE INDEX IF NOT EXISTS idx_sections_programme ON public.sections(programme_id);

-- ---------------------------------------------------------------
-- 5. Course offerings — the heart of this migration.
--
-- A `course` is the catalog entry ("Data Structures, 4 credits"). An
-- OFFERING is that course actually being taught: in one semester, to one
-- section, by one instructor. Two sections of Data Structures in the same
-- semester with different teachers are two offerings of one course, which
-- the current schema cannot express at all.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.course_offerings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  semester_id UUID NOT NULL REFERENCES public.semesters(id) ON DELETE RESTRICT,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE RESTRICT,
  section_id UUID NOT NULL REFERENCES public.sections(id) ON DELETE RESTRICT,
  -- Where the teacher belongs: on the offering, not the catalog entry.
  -- courses.instructor_id stays for now so nothing breaks; migration 047
  -- retires it once the app reads offerings instead.
  instructor_id UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  max_students INTEGER,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One offering per (semester, course, section). This is the identity that
  -- replaces attendance's UNIQUE(student_id, course_id, date) in 047.
  UNIQUE (semester_id, course_id, section_id)
);

CREATE INDEX IF NOT EXISTS idx_course_offerings_college ON public.course_offerings(college_id);
CREATE INDEX IF NOT EXISTS idx_course_offerings_semester ON public.course_offerings(semester_id);
CREATE INDEX IF NOT EXISTS idx_course_offerings_instructor ON public.course_offerings(instructor_id);
CREATE INDEX IF NOT EXISTS idx_course_offerings_section ON public.course_offerings(section_id);
CREATE TRIGGER set_updated_at_course_offerings BEFORE UPDATE ON public.course_offerings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ---------------------------------------------------------------
-- 6. RLS — default-deny, then the narrowest policies that serve the
--    screens these will feed. Academic structure is readable college-wide
--    (a student must see which section and semester they are in); writes
--    are admin/director, except offerings which HOD owns for their own
--    department's courses.
-- ---------------------------------------------------------------
ALTER TABLE public.academic_years   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.programmes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sections         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_offerings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "academic_years_read" ON public.academic_years
  FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "academic_years_manage" ON public.academic_years
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director')
  );

CREATE POLICY "programmes_read" ON public.programmes
  FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "programmes_manage" ON public.programmes
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director')
  );

CREATE POLICY "sections_read" ON public.sections
  FOR SELECT USING (college_id = public.get_my_college_id());
CREATE POLICY "sections_manage" ON public.sections
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director', 'hod')
  );

CREATE POLICY "course_offerings_read" ON public.course_offerings
  FOR SELECT USING (college_id = public.get_my_college_id());

-- Department ownership for hod is enforced app-side via the course's
-- department_id, the same split used by attendance_correction_requests (037),
-- substitution_assignments (039) and room_transfer_requests (040). RLS here
-- is the role + tenancy backstop.
CREATE POLICY "course_offerings_manage" ON public.course_offerings
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director', 'hod')
  );

-- ============================================================
-- Post-apply verification
-- ============================================================
--   -- academic years backfilled from real semester data (expect 1 row: 2026-27)
--   SELECT name, status, start_date, end_date FROM public.academic_years;
--
--   -- both semesters linked, sequenced, and exactly one active
--   SELECT name, sequence_no, status, academic_year_id FROM public.semesters ORDER BY sequence_no;
--
--   -- the one-active invariants actually bite:
--   UPDATE public.semesters SET status='active';        -- must fail, 23505
--   UPDATE public.academic_years SET status='active';   -- must fail if >1 year
--
--   -- programmes/sections/offerings exist and are empty, awaiting real
--   -- institutional master data:
--   SELECT count(*) FROM public.programmes;    -- 0
--   SELECT count(*) FROM public.sections;      -- 0
--   SELECT count(*) FROM public.course_offerings; -- 0
--
-- ============================================================
-- Rollback (apply manually if reverting this migration)
-- ============================================================
-- DROP TABLE IF EXISTS public.course_offerings;
-- DROP TABLE IF EXISTS public.sections;
-- DROP TABLE IF EXISTS public.programmes;
-- DROP INDEX IF EXISTS public.idx_semesters_one_active;
-- ALTER TABLE public.semesters
--   DROP COLUMN IF EXISTS academic_year_id,
--   DROP COLUMN IF EXISTS sequence_no,
--   DROP COLUMN IF EXISTS status,
--   DROP COLUMN IF EXISTS updated_at;
-- DROP TABLE IF EXISTS public.academic_years;
