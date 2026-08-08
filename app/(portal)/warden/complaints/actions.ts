"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const UpdateComplaintStatusSchema = z.object({
  complaintId: z.string().uuid(),
  status: z.enum(["in_progress", "resolved"]),
});

/**
 * Shared by the web Server Action below and app/api/mobile/complaints/status's
 * Route Handler — same guarded logic either way, just a different transport.
 */
export async function updateComplaintStatusCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  complaintId: string,
  status: "in_progress" | "resolved"
) {
  ({ complaintId, status } = UpdateComplaintStatusSchema.parse({ complaintId, status }));
  await checkRateLimit(`updateComplaintStatus:${actor.userId}`, 30, 60);

  const { error } = await supabase
    .from("complaints")
    .update({
      status,
      resolved_at: status === "resolved" ? new Date().toISOString() : null,
    })
    .eq("id", complaintId)
    .eq("college_id", actor.collegeId);

  if (error) {
    throw new Error(error.message);
  }
}

export async function updateComplaintStatus(
  complaintId: string,
  status: "in_progress" | "resolved"
) {
  const actor = await requireRole(["warden", "admin"]);
  const supabase = await createClient();
  await updateComplaintStatusCore(supabase, actor, complaintId, status);
  revalidatePath("/warden/complaints");
}

/** Called by app/api/mobile/complaints/status/route.ts. */
export async function updateComplaintStatusViaRequest(
  request: Request,
  complaintId: string,
  status: "in_progress" | "resolved"
) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["warden", "admin"]);
  await updateComplaintStatusCore(supabase, actor, complaintId, status);
}
