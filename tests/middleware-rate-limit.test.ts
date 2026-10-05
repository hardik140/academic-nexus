import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { keyDigest } from "@/lib/redis-config";

/**
 * Which middleware bucket a request spends.
 *
 * The campus problem: a whole college can reach the app through ONE public
 * IP. Before this change every request — signed in or not — spent the same
 * `ip:` bucket (100/min), so a class of signed-in students could lock the
 * whole college out. Now anonymous traffic keeps the strict per-IP bucket,
 * and authenticated traffic is counted per user.
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
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}));
vi.mock("@/lib/cache", () => ({
  getCached: vi.fn(),
  middlewareProfileCacheKey: (id: string) => `p:${id}`,
  MIDDLEWARE_PROFILE_CACHE: {},
}));

const { updateSession, ANONYMOUS_IP_LIMIT, CREDENTIALED_IP_LIMIT, USER_LIMIT } = await import("@/lib/supabase/middleware");
const { checkRateLimit } = await import("@/lib/rate-limit");

const CAMPUS_IP = "203.0.113.9";
const IP = keyDigest(CAMPUS_IP);
const SESSION = "sb-abcdefghijklmnop-auth-token";

function req(path: string, opts: { cookie?: string; bearer?: string; ip?: string } = {}) {
  const headers = new Headers({ "cf-connecting-ip": opts.ip ?? CAMPUS_IP });
  if (opts.cookie !== undefined) headers.set("cookie", opts.cookie);
  if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
  return new NextRequest(`https://nexus.example${path}`, { headers });
}

beforeEach(() => {
  h.keys = [];
  h.user = null;
  h.denyBucket = null;
  vi.mocked(checkRateLimit).mockClear();
});

describe("anonymous traffic keeps per-IP protection", () => {
  it("spends only the strict per-IP bucket", async () => {
    await updateSession(req("/login"));
    expect(h.keys).toEqual([`ip:${IP}`]);
    expect(checkRateLimit).toHaveBeenCalledWith(`ip:${IP}`, ANONYMOUS_IP_LIMIT, 60);
  });

  it("an empty session cookie is not a session", async () => {
    await updateSession(req("/login", { cookie: `${SESSION}=` }));
    expect(h.keys).toEqual([`ip:${IP}`]);
  });

  it("is refused with 429 and Retry-After when the bucket is spent", async () => {
    h.denyBucket = "ip";
    const res = await updateSession(req("/login"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("17");
  });
});

describe("authenticated traffic is counted per user, not per campus", () => {
  it("spends the credentialed ceiling, then the user's own bucket — never the anonymous one", async () => {
    h.user = { id: "student-1" };
    await updateSession(req("/login", { cookie: `${SESSION}=token` }));
    expect(h.keys).toEqual([`ipCredentialed:${IP}`, "user:student-1"]);
    expect(checkRateLimit).toHaveBeenCalledWith(`ipCredentialed:${IP}`, CREDENTIALED_IP_LIMIT, 60);
    expect(checkRateLimit).toHaveBeenCalledWith("user:student-1", USER_LIMIT, 60);
  });

  it("recognises a chunked session cookie", async () => {
    h.user = { id: "student-1" };
    await updateSession(req("/login", { cookie: `${SESSION}.0=part1; ${SESSION}.1=part2` }));
    expect(h.keys[0]).toBe(`ipCredentialed:${IP}`);
  });

  it("two students behind one campus IP spend different buckets", async () => {
    h.user = { id: "student-1" };
    await updateSession(req("/login", { cookie: `${SESSION}=t1` }));
    h.user = { id: "student-2" };
    await updateSession(req("/login", { cookie: `${SESSION}=t2` }));
    const perUser = h.keys.filter((k) => k.startsWith("user:"));
    expect(perUser).toEqual(["user:student-1", "user:student-2"]);
    expect(h.keys.filter((k) => k.startsWith("ip:"))).toEqual([]);
  });

  it("the per-user ceiling is enforced", async () => {
    h.user = { id: "student-1" };
    h.denyBucket = "user";
    const res = await updateSession(req("/login", { cookie: `${SESSION}=t1` }));
    expect(res.status).toBe(429);
  });

  it("the credentialed ceiling is generous enough for a campus (≥ 10× the anonymous one)", () => {
    expect(CREDENTIALED_IP_LIMIT).toBeGreaterThanOrEqual(10 * ANONYMOUS_IP_LIMIT);
  });
});

describe("a forged session cannot escape the anonymous limit", () => {
  it("a session cookie that does not verify also spends the strict per-IP bucket", async () => {
    h.user = null;
    await updateSession(req("/login", { cookie: `${SESSION}=forged` }));
    expect(h.keys).toEqual([`ipCredentialed:${IP}`, `ip:${IP}`]);
  });

  it("and is refused when that bucket is spent", async () => {
    h.denyBucket = "ip";
    const res = await updateSession(req("/login", { cookie: `${SESSION}=forged` }));
    expect(res.status).toBe(429);
  });
});

describe("mobile API (bearer token, no cookie)", () => {
  it("spends the credentialed ceiling only; the route verifies the token and applies per-user buckets", async () => {
    await updateSession(req("/api/mobile/attendance", { bearer: "jwt" }));
    expect(h.keys).toEqual([`ipCredentialed:${IP}`]);
  });
});

describe("keys never hold a raw IP", () => {
  it("stores a digest", async () => {
    await updateSession(req("/login"));
    await updateSession(req("/login", { cookie: `${SESSION}=x` }));
    for (const k of h.keys) expect(k).not.toContain(CAMPUS_IP);
  });

  it("different client IPs get different buckets", async () => {
    await updateSession(req("/login", { ip: "198.51.100.1" }));
    await updateSession(req("/login", { ip: "198.51.100.2" }));
    expect(new Set(h.keys).size).toBe(2);
  });
});
