import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeRedirectPath } from "@/lib/auth/safe-redirect";
import type { EmailOtpType } from "@supabase/supabase-js";

/**
 * Confirms email-based auth links (invite, recovery, etc.) built from
 * `admin.generateLink()`'s `properties.hashed_token` — see lib/invitations.ts.
 *
 * Deliberately not `/auth/callback` (which expects a PKCE `?code=` from
 * Supabase's own hosted `/verify` redirect): an admin-generated link is
 * opened by a browser that never initiated the original request, so there's
 * no code_verifier for that flow to complete. verifyOtp() sidesteps that —
 * it validates the token_hash directly and sets the session cookie itself,
 * over a plain GET.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  // Only a path on this site (lib/auth/safe-redirect.ts); anything else goes
  // to "/", which the proxy sends on to the user's own dashboard.
  const next = safeRedirectPath(searchParams.get("next") ?? "/", "auth-link") ?? "/";

  if (token_hash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });

    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
