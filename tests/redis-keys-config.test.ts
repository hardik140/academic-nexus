import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_REDIS_TIMEOUT_MS,
  keyDigest,
  redisBuildId,
  redisNamespace,
  redisTimeoutMs,
  resolveRedisEnvironment,
} from "@/lib/redis-config";
import { listCacheKey, MAX_CACHED_SEARCH_LENGTH } from "@/lib/cached-list";
import { unscopedSegment } from "@/lib/cache";
import type { DataTableQuery } from "@/components/ui/data-table";

const env = (vars: Record<string, string | undefined>) => vars as unknown as NodeJS.ProcessEnv;

describe("which environment's keys a process may touch", () => {
  it.each([
    [{ NODE_ENV: "production" }, "production"],
    [{ NODE_ENV: "development" }, "development"],
    [{ NODE_ENV: "test" }, "test"],
    [{ NODE_ENV: "production", REDIS_ENV: "preview" }, "preview"],
    [{ NODE_ENV: "production", REDIS_ENV: "e2e" }, "e2e"],
    [{ NODE_ENV: "development", REDIS_ENV: "staging" }, "staging"],
  ])("%o -> %s", (vars, expected) => {
    expect(resolveRedisEnvironment(env(vars))).toEqual({ ok: true, environment: expected });
  });

  it.each([
    [{ NODE_ENV: "test", REDIS_ENV: "production" }],
    [{ NODE_ENV: "development", REDIS_ENV: "production" }],
    [{ NODE_ENV: undefined, REDIS_ENV: "production" }],
  ])("REFUSES the production namespace outside a production build: %o", (vars) => {
    expect(resolveRedisEnvironment(env(vars)).ok).toBe(false);
  });

  it("reads NODE_ENV through the literal Next inlines, so a built Worker always knows it is production", () => {
    // Through `env.NODE_ENV` only, a Worker whose runtime process.env has no
    // NODE_ENV would refuse the production namespace and disable Redis.
    const src = readFileSync("lib/redis-config.ts", "utf8");
    expect(src).toMatch(/env === process\.env \? process\.env\.NODE_ENV : env\.NODE_ENV/);
  });

  it("refuses an unknown environment rather than guessing", () => {
    expect(resolveRedisEnvironment(env({ NODE_ENV: "production", REDIS_ENV: "prod" })).ok).toBe(false);
    expect(resolveRedisEnvironment(env({ NODE_ENV: "production", REDIS_ENV: "production:x" })).ok).toBe(false);
  });

  it("THIS test run is not in the production namespace", () => {
    const resolved = resolveRedisEnvironment();
    expect(resolved.ok && resolved.environment).not.toBe("production");
  });

  it("the E2E server blanks every local credential and pins the e2e namespace", () => {
    const config = readFileSync("playwright.config.ts", "utf8");
    expect(config).toMatch(/\.\.\.blankedLocalEnvKeys\(\)/);
    expect(config).toMatch(/REDIS_ENV: "e2e"/);
    expect(config).not.toMatch(/REDIS_ENV: "production"/);
    expect(config).not.toMatch(/UPSTASH_REDIS_REST_(URL|TOKEN): "[^"]+"/);
  });

  it("namespaces every key by environment and application", () => {
    expect(redisNamespace("production")).toBe("production:nexus");
    expect(redisNamespace("development")).not.toBe(redisNamespace("production"));
  });
});

describe("timeout budget", () => {
  it("defaults to 1000 ms", () => {
    expect(redisTimeoutMs(env({}))).toBe(DEFAULT_REDIS_TIMEOUT_MS);
    expect(DEFAULT_REDIS_TIMEOUT_MS).toBe(1000);
  });
  it("is configurable but clamped to 100–5000 ms", () => {
    expect(redisTimeoutMs(env({ REDIS_TIMEOUT_MS: "750" }))).toBe(750);
    expect(redisTimeoutMs(env({ REDIS_TIMEOUT_MS: "5" }))).toBe(100);
    expect(redisTimeoutMs(env({ REDIS_TIMEOUT_MS: "60000" }))).toBe(5000);
    expect(redisTimeoutMs(env({ REDIS_TIMEOUT_MS: "soon" }))).toBe(1000);
  });
});

describe("build id", () => {
  it("accepts a short alphanumeric id and nothing else", () => {
    expect(redisBuildId("a1b2c3d4e5f6")).toBe("a1b2c3d4e5f6");
    expect(redisBuildId("has:colon")).toBe("local");
    expect(redisBuildId("")).toBe("local");
    expect(redisBuildId(undefined)).toBe("local");
  });

  it("reads the build id through the literal Next inlines at build time", () => {
    // `env.NEXT_PUBLIC_…` through a parameter is not inlined; the deployed
    // Worker would then read "local" for every build. Pinned on the source.
    const src = readFileSync("lib/redis-config.ts", "utf8");
    expect(src).toMatch(/= process\.env\.NEXT_PUBLIC_REDIS_BUILD_ID\)/);
  });
});

