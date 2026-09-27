/**
 * What kind of failure an error is, for choosing safe user-facing copy
 * (components/ui/error-state.tsx). Pure, so it is unit-tested in Node.
 *
 * It trusts only signals that are reliable, and never matches on an
 * application's error message: in production Next.js replaces a thrown
 * Server Component or Server Action message with a generic one plus a
 * digest, so text matching would behave differently in development and
 * production. (The one message it reads is the browser's own wording for a
 * fetch() that failed at the network.) What is used:
 *
 *   • an explicit `code`: the RBAC codes (lib/rbac.ts), which reach the
 *     client once actions return typed results (owner decision D11), and
 *     PostgREST's JWT codes and Postgres' insufficient_privilege, which a
 *     client-side Supabase read returns in its `error` object;
 *   • the browser reporting itself offline, or fetch() failing at the network;
 *   • `digest`, the identifier Next.js attaches to a server error: shown as a
 *     reference so a report can be matched to the server logs. It is a hash,
 *     never the error's content.
 *
 * Everything else is a generic "load" failure. Owner decision D11 (typed
 * ActionResult codes) makes permission and session failures from Server
 * Actions distinguishable; until then they classify as "load".
 */

export type ErrorKind = "load" | "network" | "forbidden" | "session" | "not-found" | "unknown";

export interface FeedbackFailure {
  kind: ErrorKind;
  /** Next.js's error digest, when there is one. */
  reference?: string;
}

const SESSION_CODES = new Set([
  "UNAUTHENTICATED", // lib/rbac.ts: no session
  "PGRST301", // PostgREST: the JWT could not be decoded or is invalid
  "PGRST303", // PostgREST: JWT claims validation failed (expired, among others)
]);

const FORBIDDEN_CODES = new Set([
  "FORBIDDEN", // lib/rbac.ts: the role may not do this
  "INACTIVE", // lib/rbac.ts: the account is not active
  "42501", // Postgres: insufficient_privilege
]);

// The messages browsers give a fetch() that never reached the server.
const NETWORK_FAILURE = /^(Failed to fetch|NetworkError when attempting to fetch resource\.|Load failed|Network request failed)$/;

function property(error: unknown, name: string): string | undefined {
  if (typeof error !== "object" || error === null || !(name in error)) return undefined;
  const value = (error as Record<string, unknown>)[name];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export function classifyError(error: unknown): FeedbackFailure {
  const code = property(error, "code");
  const reference = property(error, "digest");

  let kind: ErrorKind = "load";
  if (code && SESSION_CODES.has(code)) kind = "session";
  else if (code && FORBIDDEN_CODES.has(code)) kind = "forbidden";
  else if (isOffline() || (error instanceof TypeError && NETWORK_FAILURE.test(error.message))) kind = "network";

  return reference ? { kind, reference } : { kind };
}
