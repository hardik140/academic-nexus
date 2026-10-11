import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { NextRequest } from "next/server";
import { makeSigner, claims, hs256Token, sessionCookie, jwksFetch, SUPABASE_URL, type Signer } from "./support/session-tokens";

/**
 * Campus isolation under attack — the REAL middleware (lib/supabase/middleware.ts),
 * the REAL limiter (lib/rate-limit.ts, @upstash/ratelimit) against the local
 * Upstash emulator, and real ES256 session tokens. Only Supabase Auth is
 * faked: getUser() accepts a token whose signature verifies and whose user is
 * not in `dead`.
 *
 * The invariant: one malicious client on a campus network cannot spend the
 * authenticated quota of unrelated users on that network.
 *
 * Before this change the second scenario below failed: 2,000 forged-cookie
 * requests from one device made every signed-in user on the campus IP get
 * 429 (bench/audit/middleware-flood.audit.ts on PR #124's branch).
 */

const h = vi.hoisted(() => ({ port: 0, dead: new Set<string>() }));

vi.mock("@supabase/ssr", async (original) => {
  const real = await original<typeof import("@supabase/ssr")>();
  return {
    ...real,
    createServerClient: (_u: string, _k: string, opts: { cookies: { getAll: () => { name: string; value: string }[] } }) => ({
      auth: {
        getUser: async () => {
          const { sessionIdentity, accessTokenFrom } = await import("@/lib/auth/session-identity");
          const request = { headers: { get: () => null }, cookies: { getAll: opts.cookies.getAll } };
          const id = await sessionIdentity(request);
          if (id.kind === "verified") return { data: { user: h.dead.has(id.userId) ? null : { id: id.userId } } };
          // Supabase itself accepts HS256 tokens (it holds the secret this app does not).
          if (id.kind === "unverifiable") {
            const token = (await accessTokenFrom(request)) ?? "";
            const sub = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "{}").sub;
            return { data: { user: sub ? { id: sub } : null } };
          }
          return { data: { user: null } };
        },
      },
      from: () => ({
        select: () => ({ eq: () => ({ single: async () => ({ data: { role: "finance", college_id: "c1", status: "active" } }) }) }),
      }),
    }),
  };
});
vi.mock("@/lib/college-access", () => ({
  AccessFeatureUnavailable: class extends Error {},
  admissionAllows: () => true,
  deviceLabelFromUserAgent: () => "test",
  registerSession: async () => ({ state: "active" }),
  unavailableReason: () => "error",
}));

let emulator: ChildProcess;
let project: Signer;
let attacker: Signer;
/** The project's published key set; a test may rotate it. */
const published: Signer[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      srv.close(() => (typeof a === "object" && a ? resolve(a.port) : reject(new Error("no port"))));
    });
  });
}

beforeAll(async () => {
  h.port = await freePort();
  emulator = spawn(process.execPath, ["e2e/support/upstash-emulator.mjs", String(h.port)], { stdio: "pipe" });
  await new Promise<void>((resolve) => emulator.stdout!.on("data", (d) => String(d).includes("listening") && resolve()));
  project = await makeSigner("project-key");
  attacker = await makeSigner("project-key");
  published.push(project);
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("REDIS_ENV", "test");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", `http://127.0.0.1:${h.port}`);
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "emulator-token");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
  // JWKS for session-identity; everything else (the limiter's Upstash calls) goes to the real fetch.
  const realFetch = globalThis.fetch;
  const keys = jwksFetch(published);
  vi.stubGlobal("fetch", ((input: string | URL | Request, init?: RequestInit) =>
    String(input).includes("/.well-known/jwks.json") ? keys(input) : realFetch(input, init)) as typeof fetch);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}, 60_000);
