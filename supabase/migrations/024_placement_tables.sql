-- ============================================================
-- Migration 024: Placement Cell tables
-- ============================================================
-- New entities needed for the Placement Cell module. Deliberately NOT the
-- full seven-table list floated during planning: outcomes reuse the
-- existing `placements` table (fed by public.mv_placement_summary already)
-- instead of a new `placement_offers` table, and delivery reuses the
-- existing `notifications` table instead of a new `placement_notifications`
-- table (see migration 025 for the RLS change that lets placement_cell
-- write to it). Eligibility criteria live directly on `placement_drives`
-- and are evaluated on read, not persisted per student.
--
-- Every table gets its college_id index here, in the same migration that
-- creates it — migration 021 existed only because earlier tables didn't,
-- and had to be patched later.

CREATE TABLE IF NOT EXISTS public.companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  industry TEXT,
  website TEXT,
  location TEXT,
  hr_contact_name TEXT,
  hr_email TEXT,
  hr_phone TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (college_id, name)
);

CREATE INDEX IF NOT EXISTS idx_companies_college ON public.companies(college_id);
CREATE TRIGGER set_updated_at_companies BEFORE UPDATE ON public.companies FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Belongs to the college's placement ecosystem, not to the Placement Cell
-- user who happened to create it — company_id/college_id are the only
-- ownership this table encodes (see companies table above).
CREATE TABLE IF NOT EXISTS public.placement_drives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  job_role TEXT NOT NULL,
  job_description TEXT,
  package_lpa NUMERIC(10, 2),
  min_cgpa NUMERIC(4, 2),
  -- Informational eligibility text only — there is no backlog/exam data
  -- model anywhere in this schema to compute this against automatically.
  -- Placement Cell curates actual applicant eligibility manually.
  max_backlogs INTEGER,
  eligible_batch_years INTEGER[],
  application_deadline TIMESTAMPTZ NOT NULL,
  drive_date DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed', 'cancelled')),
  created_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_placement_drives_college ON public.placement_drives(college_id);
CREATE INDEX IF NOT EXISTS idx_placement_drives_company ON public.placement_drives(company_id);
CREATE TRIGGER set_updated_at_placement_drives BEFORE UPDATE ON public.placement_drives FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Many-to-many eligible-departments relationship for a drive.
CREATE TABLE IF NOT EXISTS public.placement_drive_departments (
  drive_id UUID NOT NULL REFERENCES public.placement_drives(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  PRIMARY KEY (drive_id, department_id)
);

CREATE INDEX IF NOT EXISTS idx_placement_drive_departments_department ON public.placement_drive_departments(department_id);

CREATE TABLE IF NOT EXISTS public.placement_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  drive_id UUID NOT NULL REFERENCES public.placement_drives(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'applied'
    CHECK (status IN ('applied', 'shortlisted', 'interview', 'selected', 'rejected', 'offer_declined')),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (drive_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_placement_applications_college ON public.placement_applications(college_id);
CREATE INDEX IF NOT EXISTS idx_placement_applications_drive ON public.placement_applications(drive_id);
CREATE INDEX IF NOT EXISTS idx_placement_applications_student ON public.placement_applications(student_id);
CREATE TRIGGER set_updated_at_placement_applications BEFORE UPDATE ON public.placement_applications FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- One row per student with any placement activity — the "Student Placement
-- Records" master status. Deliberately a separate table from `students`
-- (not new columns on it) so Placement Cell's write access never touches
-- the same row as CGPA/credits/admission data that HOD/Admin own. No
-- student-writable columns in V1 — students get read-only access (see
-- migration 025); this keeps that RLS policy simple.
CREATE TABLE IF NOT EXISTS public.student_placement_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  student_id UUID NOT NULL UNIQUE REFERENCES public.students(id) ON DELETE CASCADE,
  placement_status TEXT NOT NULL DEFAULT 'not_placed'
    CHECK (placement_status IN ('not_placed', 'eligible', 'applied', 'shortlisted', 'selected', 'placed', 'rejected', 'opted_out')),
  notes TEXT,
  updated_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_student_placement_profiles_college ON public.student_placement_profiles(college_id);
CREATE TRIGGER set_updated_at_student_placement_profiles BEFORE UPDATE ON public.student_placement_profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
