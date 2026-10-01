"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { assertClaimed, assertPersisted } from "@/lib/concurrent-claim";
import { assertNotSelfApproval } from "@/lib/segregation-of-duties";
import { PERMISSIONS } from "@/lib/permissions";
import { computeAffectedClasses, type AffectedClass } from "@/lib/leave-impact";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { dbError } from "@/lib/internal-error";
import { assertRead } from "@/lib/read-result-server";

const ActOnLeaveRequestSchema = z.object({
  requestId: z.string().guid(),
  action: z.enum(["approved", "rejected"]),
});

const PROCESSED_LIMIT = 20;

function hodApprovalsCacheKey(hodUserId: string) {
  return `hod-approvals:${hodUserId}`;
}

/**
 * Department-scoped, not just college-scoped — keyed by the HOD's own
 * user id (two HODs in the same college must never share a cache entry,
 * unlike everything else in Phase 3 which is safely college-scoped).
 * Returns {pending, processed} together in one cache entry, same
 * "simpler than coordinating two caches" call as director/faculty.
 */
export async function listHodApprovals() {
  const actor = await requireRole(["hod"]);
  const supabase = await createClient();

  return getCached(hodApprovalsCacheKey(actor.userId), 30, async () => {
    const { data: department, error: departmentError } = await supabase.from("departments").select("id").eq("hod_id", actor.userId).single();
    assertRead(departmentError);
    if (!department) {
      return { pending: [], processed: [] };
    }

    const { data: deptStaff, error: deptStaffError } = await supabase
      .from("profiles")
      .select("id")
      .eq("department_id", department.id);
    assertRead(deptStaffError);
    const staffIds = (deptStaff || []).map((s) => s.id);
    if (staffIds.length === 0) {
      return { pending: [], processed: [] };
    }

    const baseQuery = () =>
      supabase
        .from("leave_requests")
        .select("*, profiles:requested_by(full_name, email, role)")
        .in("requested_by", staffIds);

    const [pendingRes, processedRes] = await Promise.all([
      baseQuery().eq("status", "pending").order("created_at", { ascending: false }),
      baseQuery().neq("status", "pending").order("created_at", { ascending: false }).limit(PROCESSED_LIMIT),
    ]);
    assertRead(pendingRes.error);
    assertRead(processedRes.error);
    return { pending: pendingRes.data || [], processed: processedRes.data || [] };
  });
}


/**
 * The scheduled sessions a teacher delivers during a given date window.
 *
 * timetable_slots no longer carries instructor_id (047) — a slot belongs to
 * an offering, and the offering names the instructor, the section and the
 * semester. So "this teacher's classes" is now a two-hop question, and that
 * is an improvement rather than an inconvenience: the old column could
 * disagree with the offering it belonged to, and a teacher who took over a
 * section mid-year left the slot pointing at their predecessor.
 *
 * Each offering's sessions are clamped to ITS OWN semester window before
 * dates are enumerated. Leave spanning a semester boundary therefore
 * generates cover only for the classes that were actually running, instead
 * of projecting the current timetable across dates it never applied to.
 * Cancelled offerings are excluded — there is no class to cover.
 */
type SlotWithOffering = {
  id: string;
  offering_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
};

interface DeliveredSession extends AffectedClass {
  courseCode: string;
  courseName: string;
  sectionName: string;
}

