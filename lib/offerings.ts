import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthorizedActor } from "@/lib/rbac";
import type { Database } from "@/types/database";

/**
 * Server-side authority for the offering-centric academic model
 * (migrations 046/047).
 *
 * A `course` is catalog data; a `course_offering` is that course actually
 * being delivered — one semester, one section, one instructor. Every academic
 * transaction (attendance, marks, enrollment, timetable, substitution) now
 * hangs off the offering, so "may this actor write here?" becomes "does this
 * actor hold this offering?" rather than "does this actor own this course?".
 *
 * THREE DISTINCT AUTHORITIES, deliberately not collapsed into one predicate:
 *
 *   READ    — who may see an offering and its records.
 *             Enforced in RLS, NOT here. `course_offerings_read` (046) is
 *             college-wide for every authenticated role; `attendance`/`marks`
 *             reads are college-wide for staff and own-rows-only for a
 *             student, resolved through `students.user_id = auth.uid()`.
 *             Student record ownership therefore derives from the
 *             authenticated identity in the database and cannot be reached by
 *             passing another student's id. Duplicating a read gate here would
 *             be app-layer theatre over a rule RLS already enforces.
 *
 *   WRITE   — who may create/update attendance or marks.
 *             `canWriteOfferingRecords` / `assertCanWriteOfferingRecords`,
 *             plus `assertCanRecordAttendance` for the date-scoped substitute
 *             widening. Assignment-based, never role-based.
 *
 *   REVIEW  — who may approve/reject a correction or assign a substitute.
 *             `assertOfferingInReviewScope`. Department-based.
 *
 * Write and review are disjoint on purpose: a department head reviews what a
 * teacher recorded, and cannot quietly become the person who records it. See
 * `canWriteOfferingRecords` for why that separation is load-bearing.
 *
 * The rule all of this exists to enforce: authority is DERIVED from the
 * authenticated user and server-side relationships, never from an id the
 * client supplied. A request carrying `instructorId` or `departmentId` proves
 * nothing — the server re-reads the offering and decides.
 */

export type OfferingStatus = "planned" | "active" | "completed" | "cancelled";

export interface OfferingContext {
  id: string;
  collegeId: string;
  semesterId: string;
  courseId: string;
  sectionId: string;
  instructorId: string | null;
  departmentId: string;
  status: OfferingStatus;
}

type OfferingRow = {
  id: string;
  college_id: string;
  semester_id: string;
  course_id: string;
  section_id: string;
  instructor_id: string | null;
  status: OfferingStatus;
  courses: { department_id: string } | null;
};

/**
 * Loads an offering with the department resolved through its course, and
 * fails if it belongs to another college.
 *
 * Every failure path here throws rather than returning a nullable context:
 * missing offering, wrong college, course without a department. A caller that
 * cannot tell "denied" from "no data" is a caller that eventually treats
 * missing data as permission, so this never hands back an ambiguous value.
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
    .select(
      "id, college_id, semester_id, course_id, section_id, instructor_id, status, courses:course_id(department_id)"
    )
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
    status: offering.status,
  };
}

/**
 * May this actor record attendance or marks against this offering?
 *
 * - admin: any offering in their college.
 * - the assigned instructor (teacher OR a teaching hod): their own offering.
 * - anyone else: no.
 *
 * A cancelled offering is closed to writes for everyone. That is the only
 * lifecycle gate applied here; `planned`, `active` and `completed` all stay
 * writable because end-of-term marks legitimately land against a completed
 * offering. Finalization ("results published — no further edits") does not
 * exist in this schema yet and is NOT invented here; see the file footer.
 *
 * Note what is NOT here: `hod` does not get blanket write access to their
 * department's offerings. A HOD who teaches passes as the instructor like
 * anyone else; a HOD who does not teach a section has no business entering
 * its marks, and the correction-request workflow already exists for fixing a
 * teacher's records with sign-off. Widening this would collapse
 * request -> review -> approve into one actor and delete the only separation
 * of duties the academic module has.
 *
 * Authority tracks the CURRENT assignment, which cuts both ways and is worth
 * stating: a teacher reassigned off an offering loses write access to records
 * they created, and their replacement gains it. Because an offering is
 * semester-scoped, this cannot reach across academic periods — last
 * semester's records belong to last semester's offering, which has its own
 * instructor. Within one semester, reassignment transferring custody is the
 * intended behaviour; it is the offering that is being handed over, not just
 * the timetable.
 */
