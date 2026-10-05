import { it, beforeAll, afterAll, vi, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync, mkdirSync } from "node:fs";
import { NextRequest } from "next/server";
import { makeSigner, claims, sessionCookie, jwksFetch, SUPABASE_URL, type Signer } from "../tests/support/session-tokens";

/**
 * Redis transformation, Phase 2 — before/after measurement. LOCAL.
 *
 *   BENCH_LABEL=before npx vitest run -c vitest.bench.config.ts bench/phase2.bench.ts
 *
 * Runs the REAL middleware (lib/supabase/middleware.ts), the REAL limiter and
 * the REAL cache (lib/cache.ts) against the Upstash emulator, which counts
 * every HTTP round trip and every Redis command. Supabase is a fake that
 * counts Auth calls and database queries.
 *
 * LATENCY IS MODELLED, NOT MEASURED ON A NETWORK. Every Redis answer is
 * delayed by BENCH_REDIS_RTT ms, every database query by BENCH_DB_MS, every
 * Auth call by BENCH_AUTH_MS. Worker → Upstash and Worker → Supabase latency
 * are unmeasured (Phase 0 gate, REDIS_TRANSFORMATION_PHASE0.md), so the
 * defaults below are assumptions; the COUNTS are exact and do not depend on
 * them. Writes bench/results/phase2-<label>.json.
 */

const LABEL = process.env.BENCH_LABEL ?? "branch";
const REDIS_RTT = Number(process.env.BENCH_REDIS_RTT ?? 4);
const DB_MS = Number(process.env.BENCH_DB_MS ?? 10);
const AUTH_MS = Number(process.env.BENCH_AUTH_MS ?? 15);
/** "054": the admission RPC answers { state } only. "058": it also returns the profile. */
const RPC_SHAPE = process.env.BENCH_RPC_SHAPE ?? "054";

const h = vi.hoisted(() => ({ port: 0, auth: 0, db: 0, after: [] as Array<() => unknown> }));
// setTimeout fires in ~15.6 ms steps on Windows; poll a monotonic clock instead.
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const end = performance.now() + ms;
    const tick = () => (performance.now() >= end ? r() : setImmediate(tick));
    tick();
  });

vi.mock("next/server", async (original) => {
  const real = await original<typeof import("next/server")>();
  // Request-scoped background work: run it once the "response" is done,
  // which the bench does explicitly (drainAfter) outside the timed section.
  return { ...real, after: (fn: () => unknown) => void h.after.push(fn) };
});

vi.mock("@supabase/ssr", async (original) => {
  const real = await original<typeof import("@supabase/ssr")>();
  return {
    ...real,
    createServerClient: (_u: string, _k: string, opts: { cookies: { getAll: () => { name: string; value: string }[] } }) => {
      const userId = () => {
        const raw = opts.cookies.getAll().find((c) => c.name.endsWith("-auth-token"))?.value ?? "";
        const json = JSON.parse(Buffer.from(raw.replace(/^base64-/, ""), "base64url").toString() || "{}");
        return JSON.parse(Buffer.from(String(json.access_token ?? "").split(".")[1] ?? "", "base64url").toString() || "{}").sub as string;
      };
      const profile = () => ({ role: "finance", college_id: "0000000c-0000-4000-8000-0000000000c1", status: "active" });
      return {
        auth: {
          getUser: async () => {
            h.auth++;
            await sleep(AUTH_MS);
            return { data: { user: { id: userId() } } };
          },
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              single: async () => {
                h.db++;
                await sleep(DB_MS);
                return { data: profile(), error: null };
              },
              maybeSingle: async () => {
                h.db++;
                await sleep(DB_MS);
                return { data: profile(), error: null };
              },
            }),
          }),
        }),
        rpc: async (fn: string) => {
          h.db++;
          await sleep(DB_MS);
          if (fn !== "register_current_session") return { data: null, error: { code: "PGRST202" } };
          const p = profile();
          return {
            data: RPC_SHAPE === "058" ? { state: "active", role: p.role, college_id: p.college_id, profile_status: p.status } : { state: "active" },
            error: null,
          };
        },
      };
    },
  };
});

let emulator: ChildProcess;
let project: Signer;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      srv.close(() => (typeof a === "object" && a ? resolve(a.port) : reject(new Error("no port"))));
    });
  });
}