async function resolveAffectedSessions(
  supabase: SupabaseClient<Database>,
  instructorId: string,
  startDate: string,
  endDate: string,
  requireSuccessfulRead = false
): Promise<DeliveredSession[]> {
  type OfferingWithContext = {
    id: string;
    status: string;
    semester_id: string;
    courses: { name: string; code: string } | null;
    sections: { name: string } | null;
    semesters: { start_date: string; end_date: string } | null;
  };

  const { data: offeringsRaw, error: offeringsError } = await supabase
    .from("course_offerings")
    .select(
      "id, status, semester_id, courses:course_id(name, code), sections:section_id(name), semesters:semester_id(start_date, end_date)"
    )
    .eq("instructor_id", instructorId);
  if (requireSuccessfulRead) assertRead(offeringsError);

  // Cast: the hand-maintained Database type declares no Relationships, so
  // embedded selects can't be inferred — the workaround used throughout.
  const offerings = (offeringsRaw as unknown as OfferingWithContext[] | null) || [];
  const live = offerings.filter((o) => o.status !== "cancelled");
  if (live.length === 0) return [];

  const { data: slotsRaw, error: slotsError } = await supabase
    .from("timetable_slots")
    .select("id, offering_id, day_of_week, start_time, end_time")
    .in("offering_id", live.map((o) => o.id));
  if (requireSuccessfulRead) assertRead(slotsError);

  const slots = (slotsRaw as SlotWithOffering[] | null) || [];
  if (slots.length === 0) return [];

  const sessions: DeliveredSession[] = [];
  for (const offering of live) {
    const mine = slots.filter((s) => s.offering_id === offering.id);
    if (mine.length === 0) continue;

    // Intersect the leave window with the semester this offering runs in.
    const from = offering.semesters?.start_date
      ? maxDate(startDate, offering.semesters.start_date)
      : startDate;
    const to = offering.semesters?.end_date ? minDate(endDate, offering.semesters.end_date) : endDate;
    if (from > to) continue;

    for (const affected of computeAffectedClasses(from, to, mine)) {
      sessions.push({
        ...affected,
        courseCode: offering.courses?.code || "",
        courseName: offering.courses?.name || "",
        sectionName: offering.sections?.name || "",
      });
    }
  }
  return sessions;
}

/** YYYY-MM-DD strings compare correctly lexicographically. */
function maxDate(a: string, b: string) {
  return a > b ? a : b;
}
function minDate(a: string, b: string) {
  return a < b ? a : b;
}

/**
 * Read-only — shows affected classes BEFORE the HOD clicks Approve, per the
 * spec's "Leave Impact Preview." Same department-ownership rule as
 * actOnLeaveRequestCore, and the same computeAffectedClasses function
 * createSubstitutionNeeds uses on actual approval, so the preview can never
 * drift from what approval will actually create.
 */
export async function previewLeaveImpact(requestId: string) {
  const actor = await requireRole(["hod", "admin"]);
  const supabase = await createClient();

  const { data: requestData, error: requestDataError } = await supabase
    .from("leave_requests")
    .select("requested_by, start_date, end_date, profiles:requested_by(full_name, department_id)")
    .eq("id", requestId)
    .single();
  assertRead(requestDataError);
  const request = requestData as any;
  if (!request) {
    throw new Error("Leave request not found.");
  }

  if (actor.role === "hod") {
    const { data: department, error: departmentError } = await supabase.from("departments").select("id").eq("hod_id", actor.userId).single();
    assertRead(departmentError);
    if (!department?.id || request.profiles?.department_id !== department.id) {
      throw new Error("You can only preview leave requests from your own department.");
    }
  }

  const affectedClasses = await resolveAffectedSessions(
    supabase,
    request.requested_by,
    request.start_date,
    request.end_date,
    // Preview failures must surface; post-approval substitution behavior is unchanged.
    true
  );

  return {
    teacherName: request.profiles?.full_name || "Unknown",
    affectedClasses,
  };
}

/**
 * Shared by the web Server Action below and app/api/mobile/leave/act's
 * Route Handler — same guarded logic either way, just a different transport.
 */
