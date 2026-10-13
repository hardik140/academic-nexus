import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import { scrubText, scrubUrl, scrubEvent, scrubBreadcrumb, isExpectedError, MAX_MESSAGE } from "@/lib/observability/scrub";
import { parseDsn, parseStack, reportServerError } from "@/lib/observability/server-report";
import { RbacError } from "@/lib/rbac";
import { RateLimitError, RateLimiterUnavailableError } from "@/lib/rate-limit";
import { SessionExpiredError } from "@/lib/feedback-error";

/**
 * Crash capture (OBSERVABILITY.md): what leaves the application, what is
 * dropped as expected, and that reporting can never break a request.
 */

const h = vi.hoisted(() => ({ captured: [] as unknown[] }));
vi.mock("@sentry/nextjs", () => ({ captureException: (e: unknown, ctx: unknown) => void h.captured.push([e, ctx]) }));

beforeEach(() => {
  h.captured = [];
  vi.restoreAllMocks();
});

describe("scrubText / scrubUrl", () => {
  it("redacts credentials, emails, record ids and long numbers, and bounds the length", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    const out = scrubText(`token=${jwt} password: hunter2 for asha.k@college.edu student 00000004-0000-4000-8000-000000000001 phone +91 98765 43210`);
    expect(out).not.toMatch(/eyJ|hunter2|asha|college\.edu|00000004|98765/);
    expect(out).toContain("<email>");
    expect(out).toContain("<id>");
    expect(scrubText("x".repeat(MAX_MESSAGE + 50)).length).toBe(MAX_MESSAGE + 1);
    expect(scrubText("Cannot read properties of undefined (reading 'map')")).toBe("Cannot read properties of undefined (reading 'map')");
  });

  it.each([
    ["a query-string token", "GET /cb?access_token=abc123secret&x=1", /abc123secret/],
    ["a JSON password", '{"password":"hunter2","name":"x"}', /hunter2/],
    ["a JSON api key", '{"apiKey": "k-live-998877"}', /998877/],
    ["a Basic header", "Authorization: Basic dXNlcjpwYXNzd29yZA==", /dXNlcjpw/],
    ["a Bearer header", "authorization: Bearer opaque.refresh.value", /opaque\.refresh/],
    ["a session cookie", "Cookie: sb-ref-auth-token=base64-abcdefgh; theme=dark", /base64-abcdefgh/],
    ["a roll number", "no fee record for 21BCS1234", /21BCS1234/],
    ["a payment id", "refund failed for pay_29QQoUBi66xm2f", /29QQoUBi66xm2f/],
    ["a provider key", "init with sk_live_51Habcdefghijklmnop", /51Habcdef/],
    ["an Indian phone", "SMS to 9876543210 failed", /9876543210/],
    ["a card number", "card 4111 1111 1111 1111 declined", /4111 1111/],
  ])("redacts %s", (_, text, leak) => {
    expect(scrubText(text)).not.toMatch(leak);
  });

  it("bounds a hostile megabyte string before the patterns run", () => {
    const start = performance.now();
    const out = scrubText("a1".repeat(500_000));
    expect(performance.now() - start).toBeLessThan(500);
    expect(out.length).toBeLessThanOrEqual(MAX_MESSAGE + 1);
  });

  it("keeps a URL's shape only: no query, no fragment, ids replaced", () => {
    expect(scrubUrl("https://app.test/finance/invoices/00000092-0000-4000-8000-000000000001?search=Asha#row")).toBe("https://app.test/finance/invoices/:id");
    expect(scrubUrl("/student/records/12345?x=1")).toBe("/student/records/:id");
  });
});

describe("isExpectedError: not a crash", () => {
  it.each([
    ["an expired session", new SessionExpiredError()],
    ["a refused role", new RbacError("FORBIDDEN", "no")],
    ["throttling", new RateLimitError()],
    ["invalid input", Object.assign(new Error("bad"), { name: "ZodError" })],
    ["a cancelled request", new DOMException("aborted", "AbortError")],
    ["an expired Supabase JWT", Object.assign(new Error("JWT expired"), { code: "PGRST303" })],
  ])("%s", (_, err) => expect(isExpectedError(err)).toBe(true));

  it.each([
    ["a TypeError", new TypeError("x is undefined")],
    ["the limiter being down", new RateLimiterUnavailableError()],
    ["a database failure", Object.assign(new Error("timeout"), { code: "57014" })],
    // A grant or RLS defect, not a user being refused by the application.
    ["Postgres insufficient_privilege", Object.assign(new Error("permission denied for table fees"), { code: "42501" })],
    ["the admission check failing", new RbacError("ACCESS_CHECK_FAILED", "x")],
    // Classification is by code or class, never by wording.
    ["a server failure worded like a session expiry", new Error("Your session has expired. Please sign in again.")],
    ["a server failure worded like a refusal", new Error("FORBIDDEN: not permitted")],
    ["a server-side fetch failure", new TypeError("fetch failed")],
  ])("%s IS reported", (_, err) => expect(isExpectedError(err)).toBe(false));
});