const emu = (path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${h.port}${path}`, { method: path === "/__state" ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());

interface Counters {
  requests: number;
  commands: Record<string, number>;
}
async function counters(): Promise<Counters> {
  const s = await emu("/__state");
  return { requests: s.requests, commands: { ...s.commands } };
}
const commandTotal = (c: Counters) => Object.values(c.commands).reduce((a, b) => a + b, 0);

beforeAll(async () => {
  h.port = await freePort();
  emulator = spawn(process.execPath, ["e2e/support/upstash-emulator.mjs", String(h.port)], { stdio: "pipe" });
  await new Promise<void>((resolve) => emulator.stdout!.on("data", (d) => String(d).includes("listening") && resolve()));
  project = await makeSigner("project-key");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("REDIS_ENV", "test");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", `http://127.0.0.1:${h.port}`);
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "emulator-token");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
  const realFetch = globalThis.fetch;
  const keys = jwksFetch([project]);
  vi.stubGlobal("fetch", ((input: string | URL | Request, init?: RequestInit) =>
    String(input).includes("/.well-known/jwks.json") ? keys(input) : realFetch(input, init)) as typeof fetch);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
}, 60_000);
afterAll(() => {
  emulator?.kill();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function fresh() {
  await emu("/__reset");
  await emu("/__rtt", { ms: REDIS_RTT });
  vi.resetModules();
  (await import("@/lib/redis-guard")).resetRedisGuard();
  (await import("@/lib/auth/session-identity")).resetSessionIdentity();
  h.after.length = 0;
}

async function drainAfter() {
  while (h.after.length) await h.after.shift()!();
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
};
const summary = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99) });
const mean = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)) * 100) / 100;

const uid = (n: number) => `0000000c-0000-4000-8000-${String(n).padStart(12, "0")}`;
const results: Record<string, unknown> = {
  label: LABEL,
  model: { redisRttMs: REDIS_RTT, dbMs: DB_MS, authMs: AUTH_MS, rpcShape: RPC_SHAPE },
  note: "LOCAL. Counts are exact; latency is modelled (fixed delays), not a network measurement.",
};

it("middleware: a signed-in page request, cold (first in 20 s) and warm", async () => {
  await fresh();
  const mw = await import("@/lib/supabase/middleware");
  const USERS = 40;
  const PER_USER = 10;
  const cookies = await Promise.all(Array.from({ length: USERS }, (_, n) => project.sign(claims(uid(n + 1))).then(sessionCookie)));
  // Warm the isolate (JWKS, limiter script) so per-request numbers are steady.
  await mw.updateSession(new NextRequest("https://nexus.example/finance/dashboard", { headers: { cookie: sessionCookie(await project.sign(claims(uid(999)))), "cf-connecting-ip": "203.0.113.9" } }));
  await drainAfter();

  const rows: Record<"cold" | "warm", { ms: number[]; requests: number[]; commands: number[]; db: number[]; auth: number[] }> = {
    cold: { ms: [], requests: [], commands: [], db: [], auth: [] },
    warm: { ms: [], requests: [], commands: [], db: [], auth: [] },
  };
  for (let round = 0; round < PER_USER; round++) {
    for (let u = 0; u < USERS; u++) {
      const req = new NextRequest("https://nexus.example/finance/dashboard", {
        headers: { cookie: `${cookies[u]}; nx_device=d${u}`, "cf-connecting-ip": "203.0.113.50" },
      });
      const before = await counters();
      const db0 = h.db;
      const auth0 = h.auth;
      const t = performance.now();
      const res = await mw.updateSession(req);
      const ms = performance.now() - t;
      await drainAfter();
      const after = await counters();
      expect(res.status).toBe(200);
      const row = rows[round === 0 ? "cold" : "warm"];
      row.ms.push(ms);
      row.requests.push(after.requests - before.requests);
      row.commands.push(commandTotal(after) - commandTotal(before));
      row.db.push(h.db - db0);
      row.auth.push(h.auth - auth0);
    }
  }
  const report = (r: (typeof rows)["cold"]) => ({
    latencyMs: summary(r.ms),
    redisRoundTripsPerRequest: mean(r.requests),
    redisCommandsPerRequest: mean(r.commands),
    dbQueriesPerRequest: mean(r.db),
    authCallsPerRequest: mean(r.auth),
  });
  results.middleware = { cold: report(rows.cold), warm: report(rows.warm) };
}, 600_000);