// ---------------------------------------------------------------------------
// List keys: user input never shapes a key
// ---------------------------------------------------------------------------

const COLLEGE_A = "11111111-1111-4111-8111-111111111111";
const COLLEGE_B = "22222222-2222-4222-8222-222222222222";
const q = (over: Partial<DataTableQuery> = {}): DataTableQuery => ({ search: "", sortKey: null, sortDir: "asc", page: 0, ...over });

describe("list cache keys", () => {
  it("gives the empty search its own token", () => {
    expect(listCacheKey("list:fees", COLLEGE_A, q(), "due_date")).toBe(`list:fees:${COLLEGE_A}:0:due_date:asc:-`);
  });

  it("never contains the raw search, whatever it is", () => {
    for (const search of ["tuition", "a:b:c", "x y", "स्नातक", "😀 fees", "'; DROP TABLE", "undefined", "null"]) {
      const key = listCacheKey("list:fees", COLLEGE_A, q({ search }), "due_date")!;
      expect(key).not.toContain(search);
      expect(unscopedSegment(key)).toBeNull();
      expect(key.split(":")).toHaveLength(7);
    }
  });

  it("does not fold case or whitespace — the key describes the query that actually runs", () => {
    const k = (search: string) => listCacheKey("list:fees", COLLEGE_A, q({ search }), "due_date");
    expect(k("Fees")).not.toBe(k("fees"));
    expect(k(" fees")).not.toBe(k("fees"));
    expect(k(" ")).not.toBe(k(""));
  });

  it("treats canonically-equal Unicode as the same search", () => {
    const composed = "é";
    const decomposed = "é";
    expect(listCacheKey("p", COLLEGE_A, q({ search: composed }), "c")).toBe(listCacheKey("p", COLLEGE_A, q({ search: decomposed }), "c"));
  });

  it("caches a search up to the cap and refuses to cache a longer one", () => {
    const atCap = "a".repeat(MAX_CACHED_SEARCH_LENGTH);
    expect(listCacheKey("p", COLLEGE_A, q({ search: atCap }), "c")).not.toBeNull();
    expect(listCacheKey("p", COLLEGE_A, q({ search: atCap + "a" }), "c")).toBeNull();
    expect(listCacheKey("p", COLLEGE_A, q({ search: "a".repeat(100_000) }), "c")).toBeNull();
  });

  it("refuses to cache an invalid page or sort direction (a directly-callable Server Action)", () => {
    expect(listCacheKey("p", COLLEGE_A, q({ page: -1 }), "c")).toBeNull();
    expect(listCacheKey("p", COLLEGE_A, q({ page: 1.5 }), "c")).toBeNull();
    expect(listCacheKey("p", COLLEGE_A, q({ page: Number.NaN }), "c")).toBeNull();
    expect(listCacheKey("p", COLLEGE_A, q({ page: 1e9 }), "c")).toBeNull();
    expect(listCacheKey("p", COLLEGE_A, q({ sortDir: "sideways" as "asc" }), "c")).toBeNull();
    expect(listCacheKey("p", COLLEGE_A, q({ search: 42 as unknown as string }), "c")).toBeNull();
  });

  it("separates colleges, scopes and searches", () => {
    const keys = new Set([
      listCacheKey("p", COLLEGE_A, q({ search: "x" }), "c"),
      listCacheKey("p", COLLEGE_B, q({ search: "x" }), "c"),
      listCacheKey("p", "warden-user-1", q({ search: "x" }), "c"),
      listCacheKey("p", COLLEGE_A, q({ search: "y" }), "c"),
    ]);
    expect(keys.size).toBe(4);
  });

  it("digests are stable and short", () => {
    expect(keyDigest("203.0.113.9")).toBe(keyDigest("203.0.113.9"));
    expect(keyDigest("203.0.113.9")).toHaveLength(32);
    expect(keyDigest("203.0.113.9")).not.toContain("203");
  });
});

describe("the scope guard", () => {
  it.each([
    "dashboard:finance:undefined:fee-stats",
    "dashboard:finance:null:fee-stats",
    "dashboard:finance::fee-stats",
    "dashboard:finance: :fee-stats",
    "list:fees:NaN:0",
    "list:fees:a b:0",
    "x".repeat(201),
  ])("rejects %s", (key) => {
    expect(unscopedSegment(key)).not.toBeNull();
  });

  it("accepts a well-formed key", () => {
    expect(unscopedSegment(`list:fees:${COLLEGE_A}:0:due_date:asc:-`)).toBeNull();
  });
});
