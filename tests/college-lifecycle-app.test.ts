import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The application half of college lifecycle and the session registry
 * (migrations 053/054): middleware, the shared access module, the three
 * lifecycle-blocked background jobs, the mobile session routes and the
 * browser's failure adapter. The database half — which is what actually
 * refuses a blocked session — is proven in tests/staging-college-lifecycle,
 * tests/staging-mutations-lifecycle and tests/realpg-session-registry.
 */

const h = vi.hoisted(() => {
  /** A Supabase query builder that records what it was asked and answers from `resolve`. */
  function builder(resolve: (table: string, ops: Array<[string, unknown[]]>) => { data?: unknown; error?: unknown; count?: number }) {
    return (table: string) => {
      const ops: Array<[string, unknown[]]> = [];
      const chain: Record<string, unknown> = {};
      const terminal = () => Promise.resolve({ data: null, error: null, ...resolve(table, ops) });
      for (const m of ["select", "eq", "neq", "in", "or", "is", "order", "limit", "range", "ilike", "gte", "lte"]) {
        chain[m] = (...args: unknown[]) => {
          ops.push([m, args]);
          return chain;
        };
      }
      for (const m of ["insert", "update", "upsert", "delete"]) {
        chain[m] = (...args: unknown[]) => {
          ops.push([m, args]);
          h.writes.push({ table, op: m, args });
          return chain;
        };
      }
      chain.single = () => terminal();
      chain.maybeSingle = () => terminal();
      chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => terminal().then(onFulfilled, onRejected);
      return chain;
    };
  }
  return {
    builder,
    writes: [] as Array<{ table: string; op: string; args: unknown[] }>,
    createServerClient: vi.fn(),
    adminClient: null as unknown,
    runOperation: vi.fn(),
    mobileClient: null as unknown,
  };
});

vi.mock("@supabase/ssr", () => ({ createServerClient: (...args: unknown[]) => h.createServerClient(...args) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => undefined),
  RateLimitError: class RateLimitError extends Error {},
  RateLimiterUnavailableError: class RateLimiterUnavailableError extends Error {},
}));
vi.mock("@/lib/cache", () => ({
  getCached: vi.fn(async (_key: string, _ttl: number, fetcher: () => Promise<unknown>) => fetcher()),
  middlewareProfileCacheKey: (id: string) => `profile:${id}`,
  invalidateCache: vi.fn(),
  invalidateCacheFamily: vi.fn(),
  versionedKey: (key: string | null) => key,
  MIDDLEWARE_PROFILE_CACHE: {},
}));
vi.mock("@upstash/qstash/nextjs", () => ({ verifySignatureAppRouter: (handler: () => unknown) => handler }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.adminClient }));
vi.mock("@/lib/finance/pipeline", () => ({ runOperation: (...args: unknown[]) => h.runOperation(...args) }));
vi.mock("@/lib/supabase/mobile", () => ({
  createMobileClient: () => h.mobileClient,
  bearerTokenFrom: (request: Request) => request.headers.get("authorization")?.slice("Bearer ".length) ?? null,
}));


const { updateSession, DEVICE_COOKIE } = await import("@/lib/supabase/middleware");
const access = await import("@/lib/college-access");
const { toFeedbackError, COLLEGE_UNAVAILABLE_MESSAGE, SESSION_EXPIRED_MESSAGE } = await import("@/lib/action-failure");

const COLLEGE_A = "00000001-0000-4000-8000-000000000001";
const COLLEGE_B = "00000001-0000-4000-8000-000000000002";