afterAll(() => {
  emulator?.kill();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** A fresh middleware + limiter + empty Redis for each scenario. */
async function fresh() {
  await fetch(`http://127.0.0.1:${h.port}/__reset`, { method: "POST" });
  vi.resetModules();
  const mw = await import("@/lib/supabase/middleware");
  (await import("@/lib/redis-guard")).resetRedisGuard();
  (await import("@/lib/auth/session-identity")).resetSessionIdentity();
  return mw;
}

const uid = (n: number) => `0000000c-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CAMPUS = "203.0.113.50";

function req(path: string, opts: { cookie?: string; ip?: string } = {}) {
  const headers = new Headers({ "cf-connecting-ip": opts.ip ?? CAMPUS });
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return new NextRequest(`https://nexus.example${path}`, { headers });
}
const signed = async (sub: string, o: { expiredSecondsAgo?: number } = {}) => sessionCookie(await project.sign(claims(sub, o)));

/**
 * The limiter is a sliding window: across a minute boundary it admits a few
 * more than the limit (bench/results/ratelimit-algorithms.json: 31 for 30).
 * So "held to the limit" means admitted within [limit, limit + 10 %].
 */
function heldTo(admitted: number, limit: number) {
  expect(admitted).toBeGreaterThanOrEqual(limit);
  expect(admitted).toBeLessThanOrEqual(Math.ceil(limit * 1.1));
}

/** Sends `n` requests (in batches) and returns how many were refused with 429. */
async function send(mw: Awaited<ReturnType<typeof fresh>>, n: number, make: (i: number) => NextRequest | Promise<NextRequest>) {
  let limited = 0;
  for (let i = 0; i < n; i += 50) {
    const batch = await Promise.all(Array.from({ length: Math.min(50, n - i) }, (_, j) => make(i + j)));
    const res = await Promise.all(batch.map((r) => mw.updateSession(r)));
    limited += res.filter((r) => r.status === 429).length;
  }
  return limited;
}

describe("one malicious campus client cannot spend unrelated users' authenticated quota", () => {
  it("one user hammering: capped at their own limit; a neighbour on the same IP is untouched", async () => {
    const mw = await fresh();
    const a = await signed(uid(1));
    const limited = await send(mw, 400, () => req("/finance/dashboard", { cookie: a }));
    heldTo(400 - limited, mw.USER_LIMIT);
    expect((await mw.updateSession(req("/finance/dashboard", { cookie: await signed(uid(2)) }))).status).toBe(200);
  }, 120_000);

  it("forged-cookie flood (2,000 requests): every signed-in user on the campus still gets in", async () => {
    const mw = await fresh();
    const limited = await send(mw, 2000, (i) => req("/login", { cookie: `sb-qa-project-auth-token=forged-${i}` }));
    heldTo(2000 - limited, mw.ANONYMOUS_IP_LIMIT); // the attacker is held to the anonymous ceiling
    for (const n of [2, 3, 4]) {
      expect((await mw.updateSession(req("/finance/dashboard", { cookie: await signed(uid(n)) }))).status).toBe(200);
    }
    // The documented trade-off: anonymous visitors on that IP share the attacker's bucket.
    expect((await mw.updateSession(req("/login"))).status).toBe(429);
  }, 180_000);

  it("forged tokens that NAME a real user (wrong key) cannot spend that user's bucket", async () => {
    const mw = await fresh();
    const victim = uid(7);
    const forged = sessionCookie(await attacker.sign(claims(victim)));
    await send(mw, 500, () => req("/finance/dashboard", { cookie: forged }));
    expect((await mw.updateSession(req("/finance/dashboard", { cookie: await signed(victim) }))).status).toBe(200);
  }, 120_000);

  it("expired session, signed, dead at Supabase: counts against its own user AND the anonymous ceiling", async () => {
    const mw = await fresh();
    const ghost = uid(9);
    h.dead.add(ghost);
    try {
      const dead = await signed(ghost, { expiredSecondsAgo: 30 * 86_400 });
      const limited = await send(mw, 150, () => req("/login", { cookie: dead }));
      heldTo(150 - limited, mw.ANONYMOUS_IP_LIMIT);
      expect((await mw.updateSession(req("/finance/dashboard", { cookie: await signed(uid(10)) }))).status).toBe(200);
    } finally {
      h.dead.delete(ghost);
    }
  }, 120_000);

  it("account rotation: an attacker with 5 accounts gets 5 × the per-user limit, and nobody else is affected", async () => {
    const mw = await fresh();
    const accounts = await Promise.all([20, 21, 22, 23, 24].map((n) => signed(uid(n))));
    const limited = await send(mw, 5 * 400, (i) => req("/finance/dashboard", { cookie: accounts[i % 5] }));
    heldTo(5 * 400 - limited, 5 * mw.USER_LIMIT);
    expect((await mw.updateSession(req("/finance/dashboard", { cookie: await signed(uid(30)) }))).status).toBe(200);
  }, 180_000);

  it("IP rotation: forged requests from 20 addresses are held to the anonymous ceiling per address; campus users unaffected", async () => {
    const mw = await fresh();
    const limited = await send(mw, 20 * 120, (i) => req("/login", { ip: `198.51.100.${(i % 20) + 1}`, cookie: `sb-qa-project-auth-token=x${i}` }));
    heldTo(20 * 120 - limited, 20 * mw.ANONYMOUS_IP_LIMIT);
    expect((await mw.updateSession(req("/finance/dashboard", { cookie: await signed(uid(31)) }))).status).toBe(200);
  }, 180_000);
});

describe("key rotation", () => {
  it("the project rotates its signing key: 100 users on the new key, inside the refetch window, are not treated as forged", async () => {
    const mw = await fresh();
    // This isolate caches the key set as it was before the rotation.
    expect((await mw.updateSession(req("/finance/dashboard", { cookie: await signed(uid(500)) }))).status).not.toBe(429);
    const rotated = await makeSigner("rotated-key");
    published.push(rotated);
    try {
      const cookies = await Promise.all(Array.from({ length: 100 }, (_, n) => rotated.sign(claims(uid(600 + n))).then(sessionCookie)));
      const limited = await send(mw, 100 * 5, (i) => req("/finance/dashboard", { cookie: cookies[i % 100] }));
      // Called forged, these 500 requests would share the 100/min anonymous bucket: 400 refused.
      expect(limited).toBe(0);
    } finally {
      published.splice(published.indexOf(rotated), 1);
    }
  }, 300_000);
});

describe("many legitimate users behind one NAT", () => {
  for (const users of [10, 100]) {
    it(`${users} signed-in users × 50 requests from one IP: nobody is refused`, async () => {
      const mw = await fresh();
      const cookies = await Promise.all(Array.from({ length: users }, (_, n) => signed(uid(100 + n))));
      const limited = await send(mw, users * 50, (i) => req("/finance/dashboard", { cookie: cookies[i % users] }));
      // Under the old shared 2,000/min bucket, 100 users × 50 = 5,000 requests would have had 3,000 refused.
      expect(limited).toBe(0);
    }, 300_000);
  }

  it("RESIDUAL RISK, documented: if the project signs with HS256, tokens are unverifiable and share the campus ceiling again", async () => {
    const mw = await fresh();
    const cookies = Array.from({ length: 100 }, (_, n) => sessionCookie(hs256Token(uid(300 + n))));
    const limited = await send(mw, 100 * 30, (i) => req("/finance/dashboard", { cookie: cookies[i % 100] }));
    heldTo(100 * 30 - limited, mw.CREDENTIALED_IP_LIMIT);
  }, 300_000);
});
