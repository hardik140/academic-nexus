"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { callAccessRpc, listOwnSessions, type OwnSession } from "@/lib/college-access";

/**
 * The signed-in user's own sessions (migration 054): the "Your devices"
 * dialog and the device-limit page. Authorization is the database's —
 * list_my_sessions() and revoke_session() answer only about the caller, and
 * a session the limit REJECTED may still use them, which is how a user at
 * the limit makes room without an administrator.
 */

const SessionId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Invalid session.");

export async function listMySessions(): Promise<OwnSession[]> {
  const supabase = await createClient();
  return listOwnSessions(supabase);
}

export async function revokeMySession(sessionId: string): Promise<void> {
  const id = SessionId.parse(sessionId);
  const supabase = await createClient();
  await callAccessRpc(supabase, "revoke_session", { p_session_id: id }, "That device couldn't be signed out. Please try again.");
}

/**
 * Before the browser signs out. supabase-js signOut() ends every GoTrue
 * session of the user by default (scope "global"), so the registry ends the
 * same set — otherwise the user's other devices would keep occupying slots.
 * Never blocks the sign-out: if this fails, the browser signs out anyway.
 */
export async function endMySessions(scope: "global" | "local" = "global"): Promise<void> {
  try {
    const supabase = await createClient();
    await callAccessRpc(supabase, "end_my_sessions", { p_scope: scope === "local" ? "local" : "global" }, "Sign-out could not be recorded.");
  } catch {
    // The GoTrue sign-out still happens. The registry row then stays until
    // the user or an administrator revokes it; the failure was logged.
  }
}
