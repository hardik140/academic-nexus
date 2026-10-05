import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Redis transformation Phase 2: stampede protection (2.3), write-behind
 * cache fills (2.4) and batched invalidation (2.2), on the REAL cache module
 * and @upstash/redis against the local Upstash emulator, which counts every
 * round trip and command. Nothing here reaches Upstash.
 */

const h = vi.hoisted(() => ({ after: [] as Array<() => unknown>, afterThrows: false }));
vi.mock("next/server", async (original) => {
  const real = await original<typeof import("next/server")>();
  return {
    ...real,
    after: (fn: () => unknown) => {
      if (h.afterThrows) throw new Error("`after` was called outside a request scope");
      h.after.push(fn);
    },
  };
});

const TIMEOUT_MS = 300;
let port = 0;
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
const control = (path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: path === "/__state" ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
const state = () => control("/__state") as Promise<{ requests: number; commands: Record<string, number> }>;
const setMode = (mode: string, delayMs = 0) => control("/__mode", { mode, delayMs });

beforeAll(async () => {
  port = await freePort();
  emulator = spawn(process.execPath, ["e2e/support/upstash-emulator.mjs", String(port)], { stdio: "pipe" });
  await new Promise<void>((resolve) => emulator.stdout!.on("data", (d) => String(d).includes("listening") && resolve()));
});
afterAll(() => emulator?.kill());

async function load() {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("REDIS_ENV", "test");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", `http://127.0.0.1:${port}`);
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "emulator-token");
  vi.stubEnv("REDIS_TIMEOUT_MS", String(TIMEOUT_MS));
  const cache = await import("@/lib/cache");
  const guard = await import("@/lib/redis-guard");
  const telemetry = await import("@/lib/redis-telemetry");
  guard.resetRedisGuard();
  telemetry.recordRedisEvents(true);
  return { ...cache, ...guard, ...telemetry };
}

beforeEach(async () => {
  await control("/__reset");
  h.after.length = 0;
  h.afterThrows = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const drainAfter = async () => {
  while (h.after.length) await h.after.shift()!();
};

/** A fetcher that counts calls and resolves when told to (or after `ms`). */
function slowFetcher<T>(value: T, ms = 50) {
  let calls = 0;
  const fn = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, ms));
    return value;
  };
  return { fn, calls: () => calls };
}

