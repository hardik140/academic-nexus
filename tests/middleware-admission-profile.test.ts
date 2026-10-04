import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Redis transformation Phase 2.1: the middleware's routing facts (role,
 * status) come from session admission (migration 058), not from a second
 * read of the profile row through a 20 s Redis cache.
 *
 * What this pins:
 * - with 058, a signed-in request reads NO profile row and touches NO cache;
 * - a role or status change applies on the very next request (the old cache
 *   could serve the previous role for up to 20 s);
 * - a suspended account, a missing profile and an admission refusal still
 *   land where they did before;
 * - before 058 (or 054) is applied, the middleware reads the profile itself,
 *   uncached, once.
 */

const h = vi.hoisted(() => ({
  admission: { data: null as unknown, error: null as null | { code?: string } },
  profile: null as null | { role: string; college_id: string; status: string },
  profileReads: 0,
  rpcCalls: 0,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => undefined),
  RateLimitError: class RateLimitError extends Error {},
  RateLimiterUnavailableError: class RateLimiterUnavailableError extends Error {},
}));
// Any use of the cache from the middleware is a regression: it must not be imported at all.
vi.mock("@/lib/cache", () => {
  throw new Error("the middleware must not use lib/cache");
});
vi.mock("@supabase/ssr", async (original) => ({
  ...(await original<typeof import("@supabase/ssr")>()),
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "00000005-0000-4000-8000-000000000001" } } }) },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => {
            if (table === "profiles") h.profileReads++;
            return { data: h.profile, error: h.profile ? null : { code: "PGRST116" } };
          },
        }),
      }),
    }),
    rpc: async () => {
      h.rpcCalls++;
      return h.admission;
    },
  }),
}));

const { updateSession, profileFromAdmission } = await import("@/lib/supabase/middleware");

const COLLEGE = "0000000c-0000-4000-8000-0000000000c1";
const answer058 = (role: string, extra: Record<string, unknown> = {}, profileStatus = "active") => ({
  data: { state: "active", role, college_id: COLLEGE, profile_status: profileStatus, ...extra },
  error: null,
});
const get = (path: string) => updateSession(new NextRequest(`https://nexus.example${path}`, { headers: { cookie: "nx_device=d1" } }));
const location = (res: Response) => {
  const raw = res.headers.get("location");
  return raw ? new URL(raw).pathname + new URL(raw).search : null;
};

beforeEach(() => {
  h.profile = null;
  h.profileReads = 0;
  h.rpcCalls = 0;
});

describe("with migration 058: routing from admission, no profile read, no cache", () => {
  it("a teacher on a teacher page is let through, with one database call and no profile read", async () => {
    h.admission = answer058("teacher");
    const res = await get("/teacher/dashboard");
    expect(location(res)).toBeNull();
    expect(h.rpcCalls).toBe(1);
    expect(h.profileReads).toBe(0);
  });

  it("a role change applies on the very next request", async () => {
    h.admission = answer058("teacher");
    expect(location(await get("/teacher/dashboard"))).toBeNull();
    h.admission = answer058("hod"); // promoted between two requests
    expect(location(await get("/teacher/dashboard"))).toBe("/hod/dashboard");
    expect(h.profileReads).toBe(0);
  });

  it("a status change applies on the very next request: a suspended account goes to the login page", async () => {
    h.admission = answer058("teacher");
    expect(location(await get("/teacher/dashboard"))).toBeNull();
    h.admission = { data: { state: "inactive", role: "teacher", college_id: COLLEGE, profile_status: "suspended" }, error: null };
    expect(location(await get("/teacher/dashboard"))).toBe("/login?error=account_suspended");
    expect(h.profileReads).toBe(0);
  });

  it("the root path goes to the role's dashboard", async () => {
    h.admission = answer058("finance");
    expect(location(await get("/"))).toBe("/finance/dashboard");
  });

  it("an admin may open any portal path; another role is sent to its own prefix", async () => {
    h.admission = answer058("admin");
    expect(location(await get("/finance/dashboard"))).toBeNull();
    h.admission = answer058("student");
    expect(location(await get("/finance/dashboard"))).toBe("/student/dashboard");
  });

  it("a role with no portal fails closed", async () => {
    h.admission = answer058("parent");
    expect(location(await get("/student/dashboard"))).toBe("/login?error=unknown_role");
  });

  it("an admission refusal still wins over routing (college in maintenance, device limit)", async () => {
    h.admission = { data: { state: "college_unavailable", college_state: "MAINTENANCE", role: "teacher", college_id: COLLEGE, profile_status: "active" }, error: null };
    expect(location(await get("/teacher/dashboard"))).toBe("/unavailable?reason=maintenance");
    h.admission = { data: { state: "rejected", active_sessions: 2, max_sessions: 2, role: "teacher", college_id: COLLEGE, profile_status: "active" }, error: null };
    expect(location(await get("/teacher/dashboard"))).toBe("/unavailable?reason=session_limit");
    expect(h.profileReads).toBe(0);
  });

  it("an admission error fails closed", async () => {
    h.admission = { data: null, error: { code: "57014" } };
    expect(location(await get("/teacher/dashboard"))).toBe("/unavailable?reason=error");
  });
});

