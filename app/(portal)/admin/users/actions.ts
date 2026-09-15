"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { logAudit } from "@/lib/audit";
import { assertClaimed } from "@/lib/concurrent-claim";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache, middlewareProfileCacheKey } from "@/lib/cache";
import { inviteUserCore, resendInvitationCore, revokeInvitationCore, type InviteUserParams } from "@/lib/invitations";
import { computeEffectiveFeeStatus } from "@/lib/finance-status";
import { resolveProfileStatusForAcademicTransition, type StudentAcademicStatus } from "@/lib/student-lifecycle";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, UserRole, UserStatus } from "@/types/database";
import type { DataTableQuery } from "@/components/ui/data-table";
import { dbError } from "@/lib/internal-error";

const USERS_PAGE_SIZE = 10;
// Server actions are callable directly (not just through the UI that only
// ever sends these), so sortKey needs the same "never trust client input"
// treatment as everything else here — an unvalidated column name reaching
// .order() is a query-shape footgun, not an injection risk (PostgREST
// parses it, doesn't concatenate raw SQL), but it's still adversarial input
// per this repo's own rule, and worth keeping the cache key from being
// polluted by arbitrary attacker-supplied sort strings.
const USERS_SORT_COLUMNS = new Set(["full_name", "email", "role"]);

function usersCacheKey(collegeId: string, q: DataTableQuery, sortColumn: string) {
  return `list:users:${collegeId}:${q.page}:${sortColumn}:${q.sortDir}:${q.search}`;
}

/**
 * Cached, paginated, real .range() query — replaces the browser calling
 * Supabase directly (as every other list page originally did, and as the
 * ~14 pages not yet migrated to this pattern still do). getCached() only
 * works server-side (needs the Redis service token, never exposed to the
 * client), so this has to be a Server Action rather than a helper the
 * client component calls into directly.
 */
export async function listUsers(q: DataTableQuery) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();

  const sortColumn = q.sortKey && USERS_SORT_COLUMNS.has(q.sortKey) ? q.sortKey : "created_at";
  const cacheKey = usersCacheKey(actor.collegeId, q, sortColumn);

  return getCached(cacheKey, 30, async () => {
    let dbQuery = supabase
      .from("profiles")
      .select("*, departments:department_id(name)", { count: "exact" })
      .eq("college_id", actor.collegeId);

    if (q.search) {
      dbQuery = dbQuery.ilike("full_name", `%${q.search}%`);
    }
    dbQuery = dbQuery.order(sortColumn, { ascending: q.sortKey ? q.sortDir === "asc" : false });

    const from = q.page * USERS_PAGE_SIZE;
    const { data, count } = await dbQuery.range(from, from + USERS_PAGE_SIZE - 1);
    return { data: data || [], count: count ?? 0 };
  });
}

// Deliberately excludes "super_admin" — this is the only thing standing
// between an admin's "edit role" form and the DB write once UserRole grows
// to include it. Also excludes "parent" (a valid DB-level role via a CHECK
// constraint, but with no app-layer support anywhere — see the "parent"
// gap noted throughout lib/rbac.ts-adjacent code). Do not widen this to
// UserRole directly.
const USER_ROLES = ["student", "teacher", "hod", "finance", "director", "admin", "warden"] as const;
const USER_STATUSES = ["active", "suspended", "pending", "graduated", "alumni"] as const;

/**
 * Shared by the web Server Action below and
 * app/api/mobile/admin/invite-user's Route Handler. The actual invite logic
 * (Zod validation, invite-tier check, rate limiting, inviteUserByEmail,
 * bookkeeping insert, audit log) lives in lib/invitations.ts's
 * inviteUserCore, shared across every invite-capable tier.
 */
export async function inviteUser(params: InviteUserParams) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();
  await inviteUserCore(supabase, actor, params);
  revalidatePath("/admin/users");
}

/** Called by app/api/mobile/admin/invite-user/route.ts. */
export async function inviteUserViaRequest(request: Request, params: InviteUserParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["admin"]);
  await inviteUserCore(supabase, actor, params);
}

export async function resendInvitation(invitationId: string) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();
  await resendInvitationCore(supabase, actor, invitationId);
  revalidatePath("/admin/users");
}

/** Called by app/api/mobile/admin/invitations/resend/route.ts. */
export async function resendInvitationViaRequest(request: Request, invitationId: string) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["admin"]);
  await resendInvitationCore(supabase, actor, invitationId);
}

export async function revokeInvitation(invitationId: string) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();
  await revokeInvitationCore(supabase, actor, invitationId);
  revalidatePath("/admin/users");
}

/** Called by app/api/mobile/admin/invitations/revoke/route.ts. */
export async function revokeInvitationViaRequest(request: Request, invitationId: string) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["admin"]);
  await revokeInvitationCore(supabase, actor, invitationId);
}