describe("scrubEvent / scrubBreadcrumb", () => {
  function event(): ErrorEvent {
    return {
      type: undefined,
      user: { id: "u-1", email: "a@b.co", ip_address: "1.2.3.4" },
      extra: { body: { password: "x" } },
      request: { url: "https://app.test/a/b?q=secret", method: "POST", data: { password: "x" }, headers: { authorization: "Bearer y" }, cookies: { sb: "z" }, query_string: "q=secret" },
      message: "failed for a@b.co",
      exception: {
        values: [
          {
            type: "Error",
            value: "student 00000004-0000-4000-8000-000000000001 not found",
            stacktrace: { frames: [{ filename: "app.js", abs_path: "https://app.test/_next/x.js?v=1", vars: { token: "t" }, context_line: "const pw = 'x'", pre_context: ["a"], post_context: ["b"] }] },
          },
        ],
      },
      breadcrumbs: [
        { category: "console", message: "logged a@b.co" },
        { category: "fetch", data: { url: "https://app.test/api/x?id=1", method: "GET", status_code: 500, body: "x" } },
        { category: "navigation", data: { from: "/a?x=1", to: "/finance/invoices/42" } },
      ],
    } as ErrorEvent;
  }

  it("keeps type, redacted message and code locations; drops identity, bodies, headers, cookies, query strings, source context", () => {
    const out = scrubEvent(event(), new TypeError("x"))!;
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/password|Bearer|cookies|secret|a@b\.co|1\.2\.3\.4|const pw|00000004|"vars"/);
    expect(out.user).toBeUndefined();
    expect(out.extra).toBeUndefined();
    expect(out.request).toEqual({ url: "https://app.test/a/b", method: "POST" });
    expect(out.exception!.values![0]).toMatchObject({ type: "Error", value: "student <id> not found" });
    expect(out.exception!.values![0].stacktrace!.frames![0]).toEqual({ filename: "app.js", abs_path: "https://app.test/_next/x.js" });
    expect(out.breadcrumbs).toEqual([
      { category: "fetch", message: undefined, data: { url: "https://app.test/api/x", method: "GET", status_code: 500 } },
      { category: "navigation", message: undefined, data: { from: "/a", to: "/finance/invoices/:id" } },
    ]);
  });

  it("keeps only platform contexts and a parameterised transaction", () => {
    const e = event();
    e.contexts = { browser: { name: "Chrome" }, trace: { trace_id: "t", span_id: "s" }, react: { componentStack: "at FeeRow(asha@college.edu)" }, formState: { form: { password: "x" } } };
    e.transaction = "/finance/invoices/00000092-0000-4000-8000-000000000001";
    const out = scrubEvent(e, new TypeError("x"))!;
    expect(Object.keys(out.contexts!).sort()).toEqual(["browser", "trace"]);
    expect(out.transaction).toBe("/finance/invoices/:id");
  });

  it("drops an expected error entirely", () => {
    expect(scrubEvent(event(), new RbacError("UNAUTHENTICATED", "no session"))).toBeNull();
  });

  it("drops console breadcrumbs", () => {
    expect(scrubBreadcrumb({ category: "console", message: "x" })).toBeNull();
  });
});

