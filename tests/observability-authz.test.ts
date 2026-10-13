import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { ALL_ROLES } from "./rbac-matrix";

/**
 * System Health is Super Admin only, at both layers (OBSERVABILITY.md):
 *   1. the proxy (lib/supabase/middleware.ts) keeps every other role out of /super-admin/*;
 *   2. each page's own requireRole(["super_admin"]) — the real lib/rbac — runs
 *      before the Sentry reader, so no other role can make it call Sentry.
 * Supabase is a fake client; Sentry is a stubbed global fetch.
 */

const h = vi.hoisted(() => ({ role: null as string | null }));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => undefined),
  RateLimitError: class RateLimitError extends Error {},
  RateLimiterUnavailableError: class RateLimiterUnavailableError extends Error {},
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }), headers: async () => new Headers() }));
vi.mock("@supabase/ssr", async (original) => ({
  ...(await original<typeof import("@supabase/ssr")>()),
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: h.role ? { id: "00000005-0000-4000-8000-000000000001" } : null } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: h.role ? { role: h.role, college_id: "c1", status: "active" } : null, error: null }) }) }) }),
    // Session admission (054/058): admitted, with the routing facts.
    rpc: async () => ({ data: { state: "active", role: h.role, college_id: "c1", profile_status: "active" }, error: null }),
  }),
}));

const { updateSession } = await import("@/lib/supabase/middleware");
const { default: ListPage } = await import("@/app/(portal)/super-admin/system-health/page");
const { default: IssuePage } = await import("@/app/(portal)/super-admin/system-health/[issueId]/page");

const TOKEN = "sntrys_AUTHZ_TEST_TOKEN_MARKER";
const sentry = vi.fn(async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));

beforeEach(() => {
  sentry.mockClear();
  vi.stubGlobal("fetch", sentry);
  vi.stubEnv("SENTRY_ORG", "nexus");
  vi.stubEnv("SENTRY_PROJECT", "web");
  vi.stubEnv("SENTRY_READ_TOKEN", TOKEN);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const proxy = async (path: string) => {
  const res = await updateSession(new NextRequest(`https://nexus.example${path}`, { headers: { cookie: "nx_device=d1" } }));
  const raw = res.headers.get("location");
  return raw ? new URL(raw).pathname : null;
};

const OTHERS = ALL_ROLES.filter((r) => r !== "super_admin");

describe("proxy: /super-admin/system-health", () => {
  it("an anonymous caller is sent to sign in", async () => {
    h.role = null;
    expect(await proxy("/super-admin/system-health")).toBe("/login");
  });

  it.each(OTHERS.filter((r) => r !== "admin"))("%s is redirected to its own portal", async (role) => {
    h.role = role;
    const to = await proxy("/super-admin/system-health/123");
    expect(to).not.toBeNull();
    expect(to!.startsWith("/super-admin")).toBe(false);
  });

  // Pre-existing proxy rule ("Admin can access everything"): a College Admin
  // reaches the page, so the page's own requireRole is the boundary for admin
  // (proved below). Pinned so a change to either layer is seen.
  it("admin passes the proxy — the page check is what refuses it", async () => {
    h.role = "admin";
    expect(await proxy("/super-admin/system-health")).toBeNull();
  });

  it("super_admin is let through", async () => {
    h.role = "super_admin";
    expect(await proxy("/super-admin/system-health")).toBeNull();
  });
});

describe("page: requireRole runs before any Sentry read", () => {
  it.each([null, ...OTHERS])("role %s: both pages refuse and Sentry is never called", async (role) => {
    h.role = role;
    await expect(ListPage({ searchParams: Promise.resolve({}) })).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHENTICATED" });
    await expect(IssuePage({ params: Promise.resolve({ issueId: "123" }) })).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHENTICATED" });
    expect(sentry).not.toHaveBeenCalled();
  });

  it("super_admin: the page reads Sentry server-side, and the token is not in the HTML", async () => {
    h.role = "super_admin";
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(await ListPage({ searchParams: Promise.resolve({}) }));
    expect(sentry).toHaveBeenCalledTimes(1);
    expect(html).toContain("No matching issues");
    expect(html).not.toContain(TOKEN);
  });
});
