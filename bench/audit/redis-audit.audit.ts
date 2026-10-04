import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";

/**
 * Redis architecture audit — measurements.
 *
 * Runs the REAL application Redis code (lib/redis.ts, lib/redis-guard.ts,
 * lib/rate-limit.ts, lib/cache.ts, @upstash/redis, @upstash/ratelimit)
 * against the local Upstash emulator (e2e/support/upstash-emulator.mjs).
 *
 * WHAT THESE NUMBERS ARE: command counts, HTTP round trips, failure
 * behaviour and timing of the application's own code path. Command and
 * round-trip counts are properties of the code and transfer to production.
 * Latency, throughput and saturation numbers are LOCAL (loopback, a
 * single-threaded JS stand-in) and say nothing about Upstash itself.
 *
 * Results: bench/results/redis-audit.json.
 * Run: npx vitest run --config vitest.audit.config.ts
 */

const results: Record<string, unknown> = {
  note: "LOCAL measurements against the Upstash emulator on loopback. Counts transfer to production; latencies and throughput do not.",
};
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
const setMode = (mode: string, delayMs = 0, failRate = 0) => control("/__mode", { mode, delayMs, failRate });
const raw = async (cmd: unknown[]) =>
  (await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: JSON.stringify(cmd) })).json();

interface Snap {
  requests: number;
  commands: Record<string, number>;
  bytesIn: number;
  bytesOut: number;
}
const snap = async (): Promise<Snap> => control("/__state");
function diff(a: Snap, b: Snap) {
  const commands: Record<string, number> = {};
  for (const [k, v] of Object.entries(b.commands)) if (v - (a.commands[k] ?? 0)) commands[k] = v - (a.commands[k] ?? 0);
  return {
    httpRoundTrips: b.requests - a.requests,
    commands,
    commandTotal: Object.values(commands).reduce((s, v) => s + v, 0),
    bytesIn: b.bytesIn - a.bytesIn,
    bytesOut: b.bytesOut - a.bytesOut,
  };
}
async function counted(fn: () => Promise<unknown>) {
  const a = await snap();
  await fn();
  return diff(a, await snap());
}

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
  mkdirSync("bench/results", { recursive: true });
  const path = "bench/results/redis-audit.json";
  // Merge, so a filtered run (-t) or another audit file keeps the other sections.
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  writeFileSync(path, JSON.stringify({ ...previous, ...results, generatedAt: new Date().toISOString() }, null, 2) + "\n");
});

async function load() {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("REDIS_ENV", "test");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", `http://127.0.0.1:${port}`);
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "emulator-token");
  vi.stubEnv("REDIS_TIMEOUT_MS", ""); // the production default (1000 ms)
  const rateLimit = await import("@/lib/rate-limit");
  const cache = await import("@/lib/cache");
  const guard = await import("@/lib/redis-guard");
  const config = await import("@/lib/redis-config");
  const telemetry = await import("@/lib/redis-telemetry");
  guard.resetRedisGuard();
  telemetry.resetRedisTelemetry();
  telemetry.recordRedisEvents(true);
  return { ...rateLimit, ...cache, ...guard, ...config, ...telemetry };
}
type M = Awaited<ReturnType<typeof load>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function pct(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10;
}
function summary(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: Math.round(s[s.length - 1] ?? 0) };
}