describe("stampede protection (Phase 2.3): concurrent misses share one database read", () => {
  it.each([10, 50, 100])("%i concurrent identical misses: ONE fetch, every caller gets the value", async (n) => {
    const m = await load();
    const f = slowFetcher({ kpi: 7 });
    const before = await state();
    const values = await Promise.all(Array.from({ length: n }, () => m.getCached("dashboard:finance:college-a:kpis", 60, f.fn)));
    const after = await state();
    expect(f.calls()).toBe(1);
    expect(values.every((v) => v.kpi === 7)).toBe(true);
    // Every caller still reads Redis once (the reads may share a round trip); ONE write.
    expect(after.commands.SET - (before.commands.SET ?? 0)).toBe(1);
    expect(m.inflightFills()).toBe(0);
    expect(m.recordedRedisEvents.filter((e) => e.event === "redis.cache" && e.outcome === "coalesced")).toHaveLength(n - 1);
  });

  it("then the entry is cached: the next wave is all hits, no fetch", async () => {
    const m = await load();
    const f = slowFetcher(1);
    await Promise.all(Array.from({ length: 20 }, () => m.getCached("dashboard:admin:college-a:counts", 60, f.fn)));
    await Promise.all(Array.from({ length: 20 }, () => m.getCached("dashboard:admin:college-a:counts", 60, f.fn)));
    expect(f.calls()).toBe(1);
  });

  it("different keys never share: another college, another viewer, another page", async () => {
    const m = await load();
    const f = slowFetcher("x");
    await Promise.all([
      m.getCached("dashboard:finance:college-a:kpis", 60, f.fn),
      m.getCached("dashboard:finance:college-b:kpis", 60, f.fn),
      m.getCached("hod-approvals:user-1:college-a", 60, f.fn),
      m.getCached("hod-approvals:user-2:college-a", 60, f.fn),
      m.getCached("list:fees:college-a:p0", 60, f.fn),
      m.getCached("list:fees:college-a:p1", 60, f.fn),
    ]);
    expect(f.calls()).toBe(6);
  });

  it("a read after an invalidation does not join a fill started before it", async () => {
    const m = await load();
    const key = m.versionedKey("list:fees:college-a:p0", "fees", "college-a");
    let release!: () => void;
    let calls = 0;
    const gated = async () => {
      const mine = ++calls;
      if (mine === 1) await new Promise<void>((r) => (release = r));
      return mine;
    };
    const old = m.getCached(key, 60, gated);
    await new Promise((r) => setTimeout(r, 30));
    await m.invalidateCacheFamily("fees", "college-a");
    const fresh = await m.getCached(key, 60, gated);
    release();
    expect(await old).toBe(1);
    expect(fresh).toBe(2); // its own read, at the new version
  });

  it("leader failure: every waiter gets the error, nothing is cached, and the next request recovers", async () => {
    const m = await load();
    let calls = 0;
    const failing = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      throw new Error("database unavailable");
    };
    const settled = await Promise.allSettled(Array.from({ length: 25 }, () => m.getCached("dashboard:director:college-a:counts", 60, failing)));
    expect(calls).toBe(1);
    expect(settled.every((s) => s.status === "rejected" && String(s.reason).includes("database unavailable"))).toBe(true);
    expect(m.inflightFills()).toBe(0);
    expect((await state()).commands.SET ?? 0).toBe(0);
    // Recovery: the database is back.
    const ok = slowFetcher({ ok: true }, 5);
    expect(await m.getCached("dashboard:director:college-a:counts", 60, ok.fn)).toEqual({ ok: true });
    expect(ok.calls()).toBe(1);
  });

  it("a hung database read holds only its own waiters; once it settles the flight is gone", async () => {
    const m = await load();
    const slow = slowFetcher("late", 400);
    const t = Date.now();
    const values = await Promise.all(Array.from({ length: 10 }, () => m.getCached("dashboard:hod:dept-1:faculty-courses", 60, slow.fn)));
    expect(values).toEqual(Array(10).fill("late"));
    expect(slow.calls()).toBe(1);
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(m.inflightFills()).toBe(0);
  });

  it("Redis down: the stampede still reaches the database once", async () => {
    const m = await load();
    await setMode("down");
    const f = slowFetcher("from-db");
    const values = await Promise.all(Array.from({ length: 50 }, () => m.getCached("dashboard:finance:college-a:kpis", 60, f.fn)));
    expect(values.every((v) => v === "from-db")).toBe(true);
    expect(f.calls()).toBe(1);
    await setMode("healthy");
  });

  it("Redis timing out: same, and nobody waits longer than the Redis budget plus the read", async () => {
    const m = await load();
    await setMode("slow", 1500);
    const f = slowFetcher("from-db", 20);
    const t = Date.now();
    const values = await Promise.all(Array.from({ length: 50 }, () => m.getCached("dashboard:finance:college-a:kpis", 60, f.fn)));
    expect(values.every((v) => v === "from-db")).toBe(true);
    expect(f.calls()).toBe(1);
    expect(Date.now() - t).toBeLessThan(TIMEOUT_MS * 4 + 500);
    await setMode("healthy");
  });

  it("an uncacheable or unscoped key is never coalesced (each caller reads for itself)", async () => {
    const m = await load();
    const f = slowFetcher("x");
    await Promise.all(Array.from({ length: 5 }, () => m.getCached(null, 60, f.fn)));
    await Promise.all(Array.from({ length: 5 }, () => m.getCached("dashboard:finance:undefined:kpis", 60, f.fn)));
    expect(f.calls()).toBe(10);
  });
});

