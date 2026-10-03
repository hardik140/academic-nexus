import { createClient } from "@/lib/supabase/server";
import { createMobileClient, bearerTokenFrom } from "@/lib/supabase/mobile";
import type { UserRole } from "@/types/database";
import {
  AccessFeatureUnavailable,
  admissionAllows,
  registerSession,
  type DeviceInfo,
} from "@/lib/college-access";

export type RbacErrorCode =
  | "UNAUTHENTICATED"
  | "INACTIVE"
  | "FORBIDDEN"
  // Migrations 053/054: the college is in MAINTENANCE or SUSPENDED, this
  // session was revoked, or the account is at its device limit.
  | "COLLEGE_UNAVAILABLE"
  | "SESSION_REVOKED"
  | "SESSION_LIMIT"
  // The admission check itself could not run: fail closed.
  | "ACCESS_CHECK_FAILED";

export class RbacError extends Error {
  constructor(
    public code: RbacErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RbacError";
  }
}

export interface AuthorizedActor {
  userId: string;
  role: UserRole;
  collegeId: string;
}

/**
 * The college lifecycle and session registry, for a request that has
 * already passed the role check. The database enforces the same rules
 * (migrations 053/054); this turns its answer into a specific error so the
 * caller can say WHY, and fails closed when the check cannot run. A
 * database without the 054 functions (code deployed ahead of the
 * migration) has no such feature to enforce, so the request proceeds.
 */
export async function assertAdmission(
  supabase: Parameters<typeof registerSession>[0],
  device: DeviceInfo
): Promise<void> {
  let admission;
  try {
    admission = await registerSession(supabase, device);
  } catch (err) {
    if (err instanceof AccessFeatureUnavailable) return;
    throw new RbacError("ACCESS_CHECK_FAILED", "Your access could not be verified. Please try again.");
  }
  if (admissionAllows(admission)) return;
  switch (admission.state) {
    case "college_unavailable":
      throw new RbacError(
        "COLLEGE_UNAVAILABLE",
        admission.college_state === "MAINTENANCE"
          ? "Your college is under maintenance. Please try again later."
          : "Your college's access is currently suspended."
      );
    case "rejected":
      throw new RbacError(
        "SESSION_LIMIT",
        "You have reached the maximum number of active devices. Sign out of another device, then try again."
      );
    case "inactive":
      throw new RbacError("INACTIVE", "Account is not active.");
    default:
      throw new RbacError("SESSION_REVOKED", "This session has ended. Please sign in again.");
  }
}

/**
 * Server-only authorization guard for Server Actions and route handlers.
 *
 * Re-derives the caller's role/college from their session (via
 * `auth.getUser()`, which re-validates the JWT against Supabase Auth —
 * never from anything the client passed in) and throws if the session is
 * missing, the account isn't active, or the role isn't in `allowedRoles`.
 *
 * This is a second, independent check on top of RLS (defense-in-depth),
 * not a replacement for it — the write that follows still goes through
 * RLS-enforced Supabase calls.
 */
export async function requireRole(
  allowedRoles: readonly UserRole[]
): Promise<AuthorizedActor> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new RbacError("UNAUTHENTICATED", "No authenticated session.");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, college_id, status")
    .eq("id", user.id)
    .single();

  if (!profile) {
    throw new RbacError("UNAUTHENTICATED", "No profile for session.");
  }

  if (profile.status !== "active") {
    throw new RbacError("INACTIVE", `Account status is '${profile.status}'.`);
  }

  if (!allowedRoles.includes(profile.role as UserRole)) {
    throw new RbacError(
      "FORBIDDEN",
      `Role '${profile.role}' is not permitted to perform this action.`
    );
  }

  // Middleware has normally admitted this session already; this re-check is
  // what keeps a Server Action posted from an already-open page honest.
  await assertAdmission(supabase as Parameters<typeof registerSession>[0], { client: "web" });

  return {
    userId: user.id,
    role: profile.role as UserRole,
    collegeId: profile.college_id,
  };
}

/**
 * Same authorization guard as requireRole(), for app/api/mobile/* Route
 * Handlers — sourced from the RN app's Bearer access token (see
 * lib/supabase/mobile.ts) instead of a cookie-based session. Identical
 * checks (active status, role membership); only where the session comes
 * from differs. Returns the authenticated Supabase client alongside the
 * actor so the caller doesn't need to reconstruct it.
 */
export async function requireRoleFromRequest(
  request: Request,
  allowedRoles: readonly UserRole[]
): Promise<AuthorizedActor & { supabase: ReturnType<typeof createMobileClient> }> {
  const token = bearerTokenFrom(request);
  if (!token) {
    throw new RbacError("UNAUTHENTICATED", "No Authorization header.");
  }

  const supabase = createMobileClient(token);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new RbacError("UNAUTHENTICATED", "Invalid or expired session.");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, college_id, status")
    .eq("id", user.id)
    .single();

  if (!profile) {
    throw new RbacError("UNAUTHENTICATED", "No profile for session.");
  }

  if (profile.status !== "active") {
    throw new RbacError("INACTIVE", `Account status is '${profile.status}'.`);
  }

  if (!allowedRoles.includes(profile.role as UserRole)) {
    throw new RbacError(
      "FORBIDDEN",
      `Role '${profile.role}' is not permitted to perform this action.`
    );
  }

  // The mobile API has no middleware in front of it, so this is where a
  // mobile session is admitted. The updated app identifies itself; an
  // installed build that predates registration is recorded as
  // 'mobile-legacy', which is the evidence the enforce switch waits on.
  const header = (name: string) => request.headers.get(name);
  await assertAdmission(supabase as Parameters<typeof registerSession>[0], {
    client: header("x-nexus-client") === "mobile-app" ? "mobile" : "mobile-legacy",
    deviceId: header("x-nexus-device-id"),
    deviceLabel: header("x-nexus-device-label"),
    userAgent: header("user-agent"),
  });

  return {
    userId: user.id,
    role: profile.role as UserRole,
    collegeId: profile.college_id,
    supabase,
  };
}

/**
 * AUTHENTICATION ONLY, for the mobile session self-service routes
 * (app/api/mobile/session/*). They must work for a session the device limit
 * REJECTED — that is how a user at the limit signs out another device — so
 * they cannot use requireRoleFromRequest(), which refuses such a session.
 * Authorization is the database's: register_current_session(),
 * revoke_session() and end_my_sessions() act only on the caller's own
 * sessions (migration 054). Never use this for anything else.
 */
export async function authenticateRequest(
  request: Request
): Promise<{ userId: string; supabase: ReturnType<typeof createMobileClient> }> {
  const token = bearerTokenFrom(request);
  if (!token) {
    throw new RbacError("UNAUTHENTICATED", "No Authorization header.");
  }
  const supabase = createMobileClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new RbacError("UNAUTHENTICATED", "Invalid or expired session.");
  }
  return { userId: user.id, supabase };
}