beforeEach(async () => {
  await control("/__reset");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** The middleware's Redis sequence for a signed-in request (lib/supabase/middleware.ts). */
async function middlewareSignedIn(m: M, userId: string, ipDigest: string, profileFetch: () => Promise<unknown>) {
  await m.checkRateLimit(`ipCredentialed:${ipDigest}`, 2000, 60);
  // getUser() happens here (Supabase Auth, not Redis)
  await m.checkRateLimit(`user:${userId}`, 300, 60);
  return m.getCached(m.middlewareProfileCacheKey(userId), 20, profileFetch, m.MIDDLEWARE_PROFILE_CACHE);
}

describe("17/18. Redis commands and round trips per request path", () => {
  it("measures each path", async () => {
    const m = await load();
    const prof = async () => ({ role: "finance", college_id: "c1", status: "active" });
    const list = async () => ({ data: Array.from({ length: 25 }, (_, i) => ({ id: i })), count: 25 });
    const key = m.versionedKey("list:invoices:c1:0:due_date:desc:-", "list:invoices", "c1")!;
    const out: Record<string, unknown> = {};

    out["rate limit, one check"] = await counted(() => m.checkRateLimit("recordPayment:u1", 30, 60));
    out["anonymous request (middleware)"] = await counted(() => m.checkRateLimit("ip:abc", 100, 60));
    out["signed-in page, profile cache cold"] = await counted(() => middlewareSignedIn(m, "u2", "ipd", prof));
    out["signed-in page, profile cache warm"] = await counted(() => middlewareSignedIn(m, "u2", "ipd", prof));
    out["versioned cached read, miss"] = await counted(() => m.getCached(key, 30, list));
    out["versioned cached read, hit"] = await counted(() => m.getCached(key, 30, list));
    out["plain cached read, miss"] = await counted(() => m.getCached("dashboard:director:c1:counts", 60, list));
    out["plain cached read, hit"] = await counted(() => m.getCached("dashboard:director:c1:counts", 60, list));
    out["family invalidation"] = await counted(() => m.invalidateCacheFamily("list:invoices", "c1"));
    out["server action: middleware (warm) + action bucket + warm list read + invalidation"] = await counted(async () => {
      await middlewareSignedIn(m, "u2", "ipd", prof);
      await m.checkRateLimit("createInvoice:u2", 20, 60);
      await m.getCached(key, 30, list);
      await m.invalidateCacheFamily("list:invoices", "c1");
    });
    out["three cached reads issued in parallel (auto-pipelining)"] = await counted(() =>
      Promise.all([
        m.getCached("a:c1:x", 60, list),
        m.getCached("b:c1:y", 60, list),
        m.getCached("c:c1:z", 60, list),
      ])
    );
    out["two limiter checks issued in parallel"] = await counted(() =>
      Promise.all([m.checkRateLimit("ipCredentialed:p", 2000, 60), m.checkRateLimit("user:p", 300, 60)])
    );
    results.roundTrips = out;
    const warm = out["signed-in page, profile cache warm"] as { httpRoundTrips: number };
    expect(warm.httpRoundTrips).toBe(3);
  });
});

describe("10. Cache stampede", () => {
  it("100 concurrent readers of a cold, an invalidated, and an expired entry", async () => {
    const m = await load();
    await setMode("slow", 5); // a little network time so the requests genuinely overlap
    let calls = 0;
    const fetcher = async () => {
      calls++;
      await sleep(50); // the database query
      return { rows: Array.from({ length: 25 }, (_, i) => ({ id: i, name: "row" + i })) };
    };
    const key = m.versionedKey("list:fees:c1:0:due_date:desc:-", "list:fees", "c1")!;
    const wave = async () => {
      calls = 0;
      const t = performance.now();
      await Promise.all(Array.from({ length: 100 }, () => m.getCached(key, 30, fetcher)));
      return { dbQueries: calls, wallMs: Math.round(performance.now() - t) };
    };
    const cold = await wave();
    const warm = await wave();
    await m.invalidateCacheFamily("list:fees", "c1");
    const afterInvalidation = await wave();

    // The same three waves through an in-process single-flight wrapper
    // (a prototype, not application code): concurrent misses in one isolate share one fetch.
    const inflight = new Map<string, Promise<unknown>>();
    const singleFlight = <T,>(k: string, f: () => Promise<T>) => {
      const existing = inflight.get(k) as Promise<T> | undefined;
      if (existing) return existing;
      const p = f().finally(() => inflight.delete(k));
      inflight.set(k, p);
      return p;
    };
    await m.invalidateCacheFamily("list:fees", "c1");
    calls = 0;
    await Promise.all(Array.from({ length: 100 }, () => singleFlight("list:fees:c1:0", () => m.getCached(key, 30, fetcher))));
    const singleFlightAfterInvalidation = { dbQueries: calls };

    results.stampede = {
      readers: 100,
      cold,
      warm,
      afterInvalidation,
      singleFlightAfterInvalidation,
      note: "No stampede protection exists: every concurrent miss runs the database query. Single-flight is per isolate only; Workers run many isolates.",
    };
    expect(cold.dbQueries).toBe(100);
    expect(warm.dbQueries).toBe(0);
  });
});

describe("9/12. Invalidation races", () => {
  it("an exact-key DEL loses to an in-flight read; a version bump does not", async () => {
    const m = await load();
    let dbStatus = "active";
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    // PLAIN KEY (the middleware profile entry): read starts, fetches the
    // OLD row, the writer commits and deletes the key, then the read stores
    // the old row it already fetched.
    const profileKey = m.middlewareProfileCacheKey("victim");
    const slowRead = m.getCached(
      profileKey,
      20,
      async () => {
        const seen = dbStatus;
        await gate;
        return { role: "finance", college_id: "c1", status: seen };
      },
      m.MIDDLEWARE_PROFILE_CACHE
    );
    await sleep(20);
    dbStatus = "suspended";
    await m.invalidateCache(profileKey, m.MIDDLEWARE_PROFILE_CACHE);
    release();
    await slowRead;
    const after = await m.getCached(
      profileKey,
      20,
      async () => ({ role: "finance", college_id: "c1", status: dbStatus }),
      m.MIDDLEWARE_PROFILE_CACHE
    );

    // VERSIONED KEY: same interleaving.
    let rows = "old";
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => (release2 = r));
    const vk = m.versionedKey("list:refunds:c1", "list:refunds", "c1")!;
    const slowRead2 = m.getCached(vk, 30, async () => {
      const seen = rows;
      await gate2;
      return seen;
    });
    await sleep(20);
    rows = "new";
    await m.invalidateCacheFamily("list:refunds", "c1");
    release2();
    await slowRead2;
    const after2 = await m.getCached(vk, 30, async () => rows);

    results.invalidationRace = {
      plainKeyDel: { statusInDatabase: dbStatus, statusServedFromCache: (after as { status: string }).status, staleForUpToSeconds: 20 },
      versionedFamily: { inDatabase: rows, served: after2 },
      note: "Every non-versioned key (8 exact DELs, 18 TTL-only reads) can resurrect a pre-write value for one TTL. For the profile entry this is routing only; admission and requireRole() are uncached.",
    };
    expect((after as { status: string }).status).toBe("active"); // the stale value survived the DEL
    expect(after2).toBe("new");
  });
});

describe("7/34. Rate-limit concurrency and identity", () => {
  it("300 parallel requests against a limit of 100", async () => {
    const m = await load();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 300 }, () => m.checkRateLimit("recordPayment:burst", 100, 60))
    );
    const allowed = outcomes.filter((o) => o.status === "fulfilled").length;
    const limited = outcomes.filter((o) => o.status === "rejected" && o.reason instanceof m.RateLimitError).length;
    const s = await snap();
    results.rateLimitConcurrency = {
      parallel: 300,
      limit: 100,
      allowed,
      limited,
      redisCommands: s.commands,
      httpRoundTrips: s.requests,
      note: "Atomic in the emulator because it is single-threaded; in Upstash the same script is atomic because Lua runs to completion. The library's in-memory ephemeral cache refuses already-blocked identifiers without Redis.",
    };
    expect(allowed).toBe(100);
  });

  it("a NAT'd campus at the morning login peak", async () => {
    const m = await load();
    // Anonymous: every unauthenticated request from the campus shares ip:<digest>.
    const campus = m.keyDigest("203.0.113.7");
    let anonymousAllowed = 0;
    for (let i = 0; i < 400; i++) {
      try {
        await m.checkRateLimit(`ip:${campus}`, 100, 60);
        anonymousAllowed++;
      } catch {
        /* 429 */
      }
    }
    results.natCampus = {
      anonymousRequestsInOneMinute: 400,
      anonymousAllowed,
      note: "Each browser login costs several anonymous requests (GET /login, its RSC/prefetch requests, the post-login redirect) before the session cookie exists. At 3-4 requests per login the shared bucket admits about 25-33 logins per minute per campus IP. Supabase Auth's own per-IP sign-in limit applies on top and is unread.",
    };
    expect(anonymousAllowed).toBe(100);
  });
});

