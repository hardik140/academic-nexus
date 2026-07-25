import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Auth callback route.
 * Supabase redirects here after Google OAuth or Magic Link confirmation.
 * Exchanges the auth code for a session, then redirects to the portal.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // Check if user has a profile — if not, create one
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        const { data: existingProfile } = await supabase
          .from("profiles")
          .select("id")
          .eq("id", user.id)
          .single();

        if (!existingProfile) {
          // First-time login: create a profile with default 'student' role
          await supabase.from("profiles").insert({
            id: user.id,
            college_id: "00000000-0000-0000-0000-000000000001", // Default demo college
            full_name:
              user.user_metadata?.full_name ||
              user.email?.split("@")[0] ||
              "New User",
            email: user.email || "",
            avatar_url: user.user_metadata?.avatar_url || null,
            role: "student",
            status: "active",
          });
        }
      }

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Auth error — redirect to login with error
  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
