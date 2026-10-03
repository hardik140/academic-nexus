import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * College lifecycle and session admission, for the server paths
 * (middleware, requireRole, requireRoleFromRequest, the mobile session
 * route). Migrations 053/054 enforce all of it in the database; what this
 * adds is the REASON, so a blocked user gets the maintenance page or the
 * device-limit page instead of an empty screen or a generic error.
 *
 * Every caller fails CLOSED on an unexpected error. The one exception is a
 * database that does not have the functions yet (the code is deployed
 * before migrations 053/054 are applied): then there is no lifecycle or
 * session feature to enforce, and the request proceeds exactly as it did
 * before this feature existed.
 */

export type SessionClient = "web" | "mobile" | "mobile-legacy";

export type AdmissionState =
  | "active"
  | "rejected"
  | "revoked"
  | "college_unavailable"
  | "inactive"
  | "no_session_claim";

export interface Admission {
  state: AdmissionState;
  /** Present when the college is unavailable. */
  college_state?: "MAINTENANCE" | "SUSPENDED";
  /** Present when a session was revoked. */
  reason?: string;
  active_sessions?: number;
  max_sessions?: number | null;
  /** Present with no_session_claim. */
  enforcement?: "register" | "enforce";
}

/** The function does not exist: migrations 053/054 are not applied yet. */
export class AccessFeatureUnavailable extends Error {
  constructor() {
    super("College lifecycle and session registry are not installed in this database.");
    this.name = "AccessFeatureUnavailable";
  }
}

interface RpcError {
  code?: string;
  message?: string;
}

/** PostgREST's "function not found in the schema cache", or PostgreSQL's undefined_function. */
export function isMissingFunction(error: RpcError | null | undefined): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