describe("write-behind fills (Phase 2.4)", () => {
  it("the response does not wait for the SET; it lands after the response", async () => {
    const m = await load();
    const f = slowFetcher({ n: 1 }, 1);
    const before = await state();
    expect(await m.getCachedWriteBehind("analytics:director:college-a:mv", 60, f.fn)).toEqual({ n: 1 });
    expect((await state()).commands.SET ?? 0).toBe(before.commands.SET ?? 0);
    expect(h.after).toHaveLength(1);
    await drainAfter();
    expect((await state()).commands.SET).toBe((before.commands.SET ?? 0) + 1);
    expect(await m.getCachedWriteBehind("analytics:director:college-a:mv", 60, f.fn)).toEqual({ n: 1 });
    expect(f.calls()).toBe(1);
  });

  it("outside a request there is nowhere to defer to: it writes before returning", async () => {
    const m = await load();
    h.afterThrows = true;
    const f = slowFetcher(5, 1);
    await m.getCachedWriteBehind("analytics:director:college-a:mv", 60, f.fn);
    expect((await state()).commands.SET).toBe(1);
  });

  it("a late write of a versioned entry, landing after an invalidation, is never served", async () => {
    const m = await load();
    const key = m.versionedKey("list:courses:college-a:p0", "courses", "college-a");
    let n = 0;
    const f = async () => ++n;
    expect(await m.getCachedWriteBehind(key, 60, f)).toBe(1);
    await m.invalidateCacheFamily("courses", "college-a"); // a write happened meanwhile
    await drainAfter(); // the old fill lands now, stamped with the old version
    expect(await m.getCachedWriteBehind(key, 60, f)).toBe(2);
  });

  it("plain getCached still writes before it returns", async () => {
    const m = await load();
    await m.getCached("dashboard:finance:college-a:kpis", 60, async () => 1);
    expect(h.after).toHaveLength(0);
    expect((await state()).commands.SET).toBe(1);
  });

  it("only analytics, catalog and count reads use it — never finance, approvals, security, lifecycle or authorization", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(e) && readFileSync(full, "utf8").includes("getCachedWriteBehind(")) files.push(full.split("\\").join("/"));
      }
    };
    walk("app");
    expect(files.sort()).toEqual(
      [
        "app/(portal)/admin/courses/actions.ts",
        "app/(portal)/admin/dashboard/page.tsx",
        "app/(portal)/director/analytics/page.tsx",
        "app/(portal)/director/dashboard/actions.ts",
        "app/(portal)/director/departments/performance/actions.ts",
        "app/(portal)/director/faculty/actions.ts",
        "app/(portal)/director/placement-cell/actions.ts",
        "app/(portal)/director/placements/actions.ts",
        "app/(portal)/director/placements/funnel/actions.ts",
        "app/(portal)/hod/dashboard/page.tsx",
        "app/(portal)/hod/faculty/actions.ts",
        "app/(portal)/hod/reports/page.tsx",
        "app/(portal)/placement-cell/companies/actions.ts",
        "app/(portal)/placement-cell/dashboard/actions.ts",
        "app/(portal)/placement-cell/drives/actions.ts",
        "app/(portal)/placement-cell/records/actions.ts",
        "app/(portal)/placement-cell/reports/actions.ts",
        "app/(portal)/warden/dashboard/page.tsx",
        "app/(portal)/warden/rooms/actions.ts",
      ].sort()
    );
    for (const f of files) expect(f).not.toMatch(/finance|approvals|decisions|attention|gatepasses|transfers|complaints|audit|roles|users|super-admin|substitutions|hostel/);
  });
});

describe("batched invalidation (Phase 2.2)", () => {
  it("three families in ONE round trip, and every one of them is invalidated", async () => {
    const m = await load();
    const families = ["finance:fee-stats", "finance:fees", "finance:payments"];
    let n = 0;
    const keys = families.map((f) => m.versionedKey(`${f}:college-a:p0`, f, "college-a"));
    for (const k of keys) await m.getCached(k, 60, async () => ++n);
    const before = await state();
    await m.invalidateCacheFamilies(families, "college-a");
    const after = await state();
    expect(after.requests - before.requests).toBe(1);
    expect(after.commands.INCR - (before.commands.INCR ?? 0)).toBe(3);
    for (const k of keys) expect(await m.getCached(k, 60, async () => "fresh")).toBe("fresh");
  });

  it("another college's entries are untouched", async () => {
    const m = await load();
    const b = m.versionedKey("finance:fees:college-b:p0", "finance:fees", "college-b");
    await m.getCached(b, 60, async () => "b-cached");
    await m.invalidateCacheFamilies(["finance:fees"], "college-a");
    expect(await m.getCached(b, 60, async () => "refetched")).toBe("b-cached");
  });

  it("an unscoped tenant is skipped entirely; Redis down never throws", async () => {
    const m = await load();
    const before = await state();
    await m.invalidateCacheFamilies(["finance:fees"], "undefined");
    expect((await state()).requests).toBe(before.requests);
    await setMode("down");
    await expect(m.invalidateCacheFamilies(["finance:fees"], "college-a")).resolves.toBeUndefined();
    await setMode("healthy");
  });
});