describe("reportServerError (instrumentation.ts onRequestError)", () => {
  const req = { path: "/finance/invoices?search=Asha", method: "POST" };
  const ctx = { routePath: "/(portal)/finance/invoices", routeType: "action" };
  const DSN = "https://publickey123@o1.ingest.sentry.io/4501";

  it("parses DSNs, including a path prefix, and refuses malformed ones", () => {
    expect(parseDsn(DSN)).toEqual({ url: "https://o1.ingest.sentry.io/api/4501/envelope/", key: "publickey123" });
    expect(parseDsn("https://k@sentry.example.com/relay/12")).toEqual({ url: "https://sentry.example.com/relay/api/12/envelope/", key: "k" });
    for (const bad of ["", "not a url", "https://o1.ingest.sentry.io/4501", "https://k@host/abc"]) expect(parseDsn(bad)).toBeNull();
  });

  it("parses V8 frames, innermost first, with ids scrubbed from paths and a bounded count", () => {
    const stack = ["Error: boom", "    at load (/app/.next/server/chunks/42.js:10:5)", "    at /app/x/00000004-0000-4000-8000-000000000001/y.js:3:1", "    not a frame"].join("\n");
    expect(parseStack(stack)).toEqual([
      { function: "load", filename: "/app/.next/server/chunks/42.js", lineno: 10, colno: 5 },
      { function: undefined, filename: "/app/x/:id/y.js", lineno: 3, colno: 1 },
    ]);
    expect(parseStack(Array.from({ length: 50 }, (_, i) => `    at f${i} (/a.js:${i + 1}:1)`).join("\n"))).toHaveLength(30);
  });

  it("logs one scrubbed line and posts one scrubbed envelope to Sentry", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const err = Object.assign(new Error("payment for asha@college.edu failed"), { digest: "123456" });
    await reportServerError(err, req, ctx, { fetch: fetch as never, dsn: DSN });

    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0][0] as string);
    expect(line).toEqual({ event: "server.error", name: "Error", message: "payment for <email> failed", route: "/(portal)/finance/invoices", routeType: "action", method: "POST", digest: "123456" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://o1.ingest.sentry.io/api/4501/envelope/");
    expect((init.headers as Record<string, string>)["X-Sentry-Auth"]).toContain("sentry_key=publickey123");
    const [header, item, payload] = String(init.body).split("\n").map((l) => JSON.parse(l));
    expect(item).toEqual({ type: "event" });
    expect(payload.event_id).toBe(header.event_id);
    expect(payload).toMatchObject({ level: "error", transaction: "/(portal)/finance/invoices", request: { url: "/finance/invoices", method: "POST" }, tags: { routeType: "action", digest: "123456" } });
    expect(payload.exception.values[0]).toMatchObject({ type: "Error", value: "payment for <email> failed" });
    expect(String(init.body)).not.toMatch(/asha|search=/);
  });

  it("sends nothing without a DSN, and nothing at all for an expected error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn();
    await reportServerError(new Error("x"), req, ctx, { fetch: fetch as never, dsn: "" });
    expect(fetch).not.toHaveBeenCalled();
    log.mockClear();
    await reportServerError(new RbacError("FORBIDDEN", "no"), req, ctx, { fetch: fetch as never, dsn: DSN });
    expect(fetch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("never throws: a rejected or failed send is one warning, without the event", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(reportServerError(new Error("x"), req, ctx, { fetch: (async () => new Response(null, { status: 429 })) as never, dsn: DSN })).resolves.toBeUndefined();
    await expect(reportServerError(new Error("x"), req, ctx, { fetch: (async () => { throw new DOMException("t", "TimeoutError"); }) as never, dsn: DSN })).resolves.toBeUndefined();
    expect(warn.mock.calls.map((c) => JSON.parse(c[0] as string))).toEqual([
      { event: "observability.send", outcome: "rejected", status: 429 },
      { event: "observability.send", outcome: "failed", reason: "TimeoutError" },
    ]);
  });

  it("never throws for a hostile error, and never follows a redirect", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hostile = { get code() { throw new Error("getter"); }, toString() { throw new Error("toString"); } };
    await expect(reportServerError(hostile, req, ctx, { fetch: vi.fn() as never, dsn: DSN })).resolves.toBeUndefined();
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toEqual({ event: "observability.send", outcome: "failed", reason: "unreportable" });

    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }));
    await reportServerError(new Error("x"), req, ctx, { fetch: fetch as never, dsn: DSN });
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe("manual");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a cyclic, nested error is reported by type and scrubbed message only — never its properties or cause", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const err = Object.assign(new Error("boom"), { payload: { student: { email: "asha@college.edu" } }, cause: new Error("password=hunter2") });
    (err.payload as Record<string, unknown>).self = err;
    await reportServerError(err, req, ctx, { fetch: fetch as never, dsn: DSN });
    const sent = String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body) + String(log.mock.calls[0][0]);
    expect(sent).not.toMatch(/asha|hunter2|payload/);
  });
});

describe("reportBoundaryError", () => {
  it("reports a client-side render error once, tagged with its boundary", async () => {
    const { reportBoundaryError } = await import("@/lib/observability/boundary");
    const err = new TypeError("x");
    reportBoundaryError(err, "portal");
    expect(h.captured).toEqual([[err, { tags: { boundary: "portal" } }]]);
  });

  it("does not report a server error again (it has a digest; onRequestError reported it)", async () => {
    const { reportBoundaryError } = await import("@/lib/observability/boundary");
    reportBoundaryError(Object.assign(new Error("x"), { digest: "abc" }), "global");
    expect(h.captured).toEqual([]);
  });
});
