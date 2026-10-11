import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPlainPath, safeRedirectPath, type RedirectPolicy } from "@/lib/auth/safe-redirect";

// Security fix: /auth/callback and /auth/confirm redirected to
// `${origin}${next}` unchecked, so a crafted `next` could leave the site.
// The helper's rules, then the two routes end to end with Supabase mocked.

const POLICIES: RedirectPolicy[] = ["after-sign-in", "auth-link"];

// ─── The helper ──────────────────────────────────────────────────────────

describe("safeRedirectPath: never leaves the site", () => {
  it.each([
    // The forms found in the audit, and their relatives.
    ".evil.example",
    "@evil.example",
    "https://example.com",
    "http://example.com/student/fees",
    "//example.com",
    "//example.com/student/fees",
    "\\\\example.com",
    "\\example.com",
    "/\\example.com",
    "/\\/example.com",
    "\\/example.com",
    "javascript:alert(1)",
    "data:text/html,hi",
    "example.com",
    "student/fees",
    "",
    " /student/fees",
    "/student/fees ",
    "/\t/example.com",
    "/\n/example.com",
    "/student\u0000/fees",
    "/%",
    "/%E0%A4%A",
    "/" + "a".repeat(2048),
  ])("rejects %j", (value) => {
    for (const policy of POLICIES) expect(safeRedirectPath(value, policy), policy).toBeNull();
  });

  it.each([null, undefined, 42, {}, ["/student/fees"]])("rejects a non-string (%j)", (value) => {
    for (const policy of POLICIES) expect(safeRedirectPath(value, policy)).toBeNull();
  });
});

describe("isPlainPath: the first check, on its own", () => {
  // Most of these would also be caught by the origin check in
  // safeRedirectPath. Testing this layer directly means loosening it fails a
  // test, instead of silently leaving one layer of protection.
  it.each([
    "//example.com",
    "//",
    "/\\example.com",
    "/student\\fees",
    "\\\\example.com",
    "/student fees",
    "/student\tfees",
    "/student\u0000fees",
    "/student\u007ffees",
    ".evil.example",
    "@evil.example",
    "https://example.com",
    "",
    "/" + "a".repeat(2048),
  ])("rejects %j", (value) => {
    expect(isPlainPath(value)).toBe(false);
  });

  it.each(["/", "/student/fees", "/director/decisions/5f0c?tab=pending#top", "/%2F%2Fexample.com"])("accepts %j", (value) => {
    expect(isPlainPath(value)).toBe(true);
  });
});

describe("safeRedirectPath: keeps internal destinations", () => {
  it.each([
    ["/student/fees", "/student/fees"],
    ["/teacher/attendance", "/teacher/attendance"],
    ["/", "/"],
    ["/director/decisions/5f0c?tab=pending#top", "/director/decisions/5f0c?tab=pending#top"],
    ["/student/../teacher/attendance", "/teacher/attendance"],
    ["/%2F%2Fexample.com", "/%2F%2Fexample.com"],
    ["/loginx", "/loginx"],
  ])("accepts %j as %j", (value, expected) => {
    for (const policy of POLICIES) expect(safeRedirectPath(value, policy), policy).toBe(expected);
  });
});

describe("safeRedirectPath: reserved areas", () => {
  it.each([
    "/login",
    "/login?error=auth_failed",
    "/LOGIN",
    "/api/cron",
    "/%61pi/cron",
    "/api%2Fcron",
    "/student/../api/cron",
    "/auth/callback",
    "/auth/confirm",
    "/auth",
  ])("never redirects into %j", (value) => {
    for (const policy of POLICIES) expect(safeRedirectPath(value, policy), policy).toBeNull();
  });

  it.each(["/auth/reset-password", "/auth/accept-invite"])("an auth link may land on %s, the step it exists for", (value) => {
    expect(safeRedirectPath(value, "auth-link")).toBe(value);
  });

  it.each(["/auth/reset-password", "/auth/accept-invite"])("after sign-in, %s is not a destination", (value) => {
    expect(safeRedirectPath(value, "after-sign-in")).toBeNull();
  });

  it("the auth-link exception is exact: no sub-paths or look-alikes", () => {
    for (const value of ["/auth/reset-password/x", "/auth/accept-invite-2", "/auth/reset-password/../callback"]) {
      expect(safeRedirectPath(value, "auth-link"), value).toBeNull();
    }
  });
});

