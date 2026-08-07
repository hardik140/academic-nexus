"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type LeaveType = Database["public"]["Tables"]["leave_requests"]["Row"]["leave_type"];

export interface ApplyForLeaveParams {
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  reason: string;
}

/**
 * Shared by the web Server Action below and app/api/mobile/leave/apply's
 * Route Handler — same guarded logic either way, just a different transport.
 */
export async function applyForLeaveCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: ApplyForLeaveParams
) {
  const { error } = await supabase.from("leave_requests").insert({
    college_id: actor.collegeId,
    requested_by: actor.userId,
    leave_type: params.leaveType,
    start_date: params.startDate,
    end_date: params.endDate,
    reason: params.reason,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function applyForLeave(params: ApplyForLeaveParams) {
  const actor = await requireRole(["teacher", "admin"]);
  const supabase = await createClient();
  await applyForLeaveCore(supabase, actor, params);
  revalidatePath("/teacher/leave");
}

/** Called by app/api/mobile/leave/apply/route.ts. */
export async function applyForLeaveViaRequest(request: Request, params: ApplyForLeaveParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["teacher", "admin"]);
  await applyForLeaveCore(supabase, actor, params);
}
