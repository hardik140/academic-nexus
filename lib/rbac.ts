import { createClient } from "@/lib/supabase/server";
import type { UserRole } from "@/types/database";

export type RbacErrorCode = "UNAUTHENTICATED" | "INACTIVE" | "FORBIDDEN";

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
  allowedRoles: UserRole[]
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

  return {
    userId: user.id,
    role: profile.role as UserRole,
    collegeId: profile.college_id,
  };
}