const CLASSES: Array<{ label: string; run: (m: M) => Promise<unknown> }> = [
  { label: "flood (middleware ip)", run: (m) => m.checkRateLimit("ip:x", 100, 60) },
  { label: "low (submitComplaint)", run: (m) => m.checkRateLimit("submitComplaint:u", 5, 60) },
  { label: "high (recordPayment, finance)", run: (m) => m.checkRateLimit("recordPayment:u", 15, 60) },
  { label: "high (actOnGatePass, gate/approval)", run: (m) => m.checkRateLimit("actOnGatePass:u", 30, 60) },
  { label: "protected (revokeSession, identity)", run: (m) => m.checkRateLimit("revokeSession:u", 30, 60) },
  { label: "protected (timetable, academic)", run: (m) => m.checkRateLimit("timetable:u", 60, 60) },
  { label: "unknown bucket", run: (m) => m.checkRateLimit("brandNewAction:u", 10, 60) },
  {
    label: "cached read (versioned)",
    run: (m) => m.getCached(m.versionedKey("list:x:c1", "list:x", "c1"), 30, async () => "from-db"),
  },
];

function describeOutcome(m: M, r: PromiseSettledResult<unknown>): string {
  if (r.status === "fulfilled") return r.value === "from-db" ? "served (database)" : "allowed";
  if (r.reason instanceof m.RateLimiterUnavailableError) return "refused 503";
  if (r.reason instanceof m.RateLimitError) return "429";
  return "THREW " + String((r.reason as Error)?.name);
}

