import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthorizedActor } from "@/lib/rbac";
import type { Database } from "@/types/database";

/**
 * Server-side authority checks for the offering-centric academic model
 * (migrations 046/047).
 *
 * A `course` is catalog data; a `course_offering` is that course actually
 * being delivered — one semester, one section, one instructor. Every academic
 * transaction (attendance, marks, enrollment, timetable, substitution) now
 * hangs off the offering, so "may this actor write here?" becomes "does this
 * actor own this offering?" rather than "does this actor own this course?".
 *
 * The rule these helpers exist to enforce: authority is DERIVED from the
 * authenticated user and server-side relationships, never from an id the
 * client supplied. A request carrying `instructorId` or `departmentId` proves
 * nothing — the server re-reads the offering and decides.
 */

export interface OfferingContext {
  id: string;
  collegeId: string;
  semesterId: string;
  courseId: string;
  sectionId: string;
  instructorId: string | null;
  departmentId: string;
}

type OfferingRow = {
  id: string;
  college_id: string;
  semester_id: string;
  course_id: string;
  section_id: string;
  instructor_id: string | null;
  courses: { department_id: string } | null;
};

/**
 * Loads an offering with the department resolved through its course, and
 * fails if it belongs to another college.
 *
 * The tenancy check is here rather than left to RLS on purpose: RLS on
 * `course_offerings` is a college-scoped read for every role, so a
 * cross-college id would return no row and the caller would report "not
 * found" — correct, but this makes the boundary explicit at the one place
 * every academic write passes through.
 */
export async function loadOffering(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  offeringId: string
): Promise<OfferingContext> {
  const { data } = await supabase
    .from("course_offerings")
    .select("id, college_id, semester_id, course_id, section_id, instructor_id, courses:course_id(department_id)")
    .eq("id", offeringId)
    .maybeSingle();

  // Cast: this hand-maintained types file declares no Relationships, so the
  // embedded courses:course_id(...) join can't be inferred — the same
  // workaround every other actions.ts with an embedded select already uses.
  const offering = data as unknown as OfferingRow | null;

  if (!offering || offering.college_id !== actor.collegeId) {
    throw new Error("Course offering not found in your college.");
  }
  if (!offering.courses?.department_id) {
    throw new Error("This course offering has no department — its course record is incomplete.");
  }

  return {
    id: offering.id,
    collegeId: offering.college_id,
    semesterId: offering.semester_id,
    courseId: offering.course_id,
    sectionId: offering.section_id,
    instructorId: offering.instructor_id,
    departmentId: offering.courses.department_id,
  };
}

/**
 * May this actor record attendance or marks against this offering?
 *
 * - admin: any offering in their college.
 * - the assigned instructor (teacher OR a teaching hod): their own offering.
 * - anyone else: no.
 *
 * Note what is NOT here: `hod` does not get blanket write access to their
 * department's offerings. A HOD who teaches passes as the instructor like
 * anyone else; a HOD who does not teach a section has no business entering
 * its marks, and the correction-request workflow already exists for fixing
 * a teacher's records with sign-off. Widening this would quietly turn an
 * approval workflow into a direct-write one.
 */
export function canWriteOfferingRecords(actor: AuthorizedActor, offering: OfferingContext): boolean {
  if (actor.role === "admin") return true;
  return offering.instructorId !== null && offering.instructorId === actor.userId;
}

export async function assertCanWriteOfferingRecords(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  offeringId: string
): Promise<OfferingContext> {
  const offering = await loadOffering(supabase, actor, offeringId);
  if (!canWriteOfferingRecords(actor, offering)) {
    throw new Error("You can only record academic records for course offerings assigned to you.");
  }
  return offering;
}

/**
 * A HOD's authority comes from `departments.hod_id`, never from a
 * department id in the request — the codebase's established rule (see
 * actOnLeaveRequestCore's comment on why profiles.department_id is the wrong
 * source). Returns null when the actor holds no department.
 */
export async function resolveHodDepartmentId(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor
): Promise<string | null> {
  const { data } = await supabase
    .from("departments")
    .select("id")
    .eq("hod_id", actor.userId)
    .maybeSingle();
  return data?.id ?? null;
}

/**
 * Department-scoped review authority: approving an attendance correction, or
 * assigning a substitute, for an offering in the HOD's own department. admin
 * is unscoped, matching every other *Core review function in this codebase.
 */
export async function assertOfferingInReviewScope(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  offering: OfferingContext
): Promise<void> {
  if (actor.role === "admin") return;

  const departmentId = await resolveHodDepartmentId(supabase, actor);
  if (!departmentId || departmentId !== offering.departmentId) {
    throw new Error("You can only act on course offerings in your own department.");
  }
}

/**
 * The offerings an actor may teach against — what a teacher's course picker
 * should list, derived from the offering assignment rather than the
 * deprecated courses.instructor_id.
 *
 * Scoped to the active semester by default. Historical records must stay
 * attached to their own offering, so this deliberately takes a semesterId
 * rather than silently defaulting everything to "current" (per the brief's
 * warning against attaching everything to the current semester).
 */
export async function listTeachableOfferings(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  semesterId?: string
) {
  let query = supabase
    .from("course_offerings")
    .select("id, semester_id, course_id, section_id, status, courses:course_id(name, code), sections:section_id(name, batch_year)")
    .eq("college_id", actor.collegeId);

  if (actor.role !== "admin") {
    query = query.eq("instructor_id", actor.userId);
  }
  if (semesterId) {
    query = query.eq("semester_id", semesterId);
  }

  const { data } = await query;
  return data ?? [];
}

/**
 * The college's currently active semester, or null.
 *
 * Migration 046 enforces at most one per college with a partial unique index,
 * so `maybeSingle()` is safe rather than optimistic. Callers that are reading
 * or writing HISTORICAL records must not use this — they take the semester
 * from the offering they are already working with.
 */
export async function getActiveSemesterId(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor
): Promise<string | null> {
  const { data } = await supabase
    .from("semesters")
    .select("id")
    .eq("college_id", actor.collegeId)
    .eq("status", "active")
    .maybeSingle();
  return data?.id ?? null;
}
