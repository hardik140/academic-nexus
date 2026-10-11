import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

/**
 * The REAL Redis stack — @upstash/redis (retry, abort), @upstash/ratelimit
 * (its script protocol and its own timeout), lib/redis-guard.ts, and
 * lib/rate-limit.ts / lib/cache.ts — against a local Upstash emulator
 * (e2e/support/upstash-emulator.mjs) that can be healthy, slow, down,
 * malformed, or refusing auth. Nothing here reaches Upstash.
 *
 * The emulator answers "slow" after 1500 ms; the budget under test is
 * REDIS_TIMEOUT_MS = 300. Every timing assertion below has a wide margin.
 */

const TIMEOUT_MS = 300;
let port = 0;
let emulator: ChildProcess;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      srv.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

async function control(path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined && path === "/__state" ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

const setMode = (mode: string, delayMs = 0) => control("/__mode", { mode, delayMs });

beforeAll(async () => {
  port = await freePort();
  emulator = spawn(process.execPath, ["e2e/support/upstash-emulator.mjs", String(port)], { stdio: "pipe" });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("emulator did not start")), 10_000);
    emulator.stdout!.on("data", (d) => {
      if (String(d).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
});

afterAll(() => {
  emulator?.kill();
});

async function load(nodeEnv: "development" | "production" = "development") {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("REDIS_ENV", "test");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", `http://127.0.0.1:${port}`);
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "emulator-token");
  vi.stubEnv("REDIS_TIMEOUT_MS", String(TIMEOUT_MS));
  const rateLimit = await import("@/lib/rate-limit");
  const cache = await import("@/lib/cache");
  const guard = await import("@/lib/redis-guard");
  const telemetry = await import("@/lib/redis-telemetry");
  guard.resetRedisGuard();
  telemetry.recordRedisEvents(true);
  return { ...rateLimit, ...cache, ...guard, ...telemetry };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const t = Date.now();
  try {
    const value = await fn();
    return { ms: Date.now() - t, value };
  } catch (error) {
    return { ms: Date.now() - t, error };
  }
}

beforeEach(async () => {
  await control("/__reset");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("Redis healthy", () => {
  it("enforces a limit through the real limiter, then refuses with 429 semantics", async () => {
    const m = await load();
    for (let i = 0; i < 3; i++) await m.checkRateLimit("recordPayment:user-a", 3, 60);
    await expect(m.checkRateLimit("recordPayment:user-a", 3, 60)).rejects.toBeInstanceOf(m.RateLimitError);
  });

  it("keeps users, actions and environments in separate buckets", async () => {
    const m = await load();
    await m.checkRateLimit("recordPayment:user-a", 1, 60);
    await expect(m.checkRateLimit("recordPayment:user-a", 1, 60)).rejects.toBeInstanceOf(m.RateLimitError);
    // another user, another action: untouched
    await expect(m.checkRateLimit("recordPayment:user-b", 1, 60)).resolves.toBeUndefined();
    await expect(m.checkRateLimit("approveRefund:user-a", 1, 60)).resolves.toBeUndefined();

    const { keys } = await control("/__state");
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k.startsWith("test:nexus:rl:v1:")).toBe(true);

    // The same user id under another environment's namespace is a fresh bucket.
    vi.stubEnv("REDIS_ENV", "development");
    vi.resetModules();
    const dev = await import("@/lib/rate-limit");
    await expect(dev.checkRateLimit("recordPayment:user-a", 1, 60)).resolves.toBeUndefined();
  });

  it("caches, then serves the second read from Redis", async () => {
    const m = await load();
    const fetcher = vi.fn(async () => ({ rows: [1, 2] }));
    await m.getCached("dashboard:director:college-a:counts", 60, fetcher);
    expect(await m.getCached("dashboard:director:college-a:counts", 60, fetcher)).toEqual({ rows: [1, 2] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("a family bump makes every page, sort and viewer of that college miss — and no other college", async () => {
    const m = await load();
    const a1 = m.versionedKey("list:fees:college-a:0:due_date:desc:-", "list:fees", "college-a");
    const a2 = m.versionedKey("list:fees:warden-1:3:amount:asc:sabc", "list:fees", "college-a");
    const b1 = m.versionedKey("list:fees:college-b:0:due_date:desc:-", "list:fees", "college-b");
    const fetch = (v: string) => vi.fn(async () => v);
    const [fa1, fa2, fb1] = [fetch("a1"), fetch("a2"), fetch("b1")];
    for (const [k, f] of [[a1, fa1], [a2, fa2], [b1, fb1]] as const) await m.getCached(k, 60, f);

    await m.invalidateCacheFamily("list:fees", "college-a");

    for (const [k, f] of [[a1, fa1], [a2, fa2], [b1, fb1]] as const) await m.getCached(k, 60, f);
    expect(fa1).toHaveBeenCalledTimes(2);
    expect(fa2).toHaveBeenCalledTimes(2);
    expect(fb1).toHaveBeenCalledTimes(1);
  });

  it("ordinary values are build-scoped: a new build never reads an old build's value shape", async () => {
    const m = await load();
    await m.getCached("dashboard:admin:college-a:counts", 60, async () => ({ old: "shape" }));
    vi.stubEnv("NEXT_PUBLIC_REDIS_BUILD_ID", "build-2");
    vi.resetModules();
    const next = await import("@/lib/cache");
    const fetcher = vi.fn(async () => ({ new: "shape" }));
    expect(await next.getCached("dashboard:admin:college-a:counts", 60, fetcher)).toEqual({ new: "shape" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("Redis slow (answers after 1500 ms; budget 300 ms)", () => {
  it("REFUSES a protected action within the budget — the timeout is never read as 'allowed'", async () => {
    // Against the previous lib/rate-limit.ts this resolved after ~5 s
    // (@upstash/ratelimit's default timeout) and ALLOWED the payment.
    const m = await load();
    await setMode("slow", 1500);
    const r = await timed(() => m.checkRateLimit("recordPayment:user-a", 15, 60));
    expect(r.error).toBeInstanceOf(m.RateLimiterUnavailableError);
    expect(r.ms).toBeLessThan(TIMEOUT_MS + 400);
    expect(m.recordedRedisEvents).toContainEqual(
      expect.objectContaining({ event: "redis.ratelimit", bucket: "recordPayment", outcome: "fail_closed", reason: "timeout" })
    );
  });

  it("refuses an UNCLASSIFIED action on timeout too", async () => {
    const m = await load();
    await setMode("slow", 1500);
    await expect(m.checkRateLimit("someNewAction:user-a", 5, 60)).rejects.toBeInstanceOf(m.RateLimiterUnavailableError);
  });

  it("lets an approved low-risk action through on timeout, and records it as fail-open", async () => {
    const m = await load();
    await setMode("slow", 1500);
    const r = await timed(() => m.checkRateLimit("saveAttendance:teacher-1", 30, 60));
    expect(r.error).toBeUndefined();
    expect(r.ms).toBeLessThan(TIMEOUT_MS + 400);
    expect(m.recordedRedisEvents).toContainEqual(
      expect.objectContaining({ event: "redis.ratelimit", bucket: "saveAttendance", outcome: "fail_open", reason: "timeout" })
    );
  });

  it("a cached read falls back to the database within the budget", async () => {
    const m = await load();
    await setMode("slow", 1500);
    const r = await timed(() => m.getCached("dashboard:admin:college-a:counts", 60, async () => "fresh"));
    expect(r.value).toBe("fresh");
    // read times out (≤ budget), write times out (≤ budget)
    expect(r.ms).toBeLessThan(2 * TIMEOUT_MS + 500);
  });

  it("opens the circuit after repeated failures, so later calls cost nothing", async () => {
    const m = await load();
    await setMode("slow", 1500);
    for (let i = 0; i < m.CIRCUIT_THRESHOLD; i++) {
      await m.checkRateLimit("saveAttendance:t1", 30, 60);
    }
    expect(m.circuitIsOpen()).toBe(true);
    const before = (await control("/__state")).requests;
    const r = await timed(() => m.checkRateLimit("recordPayment:u1", 15, 60));
    expect(r.error).toBeInstanceOf(m.RateLimiterUnavailableError);
    expect(r.ms).toBeLessThan(50);
    expect((await control("/__state")).requests).toBe(before);
  });
});

describe("Redis down (connection dropped)", () => {
  it("retries exactly once, then refuses a protected action within the budget", async () => {
    const m = await load();
    await setMode("down");
    const r = await timed(() => m.checkRateLimit("approveRefund:user-a", 30, 60));
    expect(r.error).toBeInstanceOf(m.RateLimiterUnavailableError);
    expect(r.ms).toBeLessThan(TIMEOUT_MS + 400);
    const retries = m.recordedRedisEvents.filter((e) => e.event === "redis.retry");
    expect(retries).toHaveLength(1);
  });

  it("a cached read still answers from the database", async () => {
    const m = await load();
    await setMode("down");
    expect(await m.getCached("dashboard:admin:college-a:counts", 60, async () => "fresh")).toBe("fresh");
  });

  it("recovers: after the cooldown one probe succeeds and the circuit closes", async () => {
    const m = await load();
    await setMode("down");
    for (let i = 0; i < m.CIRCUIT_THRESHOLD; i++) await m.checkRateLimit("saveAttendance:t1", 30, 60);
    expect(m.circuitIsOpen()).toBe(true);

    await setMode("healthy");
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + m.CIRCUIT_COOLDOWN_MS + 1);
    await expect(m.checkRateLimit("recordPayment:u1", 15, 60)).resolves.toBeUndefined();
    vi.mocked(Date.now).mockRestore();
    expect(m.circuitIsOpen()).toBe(false);
    expect(m.recordedRedisEvents).toContainEqual({ event: "redis.circuit", state: "closed" });
  });
});

describe("Redis answering garbage", () => {
  it("a malformed (non-JSON) answer refuses a protected action and never counts as allowed", async () => {
    const m = await load();
    await setMode("malformed");
    const r = await timed(() => m.checkRateLimit("recordPayment:user-a", 15, 60));
    expect(r.error).toBeInstanceOf(m.RateLimiterUnavailableError);
    expect(m.recordedRedisEvents).toContainEqual(
      expect.objectContaining({ event: "redis.op", op: "ratelimit", outcome: "malformed" })
    );
  });

  it("a malformed answer is a cache miss, not a cached value", async () => {
    const m = await load();
    await setMode("malformed");
    expect(await m.getCached("dashboard:admin:college-a:counts", 60, async () => "fresh")).toBe("fresh");
  });

  it("an auth failure (revoked token) refuses a protected action, is classified as auth, and is not retried", async () => {
    const m = await load();
    await setMode("auth");
    await expect(m.checkRateLimit("recordPayment:user-a", 15, 60)).rejects.toBeInstanceOf(m.RateLimiterUnavailableError);
    expect(m.recordedRedisEvents).toContainEqual(expect.objectContaining({ event: "redis.op", outcome: "auth" }));
    expect(m.recordedRedisEvents.filter((e) => e.event === "redis.retry")).toHaveLength(0);
  });
});

describe("nothing sensitive reaches the log", () => {
  it("logs bucket names and outcomes only — no keys, ids, tokens or URLs", async () => {
    const m = await load();
    await setMode("auth");
    await m.checkRateLimit("recordPayment:user-secret-id", 15, 60).catch(() => {});
    await m.getCached("dashboard:admin:college-secret-id:counts", 60, async () => "x");
    const logged = JSON.stringify([
      ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ]);
    expect(logged).not.toMatch(/user-secret-id|college-secret-id|emulator-token|127\.0\.0\.1|WRONGPASS/);
  });
});
