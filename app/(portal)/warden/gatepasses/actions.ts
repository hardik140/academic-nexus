"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const ActOnGatePassSchema = z.object({
  passId: z.string().guid(),
  action: z.enum(["approved", "rejected"]),
});

/**
 * Shared by the web Server Action below and app/api/mobile/gatepass/act's
 * Route Handler — same guarded logic either way, just a different transport.
 */
export async function actOnGatePassCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  passId: string,
  action: "approved" | "rejected"
) {
  ({ passId, action } = ActOnGatePassSchema.parse({ passId, action }));
  await checkRateLimit(`actOnGatePass:${actor.userId}`, 30, 60);

  const { error } = await supabase
    .from("gate_passes")
    .update({
      status: action,
      approved_by: actor.userId,
      approved_at: new Date().toISOString(),
    })
    .eq("id", passId)
    .eq("college_id", actor.collegeId);

  if (error) {
    throw new Error(error.message);
  }
}

export async function actOnGatePass(
  passId: string,
  action: "approved" | "rejected"
) {
  const actor = await requireRole(["warden", "admin"]);
  const supabase = await createClient();
  await actOnGatePassCore(supabase, actor, passId, action);
  revalidatePath("/warden/gatepasses");
}

/** Called by app/api/mobile/gatepass/act/route.ts. */
export async function actOnGatePassViaRequest(
  request: Request,
  passId: string,
  action: "approved" | "rejected"
) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["warden", "admin"]);
  await actOnGatePassCore(supabase, actor, passId, action);
}
