"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

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
    const { data: department } = await supabase.from("departments").select("id").eq("hod_id", actor.userId).single();
    if (!department) {
      return { pending: [], processed: [] };
    }

    const { data: deptStaff } = await supabase
      .from("profiles")
      .select("id")
      .eq("department_id", department.id);
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
    return { pending: pendingRes.data || [], processed: processedRes.data || [] };
  });
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
    const [{ data: department }, { data: requestData }] = await Promise.all([
      supabase.from("departments").select("id").eq("hod_id", actor.userId).single(),
      supabase
        .from("leave_requests")
        .select("requested_by, profiles:requested_by(department_id)")
        .eq("id", requestId)
        .single(),
    ]);

    // Cast to any: this hand-maintained types file doesn't declare table
    // Relationships, so embedded joins like profiles:requested_by(...)
    // can't be inferred — same pattern used throughout the rest of the app.
    const request = requestData as any;
    const requesterDeptId = request?.profiles?.department_id;
    if (!department?.id || requesterDeptId !== department.id) {
      throw new Error("You can only act on leave requests from your own department.");
    }
  }

  const { error } = await supabase
    .from("leave_requests")
    .update({
      status: action,
      approved_by: actor.userId,
      approved_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .eq("college_id", actor.collegeId);

  if (error) {
    throw new Error(error.message);
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