it("cache miss: N concurrent identical reads of one cold key", async () => {
  const out: Record<string, unknown> = {};
  for (const n of [1, 10, 50, 100]) {
    await fresh();
    const { getCached } = await import("@/lib/cache");
    let fetches = 0;
    const fetcher = async () => {
      fetches++;
      await sleep(DB_MS);
      return { rows: 42 };
    };
    const before = await counters();
    const t = performance.now();
    const settled = await Promise.all(Array.from({ length: n }, () => getCached("bench:stampede:c1:kpis", 60, fetcher)));
    const ms = performance.now() - t;
    await drainAfter();
    const after = await counters();
    expect(settled.every((v) => v.rows === 42)).toBe(true);
    out[`concurrent_${n}`] = {
      dbQueries: fetches,
      redisRoundTrips: after.requests - before.requests,
      redisCommands: commandTotal(after) - commandTotal(before),
      wallMs: Math.round(ms),
    };
  }
  results.stampede = out;
}, 600_000);

it("cache: sequential miss then hit latency (distinct keys)", async () => {
  await fresh();
  const { getCached } = await import("@/lib/cache");
  const miss: number[] = [];
  const hit: number[] = [];
  let fetches = 0;
  const before = await counters();
  for (let i = 0; i < 100; i++) {
    const key = `bench:seq:c1:item-${i}`;
    const fetcher = async () => {
      fetches++;
      await sleep(DB_MS);
      return { i };
    };
    let t = performance.now();
    await getCached(key, 60, fetcher);
    miss.push(performance.now() - t);
    await drainAfter();
    t = performance.now();
    await getCached(key, 60, fetcher);
    hit.push(performance.now() - t);
  }
  const after = await counters();
  results.cacheSequential = {
    missLatencyMs: summary(miss),
    hitLatencyMs: summary(hit),
    hitRatio: Math.round(((200 - fetches) / 200) * 100) / 100,
    redisRoundTripsPer200Reads: after.requests - before.requests,
  };
}, 600_000);

it("cache: write-behind miss latency (analytics reads), when available", async () => {
  await fresh();
  const cache = (await import("@/lib/cache")) as Record<string, unknown>;
  const wb = cache.getCachedWriteBehind as undefined | ((k: string, t: number, f: () => Promise<unknown>) => Promise<unknown>);
  if (!wb) {
    results.cacheWriteBehind = "not available in this build (plain getCached miss above applies)";
    return;
  }
  const miss: number[] = [];
  let fetches = 0;
  for (let i = 0; i < 100; i++) {
    const t = performance.now();
    await wb(`bench:wb:c1:item-${i}`, 60, async () => {
      fetches++;
      await sleep(DB_MS);
      return { i };
    });
    miss.push(performance.now() - t);
    await drainAfter(); // the SET runs here, after the timed "response"
  }
  let hits = 0;
  for (let i = 0; i < 100; i++) await wb(`bench:wb:c1:item-${i}`, 60, async () => (hits--, { i }));
  results.cacheWriteBehind = { missLatencyMs: summary(miss), dbQueries: fetches, laterReadsServedFromCache: 100 + hits };
}, 600_000);

it("invalidation after recording a payment (three cache families)", async () => {
  await fresh();
  const cache = await import("@/lib/cache");
  const families = ["finance:fee-stats", "finance:fees", "finance:payments"];
  const batch = (cache as Record<string, unknown>).invalidateCacheFamilies as undefined | ((f: string[], s: string) => Promise<void>);
  const before = await counters();
  const t = performance.now();
  if (batch) await batch(families, "c1");
  else for (const f of families) await cache.invalidateCacheFamily(f, "c1");
  const ms = performance.now() - t;
  const after = await counters();
  results.paymentInvalidation = { redisRoundTrips: after.requests - before.requests, redisCommands: commandTotal(after) - commandTotal(before), latencyMs: Math.round(ms * 10) / 10 };
});

afterAll(() => {
  mkdirSync("bench/results", { recursive: true });
  writeFileSync(`bench/results/phase2-${LABEL}.json`, JSON.stringify(results, null, 2) + "\n");
});