describe("29/35. Failure-mode matrix (budget 1000 ms, production default)", () => {
  it("every failure mode against every class", async () => {
    const modes: Array<{ label: string; mode: string; delayMs?: number; failRate?: number }> = [
      { label: "healthy", mode: "healthy" },
      { label: "100 ms latency", mode: "slow", delayMs: 100 },
      { label: "500 ms latency", mode: "slow", delayMs: 500 },
      { label: "1 s latency", mode: "slow", delayMs: 1000 },
      { label: "2 s latency", mode: "slow", delayMs: 2000 },
      { label: "5 s latency", mode: "slow", delayMs: 5000 },
      { label: "unavailable / connection reset", mode: "down" },
      { label: "malformed response", mode: "malformed" },
      { label: "authentication failure", mode: "auth" },
      { label: "random failure (50%)", mode: "flaky", failRate: 0.5 },
    ];
    const matrix: Record<string, Record<string, string>> = {};
    let insecure = 0;
    for (const md of modes) {
      matrix[md.label] = {};
      for (const c of CLASSES) {
        const m = await load();
        await control("/__reset");
        await setMode(md.mode, md.delayMs ?? 0, md.failRate ?? 0);
        const t = performance.now();
        const [r] = await Promise.allSettled([c.run(m)]);
        const ms = Math.round(performance.now() - t);
        const outcome = describeOutcome(m, r);
        matrix[md.label][c.label] = `${outcome} in ${ms} ms`;
        const failClosed = /^(high|protected|unknown)/.test(c.label);
        const healthyish = md.mode === "healthy" || (md.mode === "slow" && (md.delayMs ?? 0) < 1000);
        if (failClosed && !healthyish && outcome === "allowed" && md.mode !== "flaky") insecure++;
        if (ms > 1300) insecure++; // nothing may exceed the budget materially
      }
    }
    await control("/__reset");
    results.failureMatrix = matrix;
    expect(insecure).toBe(0);
  }, 240_000);

  it("circuit breaker: opens, fails instantly, recovers after the cooldown", async () => {
    const m = await load();
    await setMode("down");
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      await Promise.allSettled([m.checkRateLimit("recordPayment:c", 15, 60)]);
      timings.push(Math.round(performance.now() - t));
    }
    const openAfterFailures = m.circuitIsOpen();
    await setMode("healthy");
    const whileOpen = await Promise.allSettled([m.checkRateLimit("recordPayment:c", 15, 60)]);
    await sleep(m.CIRCUIT_COOLDOWN_MS + 200);
    const probe = await Promise.allSettled([m.checkRateLimit("recordPayment:c", 15, 60)]);
    results.circuit = {
      failureTimingsMs: timings,
      openAfter3: openAfterFailures,
      healthyButCircuitOpen: describeOutcome(m, whileOpen[0]),
      afterCooldownProbe: describeOutcome(m, probe[0]),
      closedAfterProbe: !m.circuitIsOpen(),
      note: "Per isolate: each Worker isolate discovers an outage separately (3 failed calls each).",
    };
    expect(openAfterFailures).toBe(true);
    expect(describeOutcome(m, probe[0])).toBe("allowed");
  }, 30_000);

  it("partial pipeline failure, cache corruption and Redis restart", async () => {
    const m = await load();
    const vk = m.versionedKey("list:p:c1", "list:p", "c1")!;
    let fetches = 0;
    const f = async () => {
      fetches++;
      return "fresh";
    };
    await m.getCached(vk, 30, f);
    await setMode("partial");
    await m.invalidateCacheFamily("list:p", "c1"); // INCR applies, EXPIRE fails
    await setMode("healthy");
    await m.getCached(vk, 30, f);
    const partial = { databaseReadsAfterHalfAppliedInvalidation: fetches - 1, note: "INCR landed, so readers miss correctly; the counter is left without a TTL (a few bytes, permanent)." };

    // Corruption / forgery: write values straight into Redis under the keys the app reads.
    const build = m.redisBuildId();
    await raw(["SET", `test:nexus:c:shared:${m.middlewareProfileCacheKey("mallory")}`, JSON.stringify({ role: "admin", college_id: "c9", status: "active" })]);
    const forgedProfile = await m.getCached(m.middlewareProfileCacheKey("mallory"), 20, async () => ({ role: "student", college_id: "c1", status: "active" }), m.MIDDLEWARE_PROFILE_CACHE);
    await raw(["SET", `test:nexus:c:${build}:dashboard:finance:c1:fee-stats`, JSON.stringify({ totalBilled: 1, totalCollected: 999999 })]);
    const forgedStats = await m.getCached("dashboard:finance:c1:fee-stats", 60, async () => ({ totalBilled: 100, totalCollected: 50 }));
    await raw(["SET", `test:nexus:c:${build}:dashboard:admin:c1:counts`, "not json at all"]);
    const garbage = await Promise.allSettled([m.getCached("dashboard:admin:c1:counts", 60, async () => "from-db")]);

    // Restart: data gone.
    await control("/__reset");
    fetches = 0;
    await m.getCached(vk, 30, f);
    const restart = { databaseReadsAfterRestart: fetches, rateLimitCountersReset: true, note: "A restart (or eviction) resets every limiter window: up to one extra window of requests per bucket." };

    results.corruptionAndRestart = {
      partial,
      forgedProfileServed: forgedProfile,
      forgedFeeStatsServed: forgedStats,
      garbageValue: garbage[0].status === "fulfilled" ? { served: garbage[0].value } : { threw: String((garbage[0] as PromiseRejectedResult).reason) },
      restart,
      note: "Cached values carry no integrity check. Anyone holding the Upstash token can make the app display forged data (and route a session by a forged role). Today that token sits in every developer's .env.local, because development and production share one database.",
    };
    expect((forgedProfile as { role: string }).role).toBe("admin");
  });
});