export function canWriteOfferingRecords(actor: AuthorizedActor, offering: OfferingContext): boolean {
  if (offering.status === "cancelled") return false;
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
 * Attendance write authority, which is strictly wider than marks write
 * authority by exactly one case: a substitute assigned by the HOD may mark
 * THIS offering on THIS date.
 *
 * That widening is what makes "teacher takes leave -> HOD assigns a cover ->
 * the cover actually records attendance" real rather than decorative. It is
 * scoped to the single date on the assignment row, so it grants no standing
 * authority over the offering, and it deliberately has no counterpart for
 * marks: covering one class does not confer authority over a section's
 * assessment record.
 *
 * This lives here, not inline in the attendance action, because the web
 * Server Action and the mobile route handler must not be able to disagree
 * about it — a substitute path present in one transport and absent in the
 * other is how an authority boundary silently becomes two boundaries.
 */
export async function assertCanRecordAttendance(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  offeringId: string,
  date: string
): Promise<OfferingContext> {
  const offering = await loadOffering(supabase, actor, offeringId);
  if (canWriteOfferingRecords(actor, offering)) {
    return offering;
  }

  // A cancelled offering has no classes to cover, so no substitution can
  // reopen it. Checked before the lookup so the widening can never be wider
  // than the base rule it widens.
  if (offering.status !== "cancelled") {
    const { data: substitution } = await supabase
      .from("substitution_assignments")
      .select("id")
      .eq("offering_id", offeringId)
      .eq("date", date)
      .eq("substitute_teacher_id", actor.userId)
      .eq("status", "assigned")
      .maybeSingle();

    if (substitution) {
      return offering;
    }
  }

  throw new Error("You can only record attendance for course offerings assigned to you.");
}

/**
 * The departments an actor heads, via `departments.hod_id` — never from a
 * department id in the request (the codebase's established rule; see
 * actOnLeaveRequestCore's comment on why profiles.department_id is the wrong
 * source).
 *
 * Returns a LIST because `departments.hod_id` carries no unique constraint
 * (migration 002) and one person heading two departments is ordinary in a
 * small college. The single-row form of this query, which four other call
 * sites still use, resolves such a HOD to null and silently denies them
 * everything — fail-closed, but wrong.
 */
export async function resolveHodDepartmentIds(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor
): Promise<string[]> {
  const { data } = await supabase
    .from("departments")
    .select("id")
    .eq("hod_id", actor.userId);
  return (data ?? []).map((d) => d.id);
}

/**
 * Department-scoped REVIEW authority: approving an attendance correction, or
 * assigning a substitute, for an offering in a department the actor heads.
 * admin is unscoped, matching every other *Core review function here.
 *
 * This grants no write access to the underlying records — a reviewer decides
 * a request, and the approval path applies the change. Keeping the two apart
 * is the point of the split; see canWriteOfferingRecords.
 *
 * Separation of duties (requester != approver) is a further, orthogonal check
 * and stays where it already is: assertNotSelfApproval in
 * lib/segregation-of-duties.ts, called on the request's submitted_by. Scope
 * and self-dealing are different questions and this function only answers the
 * first.
 */
export async function assertOfferingInReviewScope(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  offering: OfferingContext
): Promise<void> {
  if (actor.role === "admin") return;

  const departmentIds = await resolveHodDepartmentIds(supabase, actor);
  if (!departmentIds.includes(offering.departmentId)) {
    throw new Error("You can only act on course offerings in your own department.");
  }
}

/**
 * The offerings an actor may teach against — what a teacher's picker should
 * list, derived from the offering assignment rather than the deprecated
 * courses.instructor_id.
 *
 * This is a convenience for building UI, not a security boundary: nothing
 * downstream may assume an offeringId is safe because it appeared here. Every
 * write re-checks through assertCanWriteOfferingRecords /
 * assertCanRecordAttendance, because a client can send an id this list never
 * contained.
 *
 * Takes an explicit semesterId rather than silently defaulting to "current" —
 * historical records stay attached to their own offering, and a helper that
 * quietly assumes the active semester is how history becomes unreachable.
 */
export async function listTeachableOfferings(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  semesterId?: string
) {
  let query = supabase
    .from("course_offerings")
    .select(
      "id, semester_id, course_id, section_id, status, courses:course_id(name, code), sections:section_id(name, batch_year)"
    )
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
 * so `maybeSingle()` is safe rather than optimistic. Callers reading or
 * writing HISTORICAL records must not use this — they take the semester from
 * the offering they are already working with.
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

/**
 * NOT IMPLEMENTED HERE, deliberately — recorded so the next reader doesn't
 * assume these are covered:
 *
 * - Result finalization. `semesters.status = 'closed'` does not currently
 *   block academic writes, and no "results published" flag exists. Adding one
 *   is a schema + workflow decision, not something to infer in a helper.
 * - Inactive staff. requireRole already rejects a non-active profile at the
 *   door, so an offering left pointing at a deactivated instructor denies
 *   that person by session, not by assignment.
 * - Offering MANAGEMENT — creating an offering, or changing its instructor,
 *   section, course or semester. Nothing in this repository writes
 *   `course_offerings`: not a Server Action, not an API route, not the React
 *   Native app. The same is true of sections, programmes and enrollments.
 *   Semesters and academic years DO have one now —
 *   app/(portal)/admin/academic-periods — so a term can be opened and closed
 *   through the product; but with no way to create the offerings inside it,
 *   the academic module still cannot be operated end to end. That is a
 *   missing feature, recorded as such, not something to paper over here.
 *
 *   When that screen is built, the rule it must enforce is already in the
 *   database (047 §7d, `course_offerings_manage`): admin and director act
 *   college-wide; a HOD acts only on offerings whose COURSE belongs to a
 *   department they head, both before and after the change. Use
 *   resolveHodDepartmentIds against the offering's departmentId — the same
 *   pair assertOfferingInReviewScope already uses — rather than inventing a
 *   second notion of an HOD's scope.
 *
 * WHAT THE DATABASE NOW ENFORCES ON ITS OWN
 *
 * An earlier version of this note said RLS on `attendance` and `marks` was
 * role-only and that these helpers were the only layer checking assignment.
 * That stopped being true when 047 §7 was written: `can_write_offering_records`
 * and `can_record_attendance` are SECURITY DEFINER functions carrying the same
 * rule as canWriteOfferingRecords / assertCanRecordAttendance above, and the
 * policies on both tables call them. A raw PostgREST call with a valid session
 * is now refused by the database, not merely by this file.
 *
 * The two layers are deliberately redundant, and they must be changed
 * together: if you weaken one, nothing here will tell you the other is now
 * the only thing standing.
 */