beforeEach(() => {
  h.writes.length = 0;
  h.createServerClient.mockReset();
  h.runOperation.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

// ─────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────
describe("middleware admission", () => {
  const rpc = vi.fn();
  function signedIn(profile = { role: "student", college_id: COLLEGE_A, status: "active" }) {
    h.createServerClient.mockReturnValue({
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: profile }) }) }) }),
      rpc,
    });
  }
  const request = (path: string, cookie?: string) =>
    new NextRequest(new URL(path, "http://127.0.0.1:3100"), {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0", ...(cookie ? { cookie } : {}) },
    });
  const redirectTarget = (response: Response) => {
    const location = response.headers.get("location");
    return location ? new URL(location).pathname + new URL(location).search : null;
  };

  beforeEach(() => {
    rpc.mockReset();
    signedIn();
  });

  it("lets an admitted session through, and labels the browser for the device list", async () => {
    rpc.mockResolvedValue({ data: { state: "active" }, error: null });
    const response = await updateSession(request("/student/dashboard"));
    expect(redirectTarget(response)).toBeNull();
    expect(rpc).toHaveBeenCalledWith("register_current_session", expect.objectContaining({ p_client: "web", p_device_label: "Chrome on Windows" }));
    expect(response.cookies.get(DEVICE_COOKIE)?.value).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps an existing device cookie and passes it only as a label", async () => {
    rpc.mockResolvedValue({ data: { state: "active" }, error: null });
    const response = await updateSession(request("/student/dashboard", `${DEVICE_COOKIE}=forged-device`));
    expect(rpc).toHaveBeenCalledWith("register_current_session", expect.objectContaining({ p_device_id: "forged-device" }));
    expect(response.cookies.get(DEVICE_COOKIE)).toBeUndefined();
  });

  it.each([
    [{ state: "college_unavailable", college_state: "MAINTENANCE" }, "/unavailable?reason=maintenance"],
    [{ state: "college_unavailable", college_state: "SUSPENDED" }, "/unavailable?reason=suspended"],
    [{ state: "rejected", active_sessions: 1, max_sessions: 1 }, "/unavailable?reason=session_limit"],
    [{ state: "revoked", reason: "college_suspended" }, "/unavailable?reason=session_revoked"],
    [{ state: "no_session_claim", enforcement: "enforce" }, "/unavailable?reason=session_revoked"],
  ])("sends %o to %s — direct URLs included", async (admission, target) => {
    rpc.mockResolvedValue({ data: admission, error: null });
    for (const path of ["/student/dashboard", "/student/fees", "/admin/users", "/"]) {
      expect(redirectTarget(await updateSession(request(path))), path).toBe(target);
    }
  });

  it("fails CLOSED when the admission check errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "statement timeout" } });
    expect(redirectTarget(await updateSession(request("/student/dashboard")))).toBe("/unavailable?reason=error");
  });

  it("proceeds when the database predates migration 054", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    expect(redirectTarget(await updateSession(request("/student/dashboard")))).toBeNull();
  });

  it("serves /unavailable itself without an admission check (it is where refused sessions go)", async () => {
    await updateSession(request("/unavailable?reason=maintenance"));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("checks account status before admission: a suspended account keeps its existing redirect", async () => {
    signedIn({ role: "student", college_id: COLLEGE_A, status: "suspended" });
    expect(redirectTarget(await updateSession(request("/student/dashboard")))).toBe("/login?error=account_suspended");
    expect(rpc).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// The shared access module
// ─────────────────────────────────────────────────────────────
describe("lib/college-access", () => {
  it("maps every admission to allow or a reason", () => {
    expect(access.admissionAllows({ state: "active" })).toBe(true);
    expect(access.admissionAllows({ state: "no_session_claim", enforcement: "register" })).toBe(true);
    for (const state of ["rejected", "revoked", "college_unavailable", "inactive"] as const) {
      expect(access.admissionAllows({ state }), state).toBe(false);
    }
    expect(access.admissionAllows({ state: "no_session_claim", enforcement: "enforce" })).toBe(false);
    expect(access.unavailableReason({ state: "college_unavailable", college_state: "MAINTENANCE" })).toBe("maintenance");
    expect(access.unavailableReason({ state: "college_unavailable", college_state: "SUSPENDED" })).toBe("suspended");
    expect(access.unavailableReason({ state: "rejected" })).toBe("session_limit");
    expect(access.unavailableReason({ state: "revoked" })).toBe("session_revoked");
    expect(access.unavailableReason({ state: "inactive" })).toBe("inactive");
  });

  it("passes the database's deliberate refusals through and hides anything internal", () => {
    expect(access.accessRpcMessage({ message: "college lifecycle: only a super admin may change a college's lifecycle state" }, "Failed."))
      .toBe("Only a super admin may change a college's lifecycle state.");
    expect(access.accessRpcMessage({ message: "session: no such session" }, "Failed.")).toBe("No such session.");
    expect(access.accessRpcMessage({ message: 'relation "user_sessions" does not exist', code: "42P01" }, "Failed.")).toBe("Failed.");
  });

  it("labels a device from its User-Agent, and never needs one", () => {
    expect(access.deviceLabelFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Version/17.0 Safari/605.1.15")).toBe("Safari on macOS");
    expect(access.deviceLabelFromUserAgent("Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Mobile")).toBe("Chrome on Android");
    expect(access.deviceLabelFromUserAgent(null)).toBe("Browser");
  });

  it("lists the colleges a job must skip; tolerates only a database without the column", async () => {
    const client = (result: { data?: unknown; error?: unknown }) =>
      ({ from: h.builder(() => result) }) as unknown as Parameters<typeof access.unavailableCollegeIds>[0];
    expect(await access.unavailableCollegeIds(client({ data: [{ id: COLLEGE_B }] }))).toEqual(new Set([COLLEGE_B]));
    expect(await access.unavailableCollegeIds(client({ error: { code: "42703", message: "column does not exist" } }))).toEqual(new Set());
    await expect(access.unavailableCollegeIds(client({ error: { code: "57014", message: "timeout" } }))).rejects.toThrow(/could not be read/);
  });
});

// ─────────────────────────────────────────────────────────────
// Background jobs (owner decision Q8)
// ─────────────────────────────────────────────────────────────
describe("background jobs respect the lifecycle", () => {
  const cron = () => new Request("http://127.0.0.1/api/cron", { method: "POST" });
  // The routes refuse every request without QStash keys; the signature check
  // itself is mocked out above. Set before each route module is first loaded.
  beforeEach(() => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "test");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "test");
  });

  it("finance-sync leaves a blocked college's operations queued and runs the rest", async () => {
    h.adminClient = {
      from: h.builder((table, ops) => {
        if (table === "colleges") return { data: ops.some(([m]) => m === "neq") ? [{ id: COLLEGE_B }] : [] };
        if (table === "finance_sync_operations") return { data: [
          { id: "op-a", college_id: COLLEGE_A, status: "QUEUED", next_attempt_at: null },
          { id: "op-b", college_id: COLLEGE_B, status: "QUEUED", next_attempt_at: null },
        ] };
        return { data: [] };
      }),
    };
    h.runOperation.mockResolvedValue({ status: "SYNCED" });
    const { POST } = await import("@/app/api/cron/finance-sync/route");
    const body = await (await POST(cron())).json();
    expect(h.runOperation).toHaveBeenCalledTimes(1);
    expect(h.runOperation.mock.calls[0][1]).toBe("op-a");
    expect(body.counts).toEqual({ SYNCED: 1, SKIPPED_COLLEGE_UNAVAILABLE: 1 });
  });

  it("detect-risk-flags raises nothing for a blocked college and does not auto-resolve its open flags", async () => {
    const dept = (college: string) => ({
      college_id: college, department_id: `dept-${college}`, department_name: "CSE",
      attendance_pct: 50, backlog_rate: null, fee_collection_pct: null, placement_rate: null, total_students: 10,
    });
    h.adminClient = {
      from: h.builder((table, ops) => {
        if (table === "colleges") return { data: [{ id: COLLEGE_B }] };
        if (table === "mv_department_health_raw") return { data: [dept(COLLEGE_A), dept(COLLEGE_B)] };
        if (table === "risk_flags" && ops.some(([m, a]) => m === "eq" && a[0] === "source")) {
          return { data: [{ id: "flag-b", college_id: COLLEGE_B, flag_type: "fee_overdue", department_id: `dept-${COLLEGE_B}` }] };
        }
        return { data: null };
      }),
    };
    const { POST } = await import("@/app/api/cron/detect-risk-flags/route");
    const body = await (await POST(cron())).json();
    const inserts = h.writes.filter((w) => w.table === "risk_flags" && w.op === "insert");
    expect(inserts.map((w) => (w.args[0] as { college_id: string }).college_id)).toEqual([COLLEGE_A]);
    expect(h.writes.filter((w) => w.table === "risk_flags" && w.op === "update")).toEqual([]);
    expect(body).toMatchObject({ created: 1, autoResolved: 0, collegesSkipped: 1 });
  });

  it("snapshot-health-score writes no snapshot for a blocked college", async () => {
    h.adminClient = {
      from: h.builder((table, ops) => {
        if (table === "colleges" && ops.some(([m, a]) => m === "neq" && a[0] === "lifecycle_state")) return { data: [{ id: COLLEGE_B }] };
        if (table === "colleges") return { data: [{ id: COLLEGE_A }, { id: COLLEGE_B }] };
        return { data: [] };
      }),
    };
    const { POST } = await import("@/app/api/cron/snapshot-health-score/route");
    await POST(cron());
    const snapshots = h.writes.filter((w) => w.table === "institution_metric_snapshots");
    expect(snapshots.map((w) => (w.args[0] as { college_id: string }).college_id)).toEqual([COLLEGE_A]);
  });
});

// ─────────────────────────────────────────────────────────────
// Mobile session routes
// ─────────────────────────────────────────────────────────────
describe("app/api/mobile/session", () => {
  const rpc = vi.fn();
  const post = (body: unknown = {}, headers: Record<string, string> = {}) =>
    new Request("http://127.0.0.1/api/mobile/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer good-token", ...headers },
      body: JSON.stringify(body),
    });
  beforeEach(() => {
    rpc.mockReset();
    h.mobileClient = { auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) }, rpc };
  });

  it("returns the user's sessions when the device limit rejects this one", async () => {
    const sessions = [{ session_id: "s1", status: "active", is_current: false }];
    rpc.mockImplementation(async (fn: string) =>
      fn === "register_current_session" ? { data: { state: "rejected", active_sessions: 1, max_sessions: 1 }, error: null } : { data: sessions, error: null });
    const { POST } = await import("@/app/api/mobile/session/route");
    const body = await (await POST(post({}, { "x-nexus-client": "mobile-app" }))).json();
    expect(body).toEqual({ state: "rejected", maxSessions: 1, sessions });
    expect(rpc).toHaveBeenCalledWith("register_current_session", expect.objectContaining({ p_client: "mobile" }));
  });

  it("returns the public outage detail — never the internal reason — when the college is unavailable", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "register_current_session"
        ? { data: { state: "college_unavailable", college_state: "MAINTENANCE" }, error: null }
        : { data: { college_name: "Springfield", message: "Upgrading.", expected_resume_at: "2030-01-01T00:00:00Z", college_state: "MAINTENANCE" }, error: null });
    const { POST } = await import("@/app/api/mobile/session/route");
    expect(await (await POST(post())).json()).toEqual({
      state: "college_unavailable", collegeState: "MAINTENANCE", collegeName: "Springfield",
      message: "Upgrading.", expectedResumeAt: "2030-01-01T00:00:00Z",
    });
  });

  it("refuses an unauthenticated call with 401", async () => {
    h.mobileClient = { auth: { getUser: async () => ({ data: { user: null } }) }, rpc };
    const { POST } = await import("@/app/api/mobile/session/route");
    expect((await POST(post())).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("revoke validates the id and leaves the decision to the database", async () => {
    rpc.mockResolvedValue({ data: { revoked: true }, error: null });
    const { POST } = await import("@/app/api/mobile/session/revoke/route");
    expect((await POST(post({ sessionId: "not-a-uuid" }))).status).toBe(400);
    expect((await POST(post({ sessionId: "5e550000-0000-4000-8000-000000000001" }))).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("revoke_session", { p_session_id: "5e550000-0000-4000-8000-000000000001" });
    rpc.mockResolvedValue({ data: null, error: { message: "session: no such session", code: "42501" } });
    const refused = await POST(post({ sessionId: "5e550000-0000-4000-8000-000000000002" }));
    expect((await refused.json()).error).toBe("No such session.");
  });

  it("end mirrors the scope, global by default", async () => {
    rpc.mockResolvedValue({ data: 1, error: null });
    const { POST } = await import("@/app/api/mobile/session/end/route");
    await POST(post({}));
    expect(rpc).toHaveBeenLastCalledWith("end_my_sessions", { p_scope: "global" });
    await POST(post({ scope: "local" }));
    expect(rpc).toHaveBeenLastCalledWith("end_my_sessions", { p_scope: "local" });
  });
});

// ─────────────────────────────────────────────────────────────
// The browser's failure adapter
// ─────────────────────────────────────────────────────────────
describe("toFeedbackError after a block", () => {
  it("a revoked or unadmitted session is offered 'Sign in again'; an unavailable college is told so", async () => {
    expect(await toFeedbackError(new Error("x"), "Failed.", async () => "ended")).toEqual({ message: SESSION_EXPIRED_MESSAGE, session: true });
    expect(await toFeedbackError(new Error("x"), "Failed.", async () => "college_unavailable")).toEqual({ message: COLLEGE_UNAVAILABLE_MESSAGE, session: false });
  });
});
