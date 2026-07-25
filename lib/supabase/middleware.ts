import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Role-to-route prefix mapping.
 * Each role can only access pages under its prefix.
 * Admin can access everything.
 */
const ROLE_ROUTES: Record<string, string> = {
  student: "/student",
  teacher: "/teacher",
  hod: "/hod",
  finance: "/finance",
  director: "/director",
  admin: "/admin",
};

/** Routes that don't require authentication */
const PUBLIC_ROUTES = ["/login", "/auth/callback", "/auth/confirm"];

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh the session — IMPORTANT: don't remove this
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  // Allow public routes
  if (PUBLIC_ROUTES.some((route) => pathname.startsWith(route))) {
    return supabaseResponse;
  }

  // Redirect to login if not authenticated
  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Fetch user profile for role-based routing
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, college_id, status")
    .eq("id", user.id)
    .single();

  // If no profile exists yet (first login), redirect to onboarding
  if (!profile) {
    // For now, allow access — profile will be created on first login
    return supabaseResponse;
  }

  // Check if account is active
  if (profile.status !== "active") {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("error", "account_suspended");
    return NextResponse.redirect(url);
  }

  // Root path → redirect to role dashboard
  if (pathname === "/") {
    const url = request.nextUrl.clone();
    const rolePrefix = ROLE_ROUTES[profile.role] || "/student";
    url.pathname = `${rolePrefix}/dashboard`;
    return NextResponse.redirect(url);
  }

  // Admin can access everything
  if (profile.role === "admin") {
    return supabaseResponse;
  }

  // Enforce role-based route access
  const allowedPrefix = ROLE_ROUTES[profile.role];
  if (allowedPrefix && !pathname.startsWith(allowedPrefix)) {
    const url = request.nextUrl.clone();
    url.pathname = `${allowedPrefix}/dashboard`;
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
