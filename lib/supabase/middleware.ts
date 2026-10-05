import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { routePrefixFor, dashboardPathFor } from "@/lib/auth/role-routes";
import { checkRateLimit, RateLimitError, RateLimiterUnavailableError } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { getCached, middlewareProfileCacheKey, MIDDLEWARE_PROFILE_CACHE } from "@/lib/cache";
import { keyDigest } from "@/lib/redis-config";
import type { Database, UserRole, UserStatus } from "@/types/database";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AccessFeatureUnavailable,
  admissionAllows,
  deviceLabelFromUserAgent,
  registerSession,
  unavailableReason,
  type Admission,
  type UnavailableReason,
} from "@/lib/college-access";

/**
 * A random per-browser id, used ONLY to label a session in the device list.
 * It is never counted and never authorizes anything (migration 054 counts
 * GoTrue's session ids), so a forged or cleared value cannot make room.
 */
export const DEVICE_COOKIE = "nx_device";

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
  // The college-unavailable / device-limit page. It is where a refused
  // session is sent, so it cannot itself require admission; it re-reads the
  // session and the access state on its own.
  "/unavailable",
];

export async function updateSession(request: NextRequest) {
  // Development-only component gallery (app/dev/**/page.dev.tsx). Those files
  // are routes only under `next dev` — next.config.ts registers the `dev.tsx`
  // page extension for that phase alone — so in any built deployment there is
  // nothing at /dev/ and this branch is inert (NODE_ENV is "production" in
  // every built bundle). The gallery renders static sample data and reads
  // nothing, so it needs no session; returning before getUser() also means
  // the browser-verification server never contacts Supabase or Redis.
  if (process.env.NODE_ENV === "development" && request.nextUrl.pathname.startsWith("/dev/")) {
    return NextResponse.next({ request });
  }

  // Coarse first line of defense — checked before any Supabase call so a
  // flood doesn't even cost an auth lookup. Keyed on the one header the edge
  // sets and the client cannot choose (lib/client-ip.ts), stored as a digest.
  //
  // Anonymous and credentialed traffic are counted separately. A whole
  // college can sit behind ONE public IP; with a single per-IP bucket,
  // 60 signed-in students opening the app could exhaust it for everyone.
  // So: an anonymous request spends the strict per-IP bucket; a request that
  // carries a session spends a generous per-IP ceiling here and, once the
  // session is verified below, its own per-user bucket. A forged or expired
  // session cookie falls back to the strict anonymous bucket.
  const ipId = keyDigest(clientIp(request.headers).ip);
  const credentialed = carriesCredentials(request);
  const preAuth = await limitedResponse(
    credentialed ? `ipCredentialed:${ipId}` : `ip:${ipId}`,
    credentialed ? CREDENTIALED_IP_LIMIT : ANONYMOUS_IP_LIMIT
  );
  if (preAuth) return preAuth;

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
    process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key",
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

  // Post-auth: a verified session spends its own bucket, never the campus's.
  // A request that claimed a session cookie but has no valid session is
  // anonymous after all. A bearer-token request is not verified here (the
  // mobile /api routes verify it themselves, then apply per-user, per-action
  // buckets), so it keeps only the credentialed ceiling above.
  if (user) {
    const perUser = await limitedResponse(`user:${user.id}`, USER_LIMIT);
    if (perUser) return perUser;
  } else if (hasSessionCookie(request)) {
    const anonymous = await limitedResponse(`ip:${ipId}`, ANONYMOUS_IP_LIMIT);
    if (anonymous) return anonymous;
  }

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
    },
    MIDDLEWARE_PROFILE_CACHE
  );

  // No profile row for an authenticated user. This used to `return
  // supabaseResponse` — "for now, allow access" — which meant that every
  // check below it (active status, role, route prefix) was skipped and the
  // session could load every portal shell in the application.
  //
  // It was never reachable through signup: migration 043's handle_new_user()
  // trigger writes a profile inside the same transaction that creates the
  // auth user, so an account without one does not normally exist. But that
  // makes the branch a fail-OPEN default guarding a condition that only
  // occurs when something has already gone wrong — the trigger was dropped,
  // the row was deleted, the profile read failed. Every one of those is a
  // reason to stop, not a reason to wave the request through.
  if (!profile) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("error", "no_profile");
    return NextResponse.redirect(url);
  }

  // Check if account is active
  if (profile.status !== "active") {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("error", "account_suspended");
    return NextResponse.redirect(url);
  }

  // College lifecycle and session admission (migrations 053/054). Uncached,
  // unlike the profile above: a suspension or a revocation takes effect on
  // the very next request. The database refuses the same sessions on its
  // own; this is what turns the refusal into the right page.
  const userAgent = request.headers.get("user-agent");
  const deviceId = request.cookies.get(DEVICE_COOKIE)?.value ?? crypto.randomUUID();
  let admission: Admission | null = null;
  try {
    admission = await registerSession(supabase as unknown as SupabaseClient<Database>, {
      client: "web",
      deviceId,
      deviceLabel: deviceLabelFromUserAgent(userAgent),
      userAgent,
    });
  } catch (err) {
    // Fail closed — unless the database predates the feature entirely.
    if (!(err instanceof AccessFeatureUnavailable)) return unavailable(request, "error");
  }
  if (admission && !admissionAllows(admission)) {
    return unavailable(request, unavailableReason(admission));
  }
  if (!request.cookies.get(DEVICE_COOKIE)) {
    supabaseResponse.cookies.set(DEVICE_COOKIE, deviceId, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 60 * 60 * 24 * 400,
    });
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

