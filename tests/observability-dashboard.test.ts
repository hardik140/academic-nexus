import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  IssueFilters,
  sentryQuery,
  monitoringConfig,
  listIssues,
  getIssue,
  MonitoringNotConfiguredError,
  MonitoringUnavailableError,
  isSentryLink,
} from "@/lib/observability/sentry-api";

/**
 * The Super Admin System Health page and the Sentry reader behind it
 * (OBSERVABILITY.md). No network: Sentry's API is a mocked fetch.
 */

const h = vi.hoisted(() => ({
  requireRole: vi.fn(async (_roles: string[]) => ({ userId: "u", role: "super_admin", collegeId: "p" })),
  list: null as null | (() => Promise<unknown>),
}));
vi.mock("@/lib/rbac", () => ({ requireRole: h.requireRole }));
vi.mock("@/lib/observability/sentry-api", async (orig) => {
  const real = await orig<typeof import("@/lib/observability/sentry-api")>();
  return { ...real, listIssues: (...a: Parameters<typeof real.listIssues>) => (h.list ? h.list() : real.listIssues(...a)) };
});

const ENV = { SENTRY_ORG: "nexus", SENTRY_PROJECT: "web", SENTRY_READ_TOKEN: "sntrys_secret_token" };
const issue = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  shortId: `WEB-${id}`,
  title: `TypeError: boom ${id}`,
  culprit: "app/(portal)/finance",
  level: "error",
  status: "unresolved",
  count: "12",
  userCount: 3,
  firstSeen: "2026-10-01T10:00:00Z",
  lastSeen: "2026-10-12T05:00:00Z",
  permalink: `https://nexus.sentry.io/issues/${id}/`,
  project: { slug: "web" },
  ...extra,
});
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }, ...init });

beforeEach(() => {
  h.list = null;
  h.requireRole.mockClear();
});

describe("configuration and filters", () => {
  it("names exactly what is missing; a default API host; trailing slashes trimmed", () => {
    expect(() => monitoringConfig({})).toThrow(MonitoringNotConfiguredError);
    try {
      monitoringConfig({ SENTRY_ORG: "x" });
    } catch (e) {
      expect((e as MonitoringNotConfiguredError).missing).toEqual(["SENTRY_PROJECT", "SENTRY_READ_TOKEN"]);
    }
    expect(monitoringConfig(ENV).base).toBe("https://sentry.io");
    expect(monitoringConfig({ ...ENV, SENTRY_API_URL: "https://de.sentry.io/" }).base).toBe("https://de.sentry.io");
  });

  it("allowlists every filter; free text cannot add its own search terms", () => {
    const f = IssueFilters.parse({ status: "bogus", level: "error", period: "1y", environment: "prod;drop", release: "abc123", search: "is:resolved level:fatal TypeError" });
    expect(f).toEqual({ status: "unresolved", level: "error", period: "24h", environment: undefined, release: "abc123", search: "is resolved level fatal TypeError" });
    expect(sentryQuery(f)).toBe("is:unresolved level:error release:abc123 is resolved level fatal TypeError");
    expect(sentryQuery(IssueFilters.parse({}))).toBe("is:unresolved");
  });
});