const UpdateUserProfileSchema = z.object({
  targetUserId: z.string().guid(),
  fullName: z.string().trim().min(1, { message: "Full name is required." }).max(200),
  role: z.enum(USER_ROLES),
  phone: z.string().trim().max(20).optional(),
});

export interface UpdateUserProfileParams {
  targetUserId: string;
  fullName: string;
  role: UserRole;
  phone?: string;
}

/**
 * Shared by the web Server Action below and
 * app/api/mobile/admin/update-user's Route Handler.
 */
export async function updateUserProfileCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: UpdateUserProfileParams
) {
  const { targetUserId, fullName, role, phone } = UpdateUserProfileSchema.parse(params);
  await checkRateLimit(`updateUserProfile:${actor.userId}`, 20, 60);

  // The result is checked, not assumed. Migration 042's trigger refuses some
  // of these writes outright (an admin granting super_admin, or editing
  // their own role) and RLS filters a foreign-college target to zero rows
  // with no error at all. Either way the old code went on to write an audit
  // row saying the role had changed — a false receipt for a privilege
  // change, which is the one place an audit trail must not lie.
  const { data: updated, error } = await supabase
    .from("profiles")
    .update({ full_name: fullName, role, phone: phone || null })
    .eq("id", targetUserId)
    .eq("college_id", actor.collegeId)
    .select("id");
  if (error) throw dbError(error);
  assertClaimed(updated, "user profile");

  // Changes `role`, which middleware's route-access check reads (cached,
  // see lib/supabase/middleware.ts) — bust it so the propagation window is
  // the documented TTL, not TTL-plus-whatever-this-request's-latency-was.
  await invalidateCache(middlewareProfileCacheKey(targetUserId));

  await logAudit(supabase, actor, `Updated profile (role: ${role})`, "profiles", targetUserId);
}

export async function updateUserProfile(
  targetUserId: string,
  fullName: string,
  role: UserRole,
  phone?: string,
  viewQuery?: DataTableQuery
) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();
  await updateUserProfileCore(supabase, actor, { targetUserId, fullName, role, phone });
  revalidatePath("/admin/users");
  // Bust the exact cached view the caller is looking at — see listUsers'
  // comment above on why TTL-only (the dashboards' pattern) isn't enough
  // for a CRUD list where the actor expects to see their own write land.
  if (viewQuery) {
    const sortColumn = viewQuery.sortKey && USERS_SORT_COLUMNS.has(viewQuery.sortKey) ? viewQuery.sortKey : "created_at";
    await invalidateCache(usersCacheKey(actor.collegeId, viewQuery, sortColumn));
  }
}

/** Called by app/api/mobile/admin/update-user/route.ts. */
export async function updateUserProfileViaRequest(request: Request, params: UpdateUserProfileParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["admin"]);
  await updateUserProfileCore(supabase, actor, params);
}

const UpdateUserStatusSchema = z.object({
  targetUserId: z.string().guid(),
  status: z.enum(USER_STATUSES),
});

/**
 * Shared by the web Server Action below and
 * app/api/mobile/admin/user-status's Route Handler.
 */
export async function updateUserStatusCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  targetUserId: string,
  status: UserStatus
) {
  ({ targetUserId, status } = UpdateUserStatusSchema.parse({ targetUserId, status }));
  await checkRateLimit(`updateUserStatus:${actor.userId}`, 20, 60);

  if (targetUserId === actor.userId && status !== "active") {
    throw new Error("You can't suspend your own account.");
  }

  // Same rule as updateUserProfileCore: a refused or filtered write must not
  // reach the audit log as "Changed status".
  const { data: updated, error } = await supabase
    .from("profiles")
    .update({ status })
    .eq("id", targetUserId)
    .eq("college_id", actor.collegeId)
    .select("id");
  if (error) throw dbError(error);
  assertClaimed(updated, "user profile");

  // Changes `status`, which middleware's active-account check reads
  // (cached) — a suspended user's browser should stop being routed to
  // portal pages within the documented TTL, not TTL-plus-request-latency.
  await invalidateCache(middlewareProfileCacheKey(targetUserId));

  await logAudit(supabase, actor, `Changed status to ${status}`, "profiles", targetUserId);
}

export async function updateUserStatus(targetUserId: string, status: UserStatus, viewQuery?: DataTableQuery) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();
  await updateUserStatusCore(supabase, actor, targetUserId, status);
  revalidatePath("/admin/users");
  if (viewQuery) {
    const sortColumn = viewQuery.sortKey && USERS_SORT_COLUMNS.has(viewQuery.sortKey) ? viewQuery.sortKey : "created_at";
    await invalidateCache(usersCacheKey(actor.collegeId, viewQuery, sortColumn));
  }
}

