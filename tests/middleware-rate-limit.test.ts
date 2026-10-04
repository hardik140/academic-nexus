import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { keyDigest } from "@/lib/redis-config";
import { resetSessionIdentity } from "@/lib/auth/session-identity";
import { makeSigner, claims, hs256Token, sessionCookie, jwksFetch, SUPABASE_URL, type Signer } from "./support/session-tokens";

/**
 * Which middleware bucket a request spends.
 *
 * The campus problem: a whole college can reach the app through ONE public
 * IP. The bucket therefore follows a PROVEN identity — the access token's
 * signature is verified locally (lib/auth/session-identity.ts) — never the
 * mere presence of a cookie:
 *
 *   verified token            -> user:<id>             only
 *   none / forged / garbled   -> ip:<campus ip>        strict, shared
 *   unverifiable (HS256 etc.) -> ipCredentialed:<ip>   then user:<id> after getUser()
 *
 * Real ES256 tokens, real cookie formats; the limiter and Supabase Auth are
 * mocked (tests/middleware-campus-isolation.test.ts runs the real limiter).
 */

const h = vi.hoisted(() => ({
  keys: [] as string[],
  user: null as null | { id: string },
  denyBucket: null as string | null,
}));

vi.mock("@/lib/rate-limit", () => {
  class RateLimitError extends Error {
    retryAfterSeconds = 17;
  }
  class RateLimiterUnavailableError extends Error {}
  return {
    RateLimitError,
    RateLimiterUnavailableError,
    checkRateLimit: vi.fn(async (key: string) => {
      h.keys.push(key);
      if (h.denyBucket && key.startsWith(`${h.denyBucket}:`)) throw new RateLimitError("slow down");
    }),
  };
});
// Only the Auth call is faked; the cookie helpers session-identity uses stay real.
vi.mock("@supabase/ssr", async (original) => ({
  ...(await original<typeof import("@supabase/ssr")>()),
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}));
vi.mock("@/lib/cache", () => ({
  getCached: vi.fn(),
}));

const { updateSession, ANONYMOUS_IP_LIMIT, CREDENTIALED_IP_LIMIT, USER_LIMIT } = await import("@/lib/supabase/middleware");
const { checkRateLimit } = await import("@/lib/rate-limit");

const CAMPUS_IP = "203.0.113.9";
const IP = keyDigest(CAMPUS_IP);
const STUDENT_1 = "00000004-0000-4000-8000-000000000001";
const STUDENT_2 = "00000004-0000-4000-8000-000000000002";
const jwks = { calls: 0, down: false };
let project: Signer;
let attacker: Signer;