describe("listIssues", () => {
  it("calls the project's issues endpoint with the read token, and reports Sentry's total", async () => {
    const fetch = vi.fn(async () => json([issue("1"), issue("2")], { headers: { "X-Hits": "137" } }));
    const r = await listIssues(IssueFilters.parse({ level: "fatal", period: "7d" }), { fetch: fetch as never, env: ENV });
    expect(r.total).toBe(137);
    expect(r.issues.map((i) => i.id)).toEqual(["1", "2"]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://sentry.io/api/0/projects/nexus/web/issues/");
    expect(Object.fromEntries(u.searchParams)).toEqual({ query: "is:unresolved level:fatal", statsPeriod: "7d", limit: "50", sort: "date" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sntrys_secret_token");
  });

  it.each([
    ["a refused token", async () => new Response("{}", { status: 401 }), "refused"],
    ["a server error", async () => new Response("{}", { status: 502 }), "unreachable"],
    ["no network", async () => { throw new TypeError("fetch failed"); }, "unreachable"],
    ["an unexpected body", async () => json([{ nope: true }]), "bad-response"],
    ["an object instead of a list", async () => json({ detail: "x" }), "bad-response"],
    ["a non-numeric issue id", async () => json([issue("../../x")]), "bad-response"],
    ["not JSON", async () => new Response("<html>", { status: 200 }), "bad-response"],
    ["a non-https permalink", async () => json([issue("1", { permalink: "javascript:alert(1)" })]), "bad-response"],
    ["a permalink on another host", async () => json([issue("1", { permalink: "https://evil.example/issues/1/" })]), "bad-response"],
    ["a permalink on a look-alike host", async () => json([issue("1", { permalink: "https://sentry.io.evil.example/issues/1/" })]), "bad-response"],
    ["a rate limit", async () => new Response("{}", { status: 429 }), "rate-limited"],
    ["a redirect (never followed with the token)", async () => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }), "unreachable"],
  ])("%s → MonitoringUnavailableError(%s), never an empty list, never the token", async (_, f, reason) => {
    const err = await listIssues(IssueFilters.parse({}), { fetch: f as never, env: ENV }).catch((e) => e);
    expect(err).toBeInstanceOf(MonitoringUnavailableError);
    expect(err.reason).toBe(reason);
    expect(err.message).not.toContain("sntrys");
  });

  it("never lets fetch follow a redirect", async () => {
    const fetch = vi.fn(async () => json([]));
    await listIssues(IssueFilters.parse({}), { fetch: fetch as never, env: ENV });
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe("manual");
  });
});

describe("hostile filter input", () => {
  it.each([
    ["encoded operators", { search: "%3Ais%3Aresolved !level:fatal project:other" }],
    ["quotes and boolean syntax", { search: '"x" OR (project:other) AND environment:prod' }],
    ["an extremely long string", { search: "a".repeat(100_000) }],
    ["arrays and objects", { search: ["a", "b"], status: { $ne: 1 }, period: 999 }],
  ])("%s cannot add a search term or exceed the bound", (_, raw) => {
    const f = IssueFilters.parse(raw);
    const q = sentryQuery(f);
    // The only key:value terms are the ones the page builds itself.
    expect(q.match(/\w+:\S+/g)).toEqual(["is:unresolved"]);
    expect((f.search ?? "").length).toBeLessThanOrEqual(80);
  });
});

describe("isSentryLink and the API origin", () => {
  it.each([
    ["https://nexus.sentry.io/issues/1/", "https://sentry.io", true],
    ["https://sentry.io/organizations/nexus/issues/1/", "https://sentry.io", true],
    ["https://nexus.sentry.io/issues/1/", "https://de.sentry.io", true],
    ["https://sentry.acme.test/organizations/x/issues/1/", "https://sentry.acme.test", true],
    ["http://nexus.sentry.io/issues/1/", "https://sentry.io", false],
    ["https://evil.example/issues/1/", "https://sentry.io", false],
    ["https://sentry.io.evil.example/", "https://sentry.io", false],
    ["https://evilsentry.io/", "https://sentry.io", false],
    ["https://user:pw@nexus.sentry.io/", "https://sentry.io", false],
    ["https://evil.example/", "https://sentry.acme.test", false],
    ["javascript:alert(1)", "https://sentry.io", false],
    ["not a url", "https://sentry.io", false],
  ])("%s on %s → %s", (link, base, ok) => expect(isSentryLink(link, base)).toBe(ok));

  it.each(["http://sentry.io", "https://sentry.io/api?x=1", "https://u@sentry.io", "file:///etc"])("refuses SENTRY_API_URL=%s (the token only goes to an https origin)", (url) => {
    expect(() => monitoringConfig({ ...ENV, SENTRY_API_URL: url })).toThrow(MonitoringNotConfiguredError);
  });
});

describe("getIssue", () => {
  const latest = {
    eventID: "abc",
    dateCreated: "2026-10-12T05:00:00Z",
    tags: [
      { key: "environment", value: "production" },
      { key: "release", value: "c5a3dcf82e22" },
      { key: "server_name", value: "internal-host-7" },
    ],
    entries: [
      { type: "breadcrumbs", data: { values: [] } },
      {
        type: "exception",
        data: { values: [{ type: "TypeError", value: "x is undefined", stacktrace: { frames: [{ filename: "outer.js", function: "main", lineNo: 1 }, { filename: "inner.js", function: "load", lineNo: 42 }] } }] },
      },
    ],
  };

  it("returns the issue, its exception innermost-first, and only the allowlisted tags", async () => {
    const fetch = vi.fn(async (url: string) => json(url.endsWith("/latest/") ? latest : issue("77")));
    const d = await getIssue("77", { fetch: fetch as never, env: ENV });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://sentry.io/api/0/organizations/nexus/issues/77/",
      "https://sentry.io/api/0/organizations/nexus/issues/77/events/latest/",
    ]);
    expect(d.exception).toEqual([{ type: "TypeError", value: "x is undefined", frames: [{ filename: "inner.js", function: "load", line: 42 }, { filename: "outer.js", function: "main", line: 1 }] }]);
    expect(d.tags).toEqual({ environment: "production", release: "c5a3dcf82e22" });
  });

  it("an issue of another project in the same org is 'not found'; a non-numeric id never reaches Sentry", async () => {
    const fetch = vi.fn(async () => json(issue("77", { project: { slug: "other" } })));
    await expect(getIssue("77", { fetch: fetch as never, env: ENV })).rejects.toMatchObject({ reason: "not-found" });
    const none = vi.fn();
    await expect(getIssue("../../projects", { fetch: none as never, env: ENV })).rejects.toMatchObject({ reason: "not-found" });
    expect(none).not.toHaveBeenCalled();
  });
});

