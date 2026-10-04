import { createClient } from "@/lib/supabase/client";
import { classifyError, feedbackMessage } from "@/lib/feedback-error";

/**
 * What a failed action tells the user, for the browser (M6.4 / M6.5).
 *
 * A failure is either an expired session — shown with "Sign in again" — or
 * anything else, shown with feedbackMessage()'s safe text.
 *
 * Detecting an expired session uses explicit signals only, in this order:
 *
 *   1. the error's own code (classifyError): UNAUTHENTICATED, PGRST301,
 *      PGRST303 — present on client-side Supabase errors and on
 *      SessionExpiredError;
 *   2. otherwise, asking Supabase Auth directly whether a user is still
 *      signed in. This is the fallback for Server Actions: they throw, and
 *      until typed ActionResult codes exist (owner decision D11) the reason
 *      never reaches the browser. It relies on supabase-js's typed error
 *      names, never on message text, and when it cannot tell — the auth
 *      request itself failed — it does not claim the session ended.
 */

export interface FeedbackError {
  message: string;
  /** The session has ended: offer "Sign in again". */
  session: boolean;
}

export const SESSION_EXPIRED_MESSAGE = "Your session has expired. Please sign in again.";
const NETWORK_MESSAGE = "Couldn't reach the server. Check your internet connection, then try again.";
export const COLLEGE_UNAVAILABLE_MESSAGE = "Your college is currently unavailable. Reload the page for details.";

/**
 * "ended": signed in to Supabase Auth, but this session was revoked or not
 * admitted (migration 054). "college_unavailable": the college is in
 * MAINTENANCE or SUSPENDED (053).
 */
export type SessionState = "present" | "missing" | "unknown" | "ended" | "college_unavailable";

/**
 * When a signed-in user's action fails, the database can say whether the
 * application itself is closed to them. Any failure to ask is "no answer",
 * never a block.
 */
async function accessBlock(client: ReturnType<typeof createClient>): Promise<SessionState | null> {
  try {
    const rpc = client.rpc.bind(client) as unknown as (name: string) => PromiseLike<{ data: unknown; error: unknown }>;
    const { data, error } = await rpc("my_access_state");
    const state = data as { allowed?: boolean; profile_status?: string; role?: string; college_state?: string } | null;
    if (error || !state || state.allowed !== false) return null;
    if (state.profile_status === "active" && state.role !== "super_admin" && state.college_state && state.college_state !== "ACTIVE") {
      return "college_unavailable";
    }
    return "ended";
  } catch {
    return null;
  }
}

/** Asks Supabase Auth whether a user is still signed in — and, if so, whether the application admits them. */
export async function currentSessionState(): Promise<SessionState> {
  try {
    const client = createClient();
    const { data, error } = await client.auth.getUser();
    if (data.user) return (await accessBlock(client)) ?? "present";
    if (!error) return "missing";
    // Could not ask (offline, auth service down): no conclusion either way.
    if (error.name === "AuthRetryableFetchError" || error.status === undefined || error.status === 0 || error.status >= 500) {
      return "unknown";
    }
    return "missing";
  } catch {
    return "unknown";
  }
}

export async function toFeedbackError(
  error: unknown,
  fallback: string,
  sessionState: () => Promise<SessionState> = currentSessionState
): Promise<FeedbackError> {
  const { kind } = classifyError(error);
  if (kind === "session") return { message: SESSION_EXPIRED_MESSAGE, session: true };
  if (kind === "network") return { message: NETWORK_MESSAGE, session: false };
  const state = await sessionState();
  if (state === "missing" || state === "ended") return { message: SESSION_EXPIRED_MESSAGE, session: true };
  if (state === "college_unavailable") return { message: COLLEGE_UNAVAILABLE_MESSAGE, session: false };
  return { message: feedbackMessage(error, fallback), session: false };
}
