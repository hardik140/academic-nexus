import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeRedirectPath } from "@/lib/auth/safe-redirect";

/**
 * Auth callback route.
 * Supabase redirects here after Google OAuth or invitation-link
 * confirmation. Exchanges the auth code for a session, then redirects to
 * the portal (or, for a fresh invite, to /auth/accept-invite via `next`).
 *
 * There is no auto-provision-a-profile fallback here anymore: every account
 * now originates from an invitation, and handle_new_user() (see migration
 * 018) already created the profiles row — with the right role/college and
 * status='pending' — synchronously when the invite was sent. An
 * authenticated user with no profile row should not be a reachable state.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Only a path on this site (lib/auth/safe-redirect.ts); anything else goes
  // to "/", which the proxy sends on to the user's own dashboard.
  const next = safeRedirectPath(searchParams.get("next") ?? "/", "auth-link") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