describe("System Health page", () => {
  async function render(searchParams: Record<string, string> = {}) {
    const { default: Page } = await import("@/app/(portal)/super-admin/system-health/page");
    return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(searchParams) }));
  }

  it("is Super Admin only: the role check runs first, and a refusal renders nothing", async () => {
    h.requireRole.mockRejectedValueOnce(Object.assign(new Error("Role 'admin' is not permitted"), { code: "FORBIDDEN" }));
    h.list = vi.fn();
    await expect(render()).rejects.toThrow(/not permitted/);
    expect(h.requireRole).toHaveBeenCalledWith(["super_admin"]);
    expect(h.list).not.toHaveBeenCalled();
  });

  it("not configured: says so, and never claims there are no issues", async () => {
    h.list = async () => {
      throw new MonitoringNotConfiguredError(["SENTRY_READ_TOKEN"]);
    };
    const html = await render();
    expect(html).toContain("Monitoring is not configured");
    expect(html).toContain("SENTRY_READ_TOKEN");
    expect(html).not.toContain("No matching issues");
  });

  it("unreachable: says so, and never claims there are no issues", async () => {
    h.list = async () => {
      throw new MonitoringUnavailableError("refused");
    };
    const html = await render();
    expect(html).toContain("Crash data is unavailable");
    expect(html).not.toContain("No matching issues");
  });

  it("rate-limited: says so, and never claims there are no issues", async () => {
    h.list = async () => {
      throw new MonitoringUnavailableError("rate-limited");
    };
    const html = await render();
    expect(html).toContain("Sentry is limiting requests");
    expect(html).not.toContain("No matching issues");
  });

  it("connected with nothing matching: an honest empty state", async () => {
    h.list = async () => ({ issues: [], total: 0 });
    const html = await render({ status: "resolved" });
    expect(html).toContain("Connected to Sentry");
    expect(html).toContain("No matching issues");
  });

  it("connected: lists issues with counts and links, and says when the list is a first page", async () => {
    h.list = async () => ({ issues: Array.from({ length: 50 }, (_, i) => issue(String(i + 1))), total: 120 });
    const html = await render();
    expect(html).toContain("120 matching issues — showing the 50 most recently seen");
    expect(html).toContain('href="/super-admin/system-health/1"');
    expect(html).toContain("TypeError: boom 1");
  });
});

describe("Issue detail page", () => {
  async function render(issueId: string, env: Record<string, string> | null, fetch?: (url: string) => Promise<Response>) {
    vi.unstubAllEnvs();
    for (const k of ["SENTRY_ORG", "SENTRY_PROJECT", "SENTRY_READ_TOKEN"]) vi.stubEnv(k, env?.[k] ?? "");
    if (fetch) vi.stubGlobal("fetch", vi.fn(fetch));
    const { default: Page } = await import("@/app/(portal)/super-admin/system-health/[issueId]/page");
    try {
      return renderToStaticMarkup(await Page({ params: Promise.resolve({ issueId }) }));
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  }
  const latest = { eventID: "e", tags: [], entries: [{ type: "exception", data: { values: [{ type: "Error", value: "<img src=x onerror=alert(1)>", stacktrace: { frames: [] } }] } }] };

  it("is Super Admin only", async () => {
    h.requireRole.mockRejectedValueOnce(Object.assign(new Error("not permitted"), { code: "FORBIDDEN" }));
    await expect(render("1", ENV)).rejects.toThrow(/not permitted/);
    expect(h.requireRole).toHaveBeenCalledWith(["super_admin"]);
  });

  it("not configured and unavailable are states, not crashes", async () => {
    expect(await render("1", null)).toContain("Monitoring is not configured");
    expect(await render("1", ENV, async () => new Response("{}", { status: 401 }))).toContain("Crash data is unavailable");
  });

  it("renders Sentry's text as text (no HTML injection), links to Sentry, and never the token", async () => {
    const html = await render("7", ENV, async (url) => json(url.endsWith("/latest/") ? latest : issue("7", { title: "<script>alert(1)</script>" })));
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('href="https://nexus.sentry.io/issues/7/"');
    expect(html).not.toContain(ENV.SENTRY_READ_TOKEN);
  });
});
