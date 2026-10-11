import { supabase } from "@/lib/supabase";
import { apiPost } from "@/lib/api";

/**
 * The session registry, from the app (migration 054). The app registers its
 * session at sign-in and whenever it starts with a stored session; the
 * server decides whether the session is admitted.
 */

export interface DeviceSession {
  session_id: string;
  client: string;
  device_label: string | null;
  status: string;
  created_at: string;
  last_seen_at: string;
  is_current: boolean;
}

export type Admission =
  | { state: "active" }
  | { state: "rejected"; maxSessions: number | null; sessions: DeviceSession[] }
  | { state: "revoked" }
  | { state: "inactive" }
  | { state: "college_unavailable"; collegeState: "MAINTENANCE" | "SUSPENDED"; collegeName: string | null; message: string | null; expectedResumeAt: string | null }
  | { state: "unavailable" };

/** Registers this session. Never throws: an unreachable server is "unavailable", and the app shows a retry. */
export async function registerSession(): Promise<Admission> {
  try {
    return await apiPost<Admission>("/api/mobile/session", {});
  } catch {
    return { state: "unavailable" };
  }
}

export function revokeSession(sessionId: string): Promise<{ ok: true }> {
  return apiPost<{ ok: true }>("/api/mobile/session/revoke", { sessionId });
}

/**
 * Signs out. supabase-js signOut() ends every GoTrue session of the user
 * (global scope), so the registry is told to end the same set first. The
 * sign-out happens even if that call fails.
 */
export async function signOutEverywhere(): Promise<void> {
  try {
    await apiPost("/api/mobile/session/end", { scope: "global" });
  } catch {
    // Recorded server-side when it can be; never blocks signing out.
  }
  await supabase.auth.signOut();
}