export async function actOnLeaveRequestCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  requestId: string,
  action: "approved" | "rejected"
) {
  ({ requestId, action } = ActOnLeaveRequestSchema.parse({ requestId, action }));
  await checkRateLimit(`actOnLeaveRequest:${actor.userId}`, 30, 60);

  // Fetched unconditionally now (previously only inside the hod branch) —
  // approving needs requested_by/start_date/end_date/status to compute
  // substitution needs and write a real audit diff, for both hod and admin.
  const { data: requestData } = await supabase
    .from("leave_requests")
    .select("requested_by, start_date, end_date, status, profiles:requested_by(department_id)")
    .eq("id", requestId)
    .single();

  // Cast to any: this hand-maintained types file doesn't declare table
  // Relationships, so embedded joins like profiles:requested_by(...)
  // can't be inferred — same pattern used throughout the rest of the app.
  const request = requestData as any;
  if (!request || request.status !== "pending") {
    throw new Error("Leave request not found or already processed.");
  }

  // A HOD carries their own department_id (set by lib/invitations.ts), so
  // their own leave request passes the department-ownership check below and
  // appears in their own queue. See lib/segregation-of-duties.ts.
  assertNotSelfApproval(actor, request.requested_by, "leave request");

  // A HOD may only act on leave requests from staff in their own
  // department; admin is unrestricted. leave_requests_read (RLS) is
  // college-wide for hod, not department-scoped, so this app-layer check
  // is what actually closes it — same technique as the course-ownership
  // checks in teacher/grading and teacher/attendance.
  if (actor.role === "hod") {
    // Resolved via departments.hod_id, same as hod/dashboard and
    // hod/reports — NOT via this HOD's own profiles.department_id, which
    // assigning someone as HOD doesn't set (see the comment in
    // hod/faculty/page.tsx for the full explanation).
    const { data: department } = await supabase.from("departments").select("id").eq("hod_id", actor.userId).single();
    const requesterDeptId = request.profiles?.department_id;
    if (!department?.id || requesterDeptId !== department.id) {
      throw new Error("You can only act on leave requests from your own department.");
    }
  }

  // .eq("status", "pending") re-asserts the precondition checked above as part
  // of this write, so two HODs approving at the same moment can't both pass —
  // otherwise the second overwrites approved_by and createSubstitutionNeeds
  // below runs twice. See lib/concurrent-claim.ts.
  const { data: claimed, error } = await supabase
    .from("leave_requests")
    .update({
      status: action,
      approved_by: actor.userId,
      approved_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .eq("college_id", actor.collegeId)
    .eq("status", "pending")
    .select("id");

  if (error) {
    throw dbError(error);
  }
  assertClaimed(claimed, "leave request");

  await logAudit(supabase, actor, action === "approved" ? "leave_approved" : "leave_rejected", "leave_requests", requestId, {
    oldValue: { status: request.status },
    newValue: { status: action },
  });

  if (action === "approved") {
    await createSubstitutionNeeds(supabase, actor, requestId, request.requested_by, request.start_date, request.end_date);
  }
}

/**
 * Called after a leave request is approved — resolves the classes the
 * teacher actually delivers over the leave window (same resolver
 * previewLeaveImpact uses, so the preview can never disagree with what
 * approval creates) and opens one 'needed' substitution row per session.
 *
 * Purely additive: teachers keep marking their own attendance, this only
 * lets a HOD assign someone to cover specific already-identified classes.
 */
async function createSubstitutionNeeds(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  leaveRequestId: string,
  requestedBy: string,
  startDate: string,
  endDate: string
) {
  const affected = await resolveAffectedSessions(supabase, requestedBy, startDate, endDate);
  if (affected.length === 0) return;

  const rows = affected.map((c) => ({
    college_id: actor.collegeId,
    leave_request_id: leaveRequestId,
    offering_id: c.offeringId,
    timetable_slot_id: c.slotId,
    original_teacher_id: requestedBy,
    date: c.date,
    status: "needed" as const,
  }));

  // ON CONFLICT DO NOTHING via ignoreDuplicates, now on (offering_id, date)
  // to match the constraint 047 installed — the same offering can't get two
  // 'needed' rows for one day even if this runs twice.
  //
  // Zero affected rows is the CORRECT outcome of a re-run here, which is why
  // this deliberately does not use assertPersisted (see lib/concurrent-claim).
  // Non-fatal: the leave approval itself is already committed and matters
  // more than substitution tracking — but a failure must not be silent, or a
  // HOD sees leave approved and "Substitution Management" empty with no
  // explanation.
  const { error } = await supabase
    .from("substitution_assignments")
    .upsert(rows, { onConflict: "offering_id,date", ignoreDuplicates: true });
  if (error) {
    console.error(`createSubstitutionNeeds failed for leave request ${leaveRequestId}:`, error.message);
  }
}

export async function actOnLeaveRequest(
  requestId: string,
  action: "approved" | "rejected"
) {
  const actor = await requireRole(["hod", "admin"]);
  const supabase = await createClient();
  await actOnLeaveRequestCore(supabase, actor, requestId, action);
  revalidatePath("/hod/approvals");
  if (actor.role === "hod") {
    await invalidateCache(hodApprovalsCacheKey(actor.userId));
  }
  // else: admin acting on a HOD-owned request (the unrestricted branch in
  // actOnLeaveRequestCore above) — that HOD's cache isn't invalidated here,
  // it just rides out the 30s TTL. Rare path (admin bypassing the normal
  // per-department UI), not worth an extra query to resolve whose cache
  // to bust.
}

/** Called by app/api/mobile/leave/act/route.ts. */
export async function actOnLeaveRequestViaRequest(
  request: Request,
  requestId: string,
  action: "approved" | "rejected"
) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["hod", "admin"]);
  await actOnLeaveRequestCore(supabase, actor, requestId, action);
}

