"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export interface ApplyForGatePassParams {
  destination: string;
  reason: string;
  exitTime: string;
  returnTime: string;
}

/**
 * Shared by the web Server Action below and app/api/mobile/gatepass/apply's
 * Route Handler — same guarded logic either way, just a different transport
 * (Server Action RPC for web, HTTP for the RN app).
 */
export async function applyForGatePassCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: ApplyForGatePassParams
) {
  await checkRateLimit(`applyForGatePass:${actor.userId}`, 5, 60);

  const { data: student } = await supabase
    .from("students")
    .select("id")
    .eq("user_id", actor.userId)
    .single();

  if (!student) {
    throw new Error("No student record found for this account.");
  }

  const { error } = await supabase.from("gate_passes").insert({
    college_id: actor.collegeId,
    student_id: student.id,
    destination: params.destination,
    reason: params.reason,
    exit_time: params.exitTime,
    return_time: params.returnTime,
    status: "pending",
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function applyForGatePass(params: ApplyForGatePassParams) {
  const actor = await requireRole(["student"]);
  const supabase = await createClient();
  await applyForGatePassCore(supabase, actor, params);
  revalidatePath("/student/gatepass");
}

/** Called by app/api/mobile/gatepass/apply/route.ts. */
export async function applyForGatePassViaRequest(request: Request, params: ApplyForGatePassParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["student"]);
  await applyForGatePassCore(supabase, actor, params);
}