// types/database.ts declares Functions as Record<string, never> (see
// lib/gate-security/rpc.ts); this is the same narrow escape hatch.
function rpc(supabase: SupabaseClient<Database>) {
  return supabase.rpc as unknown as (
    name: string,
    params?: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export interface DeviceInfo {
  client: SessionClient;
  deviceId?: string | null;
  deviceLabel?: string | null;
  userAgent?: string | null;
}

/**
 * Registers (or re-checks) the caller's current session. Throws
 * AccessFeatureUnavailable when the database predates 054, and an Error for
 * anything else — the caller decides how to fail closed.
 */
export async function registerSession(supabase: SupabaseClient<Database>, device: DeviceInfo): Promise<Admission> {
  const { data, error } = await rpc(supabase)("register_current_session", {
    p_client: device.client,
    p_device_id: device.deviceId ?? null,
    p_device_label: device.deviceLabel ?? null,
    p_user_agent: device.userAgent ? device.userAgent.slice(0, 400) : null,
  });
  if (isMissingFunction(error)) throw new AccessFeatureUnavailable();
  if (error) throw new Error(`session admission failed (${error.code ?? "unknown"})`);
  return data as Admission;
}

/**
 * What a request may do, given its admission. `true` for an admitted
 * session — and for a token with no session claim while enforcement is still
 * 'register' (the cut-over). Everything else is refused.
 */
export function admissionAllows(admission: Admission): boolean {
  if (admission.state === "active") return true;
  if (admission.state === "no_session_claim") return admission.enforcement === "register";
  return false;
}

/** Why a refused request was refused, as one of the /unavailable reasons. */
export type UnavailableReason = "maintenance" | "suspended" | "session_limit" | "session_revoked" | "inactive" | "error";

export function unavailableReason(admission: Admission): UnavailableReason {
  switch (admission.state) {
    case "college_unavailable":
      return admission.college_state === "MAINTENANCE" ? "maintenance" : "suspended";
    case "rejected":
      return "session_limit";
    case "revoked":
    case "no_session_claim":
      return "session_revoked";
    case "inactive":
      return "inactive";
    default:
      return "error";
  }
}

/** The caller's own access state (053/054 my_access_state), for the status page. */
export interface AccessState {
  profile_status: string;
  role: string;
  college_id: string;
  college_name: string;
  college_state: "ACTIVE" | "MAINTENANCE" | "SUSPENDED";
  message: string | null;
  expected_resume_at: string | null;
  session_state: "active" | "rejected" | "revoked" | "unregistered" | "no_claim";
  revoked_reason: string | null;
  enforcement: "register" | "enforce";
  active_sessions: number;
  max_sessions: number | null;
  allowed: boolean;
}

export async function readAccessState(supabase: SupabaseClient<Database>): Promise<AccessState | null> {
  const { data, error } = await rpc(supabase)("my_access_state");
  if (isMissingFunction(error)) throw new AccessFeatureUnavailable();
  if (error) throw new Error(`access state unavailable (${error.code ?? "unknown"})`);
  return (data as AccessState | null) ?? null;
}

export interface OwnSession {
  session_id: string;
  client: SessionClient;
  device_label: string | null;
  user_agent: string | null;
  status: "active" | "rejected" | "revoked";
  created_at: string;
  last_seen_at: string;
  is_current: boolean;
}

export async function listOwnSessions(supabase: SupabaseClient<Database>): Promise<OwnSession[]> {
  const { data, error } = await rpc(supabase)("list_my_sessions");
  if (error) throw new Error(`sessions unavailable (${error.code ?? "unknown"})`);
  return (data as OwnSession[] | null) ?? [];
}

const SAFE_PREFIXES = ["session: ", "college lifecycle: "];

/**
 * Migrations 053/054 write their deliberate refusals with these prefixes,
 * for the person who triggered them ("only a super admin may…", "a reason of
 * 10 to 1000 characters is required"). Anything else is internal and is
 * replaced — the same rule as lib/gate-security/rpc.ts.
 */
export function accessRpcMessage(error: RpcError, fallback: string): string {
  const raw = String(error.message ?? "");
  const prefix = SAFE_PREFIXES.find((p) => raw.startsWith(p));
  if (prefix) {
    const text = raw.slice(prefix.length).trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : ".") : fallback;
  }
  console.error("[college-access] rpc failed", { code: error.code });
  return fallback;
}

export async function callAccessRpc<T>(
  supabase: SupabaseClient<Database>,
  fn: string,
  args: Record<string, unknown>,
  fallback: string
): Promise<T> {
  const { data, error } = await rpc(supabase)(fn, args);
  if (error) throw new Error(accessRpcMessage(error, fallback));
  return data as T;
}

/**
 * A short, human label for a device list ("Chrome on Windows"), from the
 * User-Agent. A label only — never used to identify or count a device.
 */
export function deviceLabelFromUserAgent(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /OPR\/|Opera/.test(ua) ? "Opera" :
    /Firefox\//.test(ua) ? "Firefox" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Safari\//.test(ua) ? "Safari" :
    /okhttp|Expo|ReactNative/i.test(ua) ? "Mobile app" :
    "Browser";
  const os =
    /Windows/.test(ua) ? "Windows" :
    /iPhone|iPad|iOS/.test(ua) ? "iOS" :
    /Android/.test(ua) ? "Android" :
    /Mac OS X|Macintosh/.test(ua) ? "macOS" :
    /Linux/.test(ua) ? "Linux" :
    null;
  return os ? `${browser} on ${os}` : browser;
}

/**
 * The colleges a background job must skip (migration 053, owner decision Q8):
 * those in MAINTENANCE or SUSPENDED. College-specific jobs that would
 * perform normal college operations are lifecycle-blocked; platform-wide
 * jobs and security-required ones (credential expiry) do not call this.
 *
 * Throws on any failure other than "the column does not exist yet" (code
 * deployed before migration 053), so a job that cannot tell which colleges
 * are blocked stops instead of processing them.
 */
export async function unavailableCollegeIds(supabase: SupabaseClient<Database>): Promise<Set<string>> {
  const { data, error } = await supabase.from("colleges").select("id").neq("lifecycle_state", "ACTIVE");
  if (error) {
    if (error.code === "42703") return new Set();
    throw new Error(`college lifecycle could not be read (${error.code ?? "unknown"})`);
  }
  return new Set((data ?? []).map((c) => c.id));
}