function correctionsCacheKey(hodUserId: string) {
  return `hod-corrections:${hodUserId}`;
}

/**
 * Department-scoped by the *course's* department, not the submitting
 * teacher's own profile.department_id (unlike listHodApprovals' leave
 * scoping) — a correction is a claim about a specific course's records, so
 * the course's own department is the correct approval boundary even in the
 * (currently rare, schema-permitted) case a teacher's home department
 * differs from a course they teach.
 */
const CORRECTIONS_PROCESSED_LIMIT = 20;

export async function listCorrectionApprovals() {
  const actor = await requireRole(PERMISSIONS.attendance_correction_review);
  const supabase = await createClient();

  return getCached(correctionsCacheKey(actor.userId), 30, async () => {
    const selectCols = "*, courses:course_id(name, code), profiles:submitted_by(full_name), students:student_id(enrollment_number)";

    if (actor.role === "admin") {
      const baseQuery = () => supabase.from("attendance_correction_requests").select(selectCols);
      const [pendingRes, processedRes] = await Promise.all([
        baseQuery().eq("status", "pending").order("created_at", { ascending: false }),
        baseQuery().neq("status", "pending").order("created_at", { ascending: false }).limit(CORRECTIONS_PROCESSED_LIMIT),
      ]);
      assertRead(pendingRes.error);
      assertRead(processedRes.error);
      return { pending: pendingRes.data || [], processed: processedRes.data || [] };
    }

    const { data: department, error: departmentError } = await supabase.from("departments").select("id").eq("hod_id", actor.userId).single();
    assertRead(departmentError);
    if (!department) return { pending: [], processed: [] };

    // 047 dropped attendance_correction_requests.course_id; the request names
    // the OFFERING, so department scope resolves through the offering's course.
    const { data: deptOfferings, error: deptOfferingsError } = await supabase
      .from("course_offerings")
      .select("id, courses:course_id!inner(department_id)")
      .eq("courses.department_id", department.id);
    assertRead(deptOfferingsError);
    const offeringIds = ((deptOfferings as unknown as { id: string }[]) || []).map((o) => o.id);
    if (offeringIds.length === 0) return { pending: [], processed: [] };

    const baseQuery = () =>
      supabase.from("attendance_correction_requests").select(selectCols).in("offering_id", offeringIds);
    const [pendingRes, processedRes] = await Promise.all([
      baseQuery().eq("status", "pending").order("created_at", { ascending: false }),
      baseQuery().neq("status", "pending").order("created_at", { ascending: false }).limit(CORRECTIONS_PROCESSED_LIMIT),
    ]);
    assertRead(pendingRes.error);
    assertRead(processedRes.error);
    return { pending: pendingRes.data || [], processed: processedRes.data || [] };
  });
}

