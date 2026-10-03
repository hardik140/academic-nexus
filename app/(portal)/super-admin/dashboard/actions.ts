"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { callAccessRpc } from "@/lib/college-access";

/**
 * The session-registry cut-over (migration 054), for super_admin.
 *
 * 'register' (initial): sessions are registered on every server path;
 * revoked and rejected sessions are refused; a session the server has never
 * seen is tolerated so installed mobile builds keep working.
 * 'enforce': a session absent from the registry is refused too.
 *
 * Both functions are super_admin-only inside the database as well; the mode
 * change is audited there with its reason.
 */

export interface EnforcementReadiness {
  mode: "register" | "enforce";
  active_sessions: number;
  active_web: number;
  active_mobile: number;
  active_mobile_legacy: number;
  mobile_registered_total: number;
  legacy_seen_last_7_days: number;
  legacy_last_seen_at: string | null;
  ready: boolean;
}

export async function getSessionEnforcement(): Promise<EnforcementReadiness> {
  await requireRole(["super_admin"]);
  const supabase = await createClient();
  return callAccessRpc<EnforcementReadiness>(supabase, "session_enforcement_readiness", {}, "Session enforcement status couldn't be loaded.");
}

const ModeSchema = z.object({
  mode: z.enum(["register", "enforce"]),
  reason: z.string().trim().min(10, { message: "Give a reason of at least 10 characters." }).max(1000),
});

export async function setSessionEnforcement(mode: "register" | "enforce", reason: string): Promise<void> {
  const actor = await requireRole(["super_admin"]);
  const parsed = ModeSchema.parse({ mode, reason });
  await checkRateLimit(`sessionEnforcement:${actor.userId}`, 5, 60);
  const supabase = await createClient();
  await callAccessRpc(supabase, "set_session_enforcement", { p_mode: parsed.mode, p_reason: parsed.reason }, "Session enforcement couldn't be changed.");
}
