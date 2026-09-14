"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { dbError } from "@/lib/internal-error";

const AssignWardenSchema = z.object({
  blockId: z.string().guid(),
  wardenUserId: z.string().guid().nullable(),
});

/**
 * Shared by the web Server Action below and
 * app/api/mobile/admin/assign-warden's Route Handler.
 */
export async function assignWardenCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  blockId: string,
  wardenUserId: string | null
) {
  ({ blockId, wardenUserId } = AssignWardenSchema.parse({ blockId, wardenUserId }));
  await checkRateLimit(`assignWarden:${actor.userId}`, 20, 60);

  // Verify the target profile is actually in this college and eligible
  // (warden role) before assigning — never trust the client-picked id
  // blindly, even though it came from a dropdown we populated ourselves.
  if (wardenUserId) {
    const { data: candidate } = await supabase
      .from("profiles")
      .select("id, role, college_id")
      .eq("id", wardenUserId)
      .single();

    if (!candidate || candidate.college_id !== actor.collegeId) {
      throw new Error("Selected staff member not found in your college.");
    }
    if (candidate.role !== "warden") {
      throw new Error("Only staff with the warden role can be assigned to a hostel block.");
    }
  }

  const { error } = await supabase
    .from("hostel_blocks")
    .update({ warden_id: wardenUserId })
    .eq("id", blockId)
    .eq("college_id", actor.collegeId);

  if (error) {
    throw dbError(error);
  }
}

export async function assignWarden(blockId: string, wardenUserId: string | null) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();
  await assignWardenCore(supabase, actor, blockId, wardenUserId);
  revalidatePath("/admin/hostel");
}

/** Called by app/api/mobile/admin/assign-warden/route.ts. */
export async function assignWardenViaRequest(request: Request, blockId: string, wardenUserId: string | null) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["admin"]);
  await assignWardenCore(supabase, actor, blockId, wardenUserId);
}
