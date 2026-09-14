"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { dbError } from "@/lib/internal-error";

type LeaveType = Database["public"]["Tables"]["leave_requests"]["Row"]["leave_type"];

const LEAVE_TYPES = [
  "casual", "sick", "earned", "maternity", "paternity", "study", "sabbatical", "other",
] as const;

const ApplyForLeaveSchema = z.object({
  leaveType: z.enum(LEAVE_TYPES),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  reason: z.string().trim().min(1).max(1000),
});

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
  const { leaveType, startDate, endDate, reason } = ApplyForLeaveSchema.parse(params);
  await checkRateLimit(`applyForLeave:${actor.userId}`, 10, 60);

  const { error } = await supabase.from("leave_requests").insert({
    college_id: actor.collegeId,
    requested_by: actor.userId,
    leave_type: leaveType,
    start_date: startDate,
    end_date: endDate,
    reason,
  });

  if (error) {
    throw dbError(error);
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