describe("no profile row, and databases without 058", () => {
  it("a bare { state: inactive } means no profile: one direct read confirms it, then no_profile", async () => {
    h.admission = { data: { state: "inactive" }, error: null };
    h.profile = null;
    expect(location(await get("/teacher/dashboard"))).toBe("/login?error=no_profile");
    expect(h.profileReads).toBe(1);
  });

  it("before 058: the answer has no role, so the profile is read directly, once, uncached", async () => {
    h.admission = { data: { state: "active" }, error: null };
    h.profile = { role: "hod", college_id: COLLEGE, status: "active" };
    expect(location(await get("/teacher/dashboard"))).toBe("/hod/dashboard");
    expect(location(await get("/teacher/dashboard"))).toBe("/hod/dashboard");
    expect(h.profileReads).toBe(2);
  });

  it("before 054: no admission at all, same direct read", async () => {
    h.admission = { data: null, error: { code: "PGRST202" } };
    h.profile = { role: "student", college_id: COLLEGE, status: "suspended" };
    expect(location(await get("/student/dashboard"))).toBe("/login?error=account_suspended");
    expect(h.profileReads).toBe(1);
  });
});

describe("profileFromAdmission", () => {
  it("reads the 058 fields and nothing else", () => {
    expect(profileFromAdmission({ state: "active", role: "hod", college_id: COLLEGE, profile_status: "active" })).toEqual({
      role: "hod",
      college_id: COLLEGE,
      status: "active",
    });
    expect(profileFromAdmission({ state: "active" })).toBeNull();
    expect(profileFromAdmission({ state: "inactive" })).toBeNull();
    expect(profileFromAdmission(null)).toBeNull();
    // A role without a status is not enough to route on.
    expect(profileFromAdmission({ state: "active", role: "admin" })).toBeNull();
  });
});

describe("every role is routed from admission's answer (Phase 2.6 role matrix)", () => {
  it("each role reaches its own portal and is sent away from another role's", async () => {
    const { ROLE_ROUTES } = await import("@/lib/auth/role-routes");
    const entries = Object.entries(ROLE_ROUTES) as Array<[string, string]>;
    expect(entries.length).toBeGreaterThanOrEqual(8);
    for (const [role, prefix] of entries) {
      h.admission = answer058(role);
      expect(location(await get(`${prefix}/dashboard`)), `${role} on its own portal`).toBeNull();
      const other = entries.find(([, p]) => p !== prefix && !p.startsWith(prefix) && !prefix.startsWith(p))![1];
      const res = location(await get(`${other}/dashboard`));
      if (role === "admin") expect(res, "admin may open any portal").toBeNull();
      else expect(res, `${role} on ${other}`).toBe(`${prefix}/dashboard`);
    }
    expect(h.profileReads).toBe(0);
  });
});