const ActOnCorrectionSchema = z.object({
  requestId: z.string().guid(),
  action: z.enum(["approved", "rejected"]),
});

export async function actOnAttendanceCorrectionCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  requestIdRaw: string,
  actionRaw: "approved" | "rejected"
) {
  const { requestId, action } = ActOnCorrectionSchema.parse({ requestId: requestIdRaw, action: actionRaw });
  await checkRateLimit(`actOnAttendanceCorrection:${actor.userId}`, 30, 60);

  // Cast: same embedded-select workaround as requestAttendanceCorrection.
  type CorrectionWithCourse = Database["public"]["Tables"]["attendance_correction_requests"]["Row"] & {
    course_offerings: { courses: { department_id: string } | null } | null;
  };
  const { data: requestRaw } = await supabase
    .from("attendance_correction_requests")
    .select("*, course_offerings:offering_id(courses:course_id(department_id))")
    .eq("id", requestId)
    .eq("college_id", actor.collegeId)
    .single();
  const request = requestRaw as CorrectionWithCourse | null;

  if (!request || request.status !== "pending") {
    throw new Error("Correction request not found or already processed.");
  }
  assertNotSelfApproval(actor, request.submitted_by, "attendance correction");

  if (actor.role === "hod") {
    const { data: department } = await supabase.from("departments").select("id").eq("hod_id", actor.userId).single();
    const courseDeptId = request.course_offerings?.courses?.department_id;
    if (!department?.id || courseDeptId !== department.id) {
      throw new Error("You can only act on correction requests for courses in your own department.");
    }
  }

  // Same compare-and-swap as actOnLeaveRequestCore — without it two reviewers
  // both pass the pending check above and the attendance row below gets
  // written twice, the second time from a stale requested_status.
  const { data: claimed, error: updateRequestError } = await supabase
    .from("attendance_correction_requests")
    .update({ status: action, reviewed_by: actor.userId, reviewed_at: new Date().toISOString() })
    .eq("id", requestId)
    .eq("status", "pending")
    .select("id");
  if (updateRequestError) {
    throw dbError(updateRequestError);
  }
  assertClaimed(claimed, "correction request");

  if (action === "approved") {
    // ORDER IS FORCED, not incidental: 047's attendance_update_approved_correction
    // policy authorizes this write only while an APPROVED request pointing at
    // this row exists, naming this actor as reviewer. So the request must be
    // claimed above before the attendance row can be touched.
    //
    // And the result must be measured. This exact statement is why migration
    // 038 exists — RLS silently matched zero rows, the request was marked
    // approved, the audit log recorded the change, and the attendance status
    // never moved. Everything downstream said the correction had been applied.
    // Only counting the affected rows catches that.
    const { data: corrected, error: updateAttendanceError } = await supabase
      .from("attendance")
      .update({ status: request.requested_status })
      .eq("id", request.attendance_id)
      .select("id");
    if (updateAttendanceError) {
      throw dbError(updateAttendanceError);
    }
    assertPersisted(corrected, 1, "attendance");
    await logAudit(supabase, actor, "attendance_correction_approved", "attendance", request.attendance_id, {
      oldValue: request.current_status,
      newValue: request.requested_status,
    });
  }
}

export async function actOnAttendanceCorrection(requestId: string, action: "approved" | "rejected") {
  const actor = await requireRole(PERMISSIONS.attendance_correction_review);
  const supabase = await createClient();
  await actOnAttendanceCorrectionCore(supabase, actor, requestId, action);
  revalidatePath("/hod/approvals");
  revalidatePath("/teacher/attendance");
  if (actor.role === "hod") {
    await invalidateCache(correctionsCacheKey(actor.userId));
  }
}