// ─── The routes ──────────────────────────────────────────────────────────

const exchangeCodeForSession = vi.fn();
const verifyOtp = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession, verifyOtp } }),
}));

const { GET: callback } = await import("@/app/auth/callback/route");
const { GET: confirm } = await import("@/app/auth/confirm/route");

const ORIGIN = "https://academic-nexus.example";

function location(response: Response): URL {
  const header = response.headers.get("location");
  if (!header) throw new Error("no Location header");
  return new URL(header);
}

const callbackUrl = (next?: string) => {
  const params = new URLSearchParams({ code: "one-time-code" });
  if (next !== undefined) params.set("next", next);
  return `${ORIGIN}/auth/callback?${params}`;
};
const confirmUrl = (next?: string) => {
  const params = new URLSearchParams({ token_hash: "hashed", type: "invite" });
  if (next !== undefined) params.set("next", next);
  return `${ORIGIN}/auth/confirm?${params}`;
};

const ROUTES = [
  ["/auth/callback", callback, callbackUrl],
  ["/auth/confirm", confirm, confirmUrl],
] as const;

const ATTACKS = [".evil.example", "@evil.example", "https://example.com", "//example.com", "\\\\example.com", "/\\example.com", "/login", "/api/cron"];

describe.each(ROUTES)("%s", (_, GET, url) => {
  beforeEach(() => {
    exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
    verifyOtp.mockReset().mockResolvedValue({ error: null });
  });

  it.each(ATTACKS)("after signing in, next=%j stays on this site and falls back to /", async (next) => {
    const target = location(await GET(new Request(url(next))));
    expect(target.origin).toBe(ORIGIN);
    expect(target.pathname).toBe("/");
    expect(target.username).toBe("");
  });

  it.each([
    ["/student/fees", "/student/fees"],
    ["/teacher/attendance?section=A", "/teacher/attendance?section=A"],
    ["/auth/reset-password", "/auth/reset-password"],
    ["/auth/accept-invite", "/auth/accept-invite"],
  ])("keeps the internal destination %j", async (next, expected) => {
    const target = location(await GET(new Request(url(next))));
    expect(target.origin).toBe(ORIGIN);
    expect(`${target.pathname}${target.search}`).toBe(expected);
  });

  it("with no next, goes to / as before", async () => {
    const target = location(await GET(new Request(url())));
    expect(`${target.origin}${target.pathname}`).toBe(`${ORIGIN}/`);
  });

  it("a failed exchange still goes to the login error, whatever next says", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: new Error("bad code") });
    verifyOtp.mockResolvedValue({ error: new Error("bad token") });
    const target = location(await GET(new Request(url(".evil.example"))));
    expect(`${target.origin}${target.pathname}${target.search}`).toBe(`${ORIGIN}/login?error=auth_failed`);
  });
});

describe("existing auth links are unchanged", () => {
  beforeEach(() => {
    exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
    verifyOtp.mockReset().mockResolvedValue({ error: null });
  });

  it("password recovery (/auth/callback?next=/auth/reset-password) lands on the reset form", async () => {
    // app/login/page.tsx and scripts/cutover-password-reset.ts build this link.
    const target = location(await callback(new Request(`${ORIGIN}/auth/callback?code=c&next=/auth/reset-password`)));
    expect(target.href).toBe(`${ORIGIN}/auth/reset-password`);
  });

  it("an invitation (/auth/confirm?…&next=/auth/accept-invite) lands on accept-invite", async () => {
    // lib/invitations.ts builds this link with URLSearchParams.
    const params = new URLSearchParams({ token_hash: "h", type: "invite", next: "/auth/accept-invite" });
    const target = location(await confirm(new Request(`${ORIGIN}/auth/confirm?${params}`)));
    expect(target.href).toBe(`${ORIGIN}/auth/accept-invite`);
  });

  it("the invitation's hosted-verify fallback (/auth/callback?next=/auth/accept-invite) lands on accept-invite", async () => {
    const target = location(await callback(new Request(`${ORIGIN}/auth/callback?code=c&next=/auth/accept-invite`)));
    expect(target.href).toBe(`${ORIGIN}/auth/accept-invite`);
  });
});
