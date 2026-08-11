"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const ActOnLeaveRequestSchema = z.object({
  requestId: z.string().guid(),
  action: z.enum(["approved", "rejected"]),
});

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