beforeAll(async () => {
  project = await makeSigner("project-key");
  attacker = await makeSigner("project-key");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
  vi.stubGlobal("fetch", jwksFetch([project], jwks));
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function req(path: string, opts: { cookie?: string; bearer?: string; ip?: string } = {}) {
  const headers = new Headers({ "cf-connecting-ip": opts.ip ?? CAMPUS_IP });
  if (opts.cookie !== undefined) headers.set("cookie", opts.cookie);
  if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
  return new NextRequest(`https://nexus.example${path}`, { headers });
}
const signedIn = async (sub: string, opts: { expiredSecondsAgo?: number } = {}) => sessionCookie(await project.sign(claims(sub, opts)));

beforeEach(() => {
  h.keys = [];
  h.user = null;
  h.denyBucket = null;
  jwks.down = false;
  resetSessionIdentity();
  vi.mocked(checkRateLimit).mockClear();
});

describe("anonymous traffic keeps per-IP protection", () => {
  it("spends only the strict per-IP bucket", async () => {
    await updateSession(req("/login"));
    expect(h.keys).toEqual([`ip:${IP}`]);
    expect(checkRateLimit).toHaveBeenCalledWith(`ip:${IP}`, ANONYMOUS_IP_LIMIT, 60);
  });

  it("an empty session cookie is not a session", async () => {
    await updateSession(req("/login", { cookie: "sb-qa-project-auth-token=" }));
    expect(h.keys).toEqual([`ip:${IP}`]);
  });

  it("is refused with 429 and Retry-After when the bucket is spent", async () => {
    h.denyBucket = "ip";
    const res = await updateSession(req("/login"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("17");
  });
});

describe("a verified session spends only its own bucket — no shared bucket at all", () => {
  it("one user bucket, charged before Supabase Auth, and not charged twice", async () => {
    h.user = { id: STUDENT_1 };
    await updateSession(req("/login", { cookie: await signedIn(STUDENT_1) }));
    expect(h.keys).toEqual([`user:${STUDENT_1}`]);
    expect(checkRateLimit).toHaveBeenCalledWith(`user:${STUDENT_1}`, USER_LIMIT, 60);
  });

  it("recognises chunked and raw-JSON session cookies", async () => {
    h.user = { id: STUDENT_1 };
    const token = await project.sign(claims(STUDENT_1));
    await updateSession(req("/login", { cookie: sessionCookie(token, { chunkSize: 100 }) }));
    await updateSession(req("/login", { cookie: sessionCookie(token, { encoding: "raw" }) }));
    expect(h.keys).toEqual([`user:${STUDENT_1}`, `user:${STUDENT_1}`]);
  });

  it("an expired-but-signed token (the hourly case) still counts against its own user, not the campus", async () => {
    h.user = { id: STUDENT_1 }; // getUser() refreshes it
    await updateSession(req("/login", { cookie: await signedIn(STUDENT_1, { expiredSecondsAgo: 600 }) }));
    expect(h.keys).toEqual([`user:${STUDENT_1}`]);
  });

  it("two students behind one campus IP spend different buckets and nothing shared", async () => {
    h.user = { id: STUDENT_1 };
    await updateSession(req("/login", { cookie: await signedIn(STUDENT_1) }));
    h.user = { id: STUDENT_2 };
    await updateSession(req("/login", { cookie: await signedIn(STUDENT_2) }));
    expect(h.keys).toEqual([`user:${STUDENT_1}`, `user:${STUDENT_2}`]);
  });

  it("the per-user ceiling is enforced", async () => {
    h.user = { id: STUDENT_1 };
    h.denyBucket = "user";
    const res = await updateSession(req("/login", { cookie: await signedIn(STUDENT_1) }));
    expect(res.status).toBe(429);
  });

  it("a mobile bearer token is verified the same way", async () => {
    await updateSession(req("/api/mobile/attendance", { bearer: await project.sign(claims(STUDENT_1)) }));
    expect(h.keys).toEqual([`user:${STUDENT_1}`]);
  });
});

describe("forged and dead sessions are anonymous", () => {
  it("a random cookie value spends the strict per-IP bucket, once", async () => {
    await updateSession(req("/login", { cookie: "sb-qa-project-auth-token=forged" }));
    expect(h.keys).toEqual([`ip:${IP}`]);
  });

  it("a token signed with someone else's key, naming a real user, cannot spend that user's bucket", async () => {
    const forged = sessionCookie(await attacker.sign(claims(STUDENT_1)));
    await updateSession(req("/login", { cookie: forged }));
    expect(h.keys).toEqual([`ip:${IP}`]);
    expect(h.keys.some((k) => k.startsWith("user:"))).toBe(false);
  });

  it("a forged bearer token spends the strict per-IP bucket", async () => {
    await updateSession(req("/api/mobile/attendance", { bearer: "not.a.jwt" }));
    expect(h.keys).toEqual([`ip:${IP}`]);
  });

  it("a signed token whose session is dead (getUser fails) also spends the strict per-IP bucket", async () => {
    h.user = null;
    await updateSession(req("/login", { cookie: await signedIn(STUDENT_1, { expiredSecondsAgo: 86_400 * 30 }) }));
    expect(h.keys).toEqual([`user:${STUDENT_1}`, `ip:${IP}`]);
  });

  it("and is refused when that bucket is spent", async () => {
    h.denyBucket = "ip";
    const res = await updateSession(req("/login", { cookie: "sb-qa-project-auth-token=forged" }));
    expect(res.status).toBe(429);
  });
});

describe("tokens this isolate cannot verify keep the old, generous shared ceiling", () => {
  it("an HS256 token: credentialed ceiling, then the user's bucket once Supabase confirms it", async () => {
    h.user = { id: STUDENT_1 };
    await updateSession(req("/login", { cookie: sessionCookie(hs256Token(STUDENT_1)) }));
    expect(h.keys).toEqual([`ipCredentialed:${IP}`, `user:${STUDENT_1}`]);
    expect(checkRateLimit).toHaveBeenCalledWith(`ipCredentialed:${IP}`, CREDENTIALED_IP_LIMIT, 60);
  });

  it("the key set unreachable: same fallback, never reclassified as an attacker", async () => {
    jwks.down = true;
    h.user = { id: STUDENT_1 };
    await updateSession(req("/login", { cookie: await signedIn(STUDENT_1) }));
    expect(h.keys).toEqual([`ipCredentialed:${IP}`, `user:${STUDENT_1}`]);
  });

  it("the fallback ceiling is generous enough for a campus (≥ 10× the anonymous one)", () => {
    expect(CREDENTIALED_IP_LIMIT).toBeGreaterThanOrEqual(10 * ANONYMOUS_IP_LIMIT);
  });
});

describe("keys never hold a raw IP", () => {
  it("stores a digest", async () => {
    await updateSession(req("/login"));
    await updateSession(req("/login", { cookie: "sb-qa-project-auth-token=x" }));
    for (const k of h.keys) expect(k).not.toContain(CAMPUS_IP);
  });

  it("different client IPs get different buckets", async () => {
    await updateSession(req("/login", { ip: "198.51.100.1" }));
    await updateSession(req("/login", { ip: "198.51.100.2" }));
    expect(new Set(h.keys).size).toBe(2);
  });
});