describe("30/31. Load model and client-side saturation (LOCAL)", () => {
  it("N signed-in users open a dashboard at once", async () => {
    const out: Record<string, unknown> = {};
    for (const delay of [0, 20]) {
      for (const users of [100, 500, 1000, 5000]) {
        const m = await load();
        await control("/__reset");
        await setMode(delay ? "slow" : "healthy", delay);
        let dbQueries = 0;
        const db = async (ms: number, v: unknown) => {
          dbQueries++;
          await sleep(ms);
          return v;
        };
        const colleges = Math.max(1, Math.round(users / 500));
        const outcome = { ok: 0, limited: 0, unavailable: 0 };
        const page = async (i: number) => {
          const college = `c${i % colleges}`;
          const t = performance.now();
          try {
            await middlewareSignedIn(m, `u${i}`, m.keyDigest(`nat-${college}`), () => db(15, { role: "director", college_id: college, status: "active" }));
            await m.getCached(m.versionedKey(`dashboard:director:${college}:counts`, "dash", college), 60, () => db(80, { students: 1 }));
            outcome.ok++;
          } catch (e) {
            if (e instanceof m.RateLimitError) outcome.limited++;
            else outcome.unavailable++;
          }
          return performance.now() - t;
        };
        const wave = async () => {
          const a = await snap();
          dbQueries = 0;
          const t = performance.now();
          const ms = await Promise.all(Array.from({ length: users }, (_, i) => page(i)));
          const wall = performance.now() - t;
          const d = diff(a, await snap());
          const events = [...m.recordedRedisEvents] as unknown as Array<Record<string, unknown>>;
          const failures: Record<string, number> = {};
          for (const e of events) {
            if (e.event === "redis.op" && e.outcome !== "ok") failures[String(e.outcome)] = (failures[String(e.outcome)] ?? 0) + Number(e.count ?? 1);
            if (e.event === "redis.circuit") failures["circuit_" + String(e.state)] = (failures["circuit_" + String(e.state)] ?? 0) + 1;
          }
          m.resetRedisTelemetry();
          m.recordRedisEvents(true);
          return {
            redisFailures: failures,
            circuitOpenAtEnd: m.circuitIsOpen(),
            latencyMs: summary(ms),
            wallMs: Math.round(wall),
            requestsPerSecond: Math.round(users / (wall / 1000)),
            redisCommands: d.commandTotal,
            redisHttpRoundTrips: d.httpRoundTrips,
            commandsPerRequest: Math.round((d.commandTotal / users) * 100) / 100,
            dbQueries,
            dbQueriesPerRequest: Math.round((dbQueries / users) * 100) / 100,
          };
        };
        const cold = await wave();
        const coldOutcome = { ...outcome };
        outcome.ok = outcome.limited = outcome.unavailable = 0;
        const warm = await wave();
        out[`${users} users, emulator +${delay} ms`] = { colleges, cold, coldOutcome, warm, warmOutcome: { ...outcome } };
      }
    }
    await control("/__reset");
    results.loadModel = {
      model: "Each user: middleware (ipCredentialed per campus NAT, per-user bucket, profile cache) + one college-scoped dashboard read. One NAT address per 500 users. Database = sleep (15 ms profile, 80 ms dashboard). Two waves: cold, then warm within TTL.",
      runs: out,
    };
  }, 600_000);

  it("concurrency sweep: where the client + stand-in stop scaling", async () => {
    const m = await load();
    const sweep: Record<string, unknown> = {};
    for (const conc of [1, 10, 50, 100, 250, 500, 1000]) {
      const lat: number[] = [];
      const a = await snap();
      const t0 = performance.now();
      const until = t0 + 2000;
      await Promise.all(
        Array.from({ length: conc }, async (_, w) => {
          while (performance.now() < until) {
            const t = performance.now();
            await m.getCached(`sat:c1:k${w % 50}`, 60, async () => "v");
            lat.push(performance.now() - t);
          }
        })
      );
      const secs = (performance.now() - t0) / 1000;
      const d = diff(a, await snap());
      sweep[`${conc} concurrent`] = {
        opsPerSecond: Math.round(lat.length / secs),
        latencyMs: summary(lat),
        commandsPerHttpRoundTrip: Math.round((d.commandTotal / Math.max(1, d.httpRoundTrips)) * 10) / 10,
      };
    }
    results.saturationSweep = {
      note: "LOCAL: the knee is the Node client + single-threaded stand-in on one machine, NOT Upstash. Auto-pipelining batching (commands per round trip) is a real client property.",
      sweep,
    };
  }, 120_000);
});

