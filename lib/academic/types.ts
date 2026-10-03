/**
 * Shapes returned by migration 055's functions and the HOD / Class In-Charge
 * workspaces. Kept apart from the server actions so client components and
 * the dev gallery can import them without pulling in server code.
 */

export type ReadinessSeverity = "blocking" | "pending";

export interface ReadinessItem {
  code: string;
  severity: ReadinessSeverity;
  message: string;
  ref_id?: string;
}

export type DepartmentTermStatus = "not_started" | "active" | "ended" | "no_active_term";

export interface DepartmentReadiness {
  semester_id: string | null;
  semester_name: string | null;
  status: DepartmentTermStatus;
  started_at?: string | null;
  ended_at?: string | null;
  ready: boolean;
  blocking_count: number;
  pending_count: number;
  items: ReadinessItem[];
}

export interface DepartmentOption {
  id: string;
  name: string;
  code: string;
}

export interface StaffOption {
  id: string;
  full_name: string;
  external?: boolean;
}

export interface SectionWithIncharge {
  id: string;
  name: string;
  batch_year: number;
  status: string;
  programme_code: string;
  programme_name: string;
  student_count: number;
  incharge: { id: string; full_name: string } | null;
}

export interface ProgrammeRow {
  id: string;
  name: string;
  code: string;
  degree_type: string;
  duration_semesters: number;
  total_credits: number | null;
  status: string;
}

export interface SectionRow {
  id: string;
  programme_id: string;
  name: string;
  batch_year: number;
  capacity: number | null;
  status: string;
}

export interface OfferingRow {
  id: string;
  status: string;
  semester: { id: string; name: string; status: string };
  course: { id: string; code: string; name: string; type: string };
  section: { id: string; label: string };
  instructor: { id: string; full_name: string } | null;
}

export interface TermOption {
  id: string;
  name: string;
  status: string;
}

export interface CourseOption {
  id: string;
  code: string;
  name: string;
  type: string;
}

export interface SectionOption {
  id: string;
  label: string;
}

export interface ExternalAuthorization {
  id: string;
  teacher_id: string;
  full_name: string;
  home_department: string | null;
  reason: string;
  granted_at: string;
}

export interface TimetableSlotRow {
  id: string;
  offering_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  room: string | null;
  label: string;
  teacher: string | null;
}

export interface UnplacedStudent {
  student_id: string;
  full_name: string | null;
  enrollment_number: string;
  batch_year: number;
  semester: number;
  status: string;
}

/** my_academic_context() — the one academic read web and mobile share. */
export interface AcademicContext {
  role: string;
  term: { id: string; name: string; start_date: string; end_date: string; academic_year: string | null } | null;
  student?: {
    id: string;
    enrollment_number: string;
    programme_semester: number;
    status: string;
    department: { id: string; name: string };
  };
  section?: {
    id: string;
    name: string;
    batch_year: number;
    programme: { id: string; name: string; code: string };
    year_of_study: number | null;
    class_incharge: { id: string; full_name: string } | null;
  } | null;
  department_term?: "active" | "ended" | null;
  offering_ids?: string[];
  incharge_sections?: { section_id: string; name: string; batch_year: number; programme_code: string; programme_name: string }[];
}

export interface MyClass {
  section_id: string;
  label: string;
  duration_semesters: number;
  students: { student_id: string; full_name: string | null; enrollment_number: string; semester: number; status: string }[];
}