/** Called by app/api/mobile/admin/user-status/route.ts. */
export async function updateUserStatusViaRequest(request: Request, targetUserId: string, status: UserStatus) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["admin"]);
  await updateUserStatusCore(supabase, actor, targetUserId, status);
}

const STUDENT_ACADEMIC_STATUSES = ["active", "suspended", "graduated", "dropped", "on_leave"] as const;

export interface StudentAcademicSummary {
  studentId: string;
  status: StudentAcademicStatus;
  enrollmentNumber: string;
  batchYear: number;
  semester: number;
  outstandingFees: number;
  hasActiveHostelAllocation: boolean;
  hasOpenGatePass: boolean;
}

/**
 * Informational only — every signal here is live-computed, never a reason
 * to block the transition below. Blocking on outstanding fees/hostel
 * allocation would encode institutional policy this codebase has no basis
 * to assume (same "surface, don't silently gate" principle already applied
 * to Finance clearance and hostel expense requests). Returns null if the
 * target user isn't a student — this is called from the generic user-edit
 * modal, which doesn't otherwise know that up front.
 */
export async function getStudentAcademicSummary(targetUserId: string): Promise<StudentAcademicSummary | null> {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();

  const { data: student } = await supabase
    .from("students")
    .select("id, status, enrollment_number, batch_year, semester")
    .eq("user_id", targetUserId)
    .eq("college_id", actor.collegeId)
    .maybeSingle();
  if (!student) return null;

  const [feesRes, allocationRes, gatePassRes] = await Promise.all([
    supabase.from("fees").select("amount, paid_amount, status, due_date").eq("student_id", student.id),
    supabase.from("hostel_allocations").select("id").eq("student_id", student.id).eq("status", "active").maybeSingle(),
    supabase.from("gate_passes").select("id").eq("student_id", student.id).in("status", ["pending", "approved", "active"]).maybeSingle(),
  ]);

  const outstandingFees = (feesRes.data || [])
    .filter((f) => !["paid", "waived", "refunded"].includes(computeEffectiveFeeStatus(f)))
    .reduce((sum, f) => sum + (f.amount - f.paid_amount), 0);

  return {
    studentId: student.id,
    status: student.status as StudentAcademicStatus,
    enrollmentNumber: student.enrollment_number,
    batchYear: student.batch_year,
    semester: student.semester,
    outstandingFees,
    hasActiveHostelAllocation: !!allocationRes.data,
    hasOpenGatePass: !!gatePassRes.data,
  };
}

const UpdateStudentAcademicStatusSchema = z.object({
  targetUserId: z.string().guid(),
  status: z.enum(STUDENT_ACADEMIC_STATUSES),
});

/**
 * The write path students.status has never had — see lib/student-lifecycle.ts
 * for why only 'graduated' also touches profiles.status.
 */
export async function updateStudentAcademicStatusCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  targetUserIdRaw: string,
  statusRaw: StudentAcademicStatus
) {
  const { targetUserId, status } = UpdateStudentAcademicStatusSchema.parse({ targetUserId: targetUserIdRaw, status: statusRaw });
  await checkRateLimit(`updateStudentAcademicStatus:${actor.userId}`, 20, 60);

  const { data: student } = await supabase
    .from("students")
    .select("id, status")
    .eq("user_id", targetUserId)
    .eq("college_id", actor.collegeId)
    .single();
  if (!student) {
    throw new Error("Student record not found.");
  }
  if (student.status === status) {
    throw new Error(`This student is already ${status}.`);
  }

  const { error } = await supabase.from("students").update({ status }).eq("id", student.id);
  if (error) {
    throw dbError(error);
  }

  const mappedProfileStatus = resolveProfileStatusForAcademicTransition(status);
  if (mappedProfileStatus) {
    await supabase.from("profiles").update({ status: mappedProfileStatus }).eq("id", targetUserId).eq("college_id", actor.collegeId);
    // Changes profiles.status, which middleware's active-account check
    // reads (cached) — same cache-bust updateUserStatusCore does above.
    await invalidateCache(middlewareProfileCacheKey(targetUserId));
  }

  await logAudit(supabase, actor, "student_academic_status_changed", "students", student.id, {
    oldValue: { status: student.status },
    newValue: { status, profile_status: mappedProfileStatus },
  });
}

export async function updateStudentAcademicStatus(
  targetUserId: string,
  status: StudentAcademicStatus,
  viewQuery?: DataTableQuery
) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();
  await updateStudentAcademicStatusCore(supabase, actor, targetUserId, status);
  revalidatePath("/admin/users");
  if (viewQuery) {
    const sortColumn = viewQuery.sortKey && USERS_SORT_COLUMNS.has(viewQuery.sortKey) ? viewQuery.sortKey : "created_at";
    await invalidateCache(usersCacheKey(actor.collegeId, viewQuery, sortColumn));
  }
}
