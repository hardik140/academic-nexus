import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { NextRequest } from "next/server";

/**
 * AUDIT (section 7/34): can ONE device on a campus network lock every
 * signed-in user on that campus out, using forged session cookies?
 *
 * The REAL middleware (lib/supabase/middleware.ts) and the REAL limiter
 * (lib/rate-limit.ts, @upstash/ratelimit) against the local Upstash
 * emulator. Only Supabase is faked: getUser() returns a user for the
 * victim's cookie and nobody for the attacker's forged one.
 *
 * The middleware spends the `ipCredentialed` bucket (2000/min, per campus
 * IP) BEFORE getUser() verifies the cookie, so the forged requests are
 * counted against the bucket every legitimate campus user shares.
 */

const h = vi.hoisted(() => ({ port: 0 }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_u: string, _k: string, opts: { cookies: { getAll: () => { name: string; value: string }[] } }) => ({
    auth: {
      getUser: async () => {
        const token = opts.cookies.getAll().find((c) => c.name.endsWith("-auth-token"))?.value;
        return { data: { user: token === "valid-session" ? { id: "victim-user" } : null } };
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: { role: "finance", college_id: "c1", status: "active" } }) }),
      }),
    }),
  }),
}));
vi.mock("@/lib/college-access", () => ({
  AccessFeatureUnavailable: class extends Error {},
  admissionAllows: () => true,
  deviceLabelFromUserAgent: () => "test",
  registerSession: async () => ({ state: "active" }),
  unavailableReason: () => "error",
}));

let emulator: ChildProcess;
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
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("REDIS_ENV", "test");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", `http://127.0.0.1:${h.port}`);
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "emulator-token");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => emulator?.kill());

const CAMPUS_IP = "203.0.113.50";
const COOKIE = "sb-abcdefghijklmnop-auth-token";
function req(path: string, cookie?: string) {
  const headers = new Headers({ "cf-connecting-ip": CAMPUS_IP });
  if (cookie) headers.set("cookie", `${COOKIE}=${cookie}`);
  return new NextRequest(`https://nexus.example${path}`, { headers });
}

describe("forged-cookie flood from one campus device", () => {
  it("exhausts the campus credentialed bucket and the anonymous bucket", async () => {
    const { updateSession, CREDENTIALED_IP_LIMIT } = await import("@/lib/supabase/middleware");

    const before = await updateSession(req("/finance/dashboard", "valid-session"));
    const beforeStatus = before.status;

    // The attacker: one device, a random string as its session cookie.
    let attackerRequests = 0;
    for (let batch = 0; batch < CREDENTIALED_IP_LIMIT / 100; batch++) {
      await Promise.all(Array.from({ length: 100 }, () => updateSession(req("/login", "forged-" + Math.random()))));
      attackerRequests += 100;
    }

    const victim = await updateSession(req("/finance/dashboard", "valid-session"));
    const anonymousVisitor = await updateSession(req("/login"));

    const finding = {
      attackerRequests,
      victimBefore: beforeStatus,
      signedInCampusUserAfter: victim.status,
      anonymousCampusVisitorAfter: anonymousVisitor.status,
      cause: "lib/supabase/middleware.ts spends ipCredentialed:<campus ip> before getUser() verifies the cookie; a forged cookie is then also charged to ip:<campus ip>.",
    };
    const path = "bench/results/redis-audit.json";
    const all = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    all.forgedCookieFlood = finding;
    writeFileSync(path, JSON.stringify(all, null, 2) + String.fromCharCode(10));

    // Documents CURRENT behaviour: the legitimate user is refused.
    expect(beforeStatus).not.toBe(429);
    expect(victim.status).toBe(429);
  }, 120_000);
});
