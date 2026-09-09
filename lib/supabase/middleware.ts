import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { routePrefixFor, dashboardPathFor } from "@/lib/auth/role-routes";
import { checkRateLimit, RateLimitError } from "@/lib/rate-limit";
import { getCached, middlewareProfileCacheKey } from "@/lib/cache";
import type { UserRole, UserStatus } from "@/types/database";

/**
 * Routes that don't require authentication. `/api` covers machine-to-machine
 * endpoints (e.g. the QStash-triggered cron route) that have their own
 * independent auth (a signed request), not a browser session cookie — the
 * portal login-redirect/RBAC logic below must never intercept them.
 *
 * `/auth/accept-invite` and `/auth/reset-password` specifically must stay
 * public even though they require an authenticated Supabase session: an
 * invited user lands here with status='pending', which the active-status
 * check below would otherwise bounce back to /login before they ever see
 * the set-password form. Both routes re-check the session themselves.
 */
const PUBLIC_ROUTES = [
  "/login",
  "/auth/callback",
  "/auth/confirm",
  "/auth/accept-invite",
  "/auth/reset-password",
  "/api",
];

export async function updateSession(request: NextRequest) { 
  // Coarse, global first line of defense — checked before any Supabase call
  // so a flood doesn't even cost an auth lookup. Fails open (see
  // lib/rate-limit.ts) if Redis isn't configured or unreachable.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  try {
    await checkRateLimit(`ip:${ip}`, 100, 60);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return new NextResponse("Too many requests. Please try again shortly.", { status: 429 });
    }
  }

  let supabaseResponse = NextResponse.next({ request });
  const pathname = request.nextUrl.pathname;

  // Auth exchange endpoints establish or replace the session themselves.
  // Running getUser() here first can refresh the browser's previous session
  // concurrently with verifyOtp()/exchangeCodeForSession(), causing Supabase
  // to reject a one-time refresh token before the new session is written.
  if (pathname === "/auth/confirm" || pathname === "/auth/callback") {
    return supabaseResponse;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
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

  // Fetch user profile for role-based routing — cached briefly. This is
  // purely a routing decision (which page shell to serve), never the
  // security boundary: every mutating action independently re-checks
  // role/status fresh via requireRole() (lib/rbac.ts), uncached, and RLS is
  // a third, always-live layer under that. A stale read here can, at worst,
  // let an already-authenticated browser keep loading page shells for up to
  // this TTL after a role/status change — it can never grant access to data
  // those other layers wouldn't already allow. This is exactly the "short
  // and documented" propagation window this repo's own AGENTS.md
  // anticipates for role/permission changes (Section 3) — invalidated
  // on every write that changes role/status: admin/users' updateUserProfile
  // /updateUserStatus and accept-invite's pending->active transition.
  const profile = await getCached(
    middlewareProfileCacheKey(user.id),
    20,
    async (): Promise<{ role: UserRole; college_id: string; status: UserStatus } | null> => {
      const { data } = await supabase
        .from("profiles")
        .select("role, college_id, status")
        .eq("id", user.id)
        .single();
      return data;
    }
  );

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
    url.pathname = dashboardPathFor(profile.role);
    return NextResponse.redirect(url);
  }

  // Admin can access everything
  if (profile.role === "admin") {
    return supabaseResponse;
  }

  // Enforce role-based route access.
  //
  // Fails CLOSED. routePrefixFor() returns undefined for any role with no
  // ROLE_ROUTES entry, and this check used to be `if (allowedPrefix && ...)`
  // — so an unrecognised role skipped route enforcement entirely and fell
  // through to `return supabaseResponse`, able to load every portal shell in
  // the app. `parent` is exactly that case: a valid profiles.role since
  // migration 001, given its own RLS policies in migration 009, and absent
  // from ROLE_ROUTES. Server Actions still rejected it and RLS still filtered
  // the data, so it was never a data breach — but the default was backwards,
  // and every future role added to the CHECK constraint inherited it.
  const allowedPrefix = routePrefixFor(profile.role);
  if (!allowedPrefix) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("error", "unknown_role");
    return NextResponse.redirect(url);
  }
  if (!pathname.startsWith(allowedPrefix)) {
    const url = request.nextUrl.clone();
    url.pathname = `${allowedPrefix}/dashboard`;
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