describe("19/20. Serialization and payload size", () => {
  it("JSON + base64 cost by payload size, and representative payloads", async () => {
    const row = (i: number) => ({
      id: "4f6c1e2a-9b7d-4c1e-8a2b-" + String(100000000000 + i),
      enrollment_number: "EN2024" + String(i).padStart(5, "0"),
      amount: 45000,
      paid_amount: 20000 + (i % 7) * 1000,
      status: i % 5 ? "pending" : "paid",
      due_date: "2026-11-15",
      created_at: "2026-07-01T10:00:00.000Z",
      students: { enrollment_number: "EN2024" + i, profiles: { full_name: "Student Name " + i } },
    });
    const one = JSON.stringify(row(1)).length;
    const sizes = [1, 10, 50, 100, 500, 1000].map((kb) => {
      const value = Array.from({ length: Math.max(1, Math.round((kb * 1024) / one)) }, (_, i) => row(i));
      const text = JSON.stringify(value);
      const iters = kb >= 500 ? 20 : 200;
      let t = performance.now();
      for (let i = 0; i < iters; i++) JSON.stringify(value);
      const stringifyMs = (performance.now() - t) / iters;
      t = performance.now();
      for (let i = 0; i < iters; i++) JSON.parse(text);
      const parseMs = (performance.now() - t) / iters;
      const b64 = Buffer.from(text).toString("base64");
      t = performance.now();
      for (let i = 0; i < iters; i++) Buffer.from(b64, "base64").toString("utf8");
      const base64DecodeMs = (performance.now() - t) / iters;
      return {
        targetKB: kb,
        actualKB: Math.round(text.length / 102.4) / 10,
        rows: value.length,
        stringifyMs: +stringifyMs.toFixed(3),
        parseMs: +parseMs.toFixed(3),
        base64DecodeMs: +base64DecodeMs.toFixed(3),
        wireKBWithBase64: Math.round(b64.length / 102.4) / 10,
      };
    });

    const kb = (v: unknown) => Math.round(JSON.stringify(v).length / 102.4) / 10;
    const representative = {
      "list page, 25 invoice rows with joins": kb({ data: Array.from({ length: 25 }, (_, i) => row(i)), count: 4000 }),
      "users list page, 25 profile rows (select *)": kb({
        data: Array.from({ length: 25 }, (_, i) => ({
          id: "u" + i, email: `user${i}@college.edu`, full_name: "Name " + i, role: "student", status: "active", college_id: "c", department_id: "d",
          phone: "9999999999", avatar_url: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", departments: { name: "Computer Science" },
        })),
        count: 3000,
      }),
      "risk overview, 12 departments (aggregated before caching)": kb(Array.from({ length: 12 }, (_, i) => ({ departmentId: "d" + i, name: "Department " + i, code: "D" + i, totalStudents: 400, atRisk: 37, critical: 9 }))),
      "finance exceptions, 500 overdue fees with joins": kb({ overdueFees: Array.from({ length: 500 }, (_, i) => row(i)) }),
      "placement records, PostgREST cap of 1000 rows": kb(Array.from({ length: 1000 }, (_, i) => ({ ...row(i), company: "Company " + (i % 40), package_lpa: 6.5 }))),
      "middleware profile entry": kb({ role: "finance", college_id: "4f6c1e2a-9b7d-4c1e-8a2b-100000000000", status: "active" }),
    };
    results.serialization = {
      note: "LOCAL CPU on this machine. Upstash responses are base64-encoded by the client's default, adding about a third to the bytes on the wire.",
      bySize: sizes,
      representativeKB: representative,
    };
  });
});