function unavailable(request: NextRequest, reason: UnavailableReason): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = "/unavailable";
  url.search = "";
  url.searchParams.set("reason", reason);
  return NextResponse.redirect(url);
}

/**
 * Middleware rate-limit ceilings, per 60 s. None of these is an
 * authorization boundary (every action has its own per-user bucket below
 * them); they cap floods. All three are fail-open (lib/rate-limit-policy.ts).
 *
 * The values are NOT derived from production traffic — there is none yet —
 * and are recorded as an open item in REDIS_RATE_LIMIT_DESIGN.md.
 * - ANONYMOUS_IP_LIMIT: unchanged from before (100).
 * - CREDENTIALED_IP_LIMIT: sized for a campus behind one NAT address.
 * - USER_LIMIT: one person, including Next.js prefetches and Server Actions.
 */
export const ANONYMOUS_IP_LIMIT = 100;
export const CREDENTIALED_IP_LIMIT = 2000;
export const USER_LIMIT = 300;
const WINDOW_SECONDS = 60;

/** A Supabase session cookie (`sb-<ref>-auth-token`, possibly chunked `.0`, `.1`). */
const SESSION_COOKIE = /^sb-[A-Za-z0-9-]+-auth-token(\.\d+)?$/;

export function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies.getAll().some((c) => SESSION_COOKIE.test(c.name) && c.value !== "");
}

export function carriesCredentials(request: NextRequest): boolean {
  if (hasSessionCookie(request)) return true;
  const auth = request.headers.get("authorization") ?? "";
  return /^Bearer\s+\S+/i.test(auth);
}

/** Null when the request may proceed; otherwise the 429/503 to return. */
async function limitedResponse(key: string, limit: number): Promise<NextResponse | null> {
  try {
    await checkRateLimit(key, limit, WINDOW_SECONDS);
    return null;
  } catch (err) {
    if (err instanceof RateLimitError) {
      return new NextResponse("Too many requests. Please try again shortly.", {
        status: 429,
        headers: { "Retry-After": String(err.retryAfterSeconds) },
      });
    }
    // These buckets are classified fail-open (lib/rate-limit-policy.ts) so
    // this should be unreachable; if the policy ever changes, a limiter
    // outage must not become an unhandled exception on every request.
    if (err instanceof RateLimiterUnavailableError) {
      return new NextResponse("Service temporarily unavailable.", {
        status: 503,
        headers: { "Retry-After": "30" },
      });
    }
    // Anything else is a limiter bug, not a verdict; these are flood
    // ceilings, so the request proceeds (as before this change).
    return null;
  }
}
