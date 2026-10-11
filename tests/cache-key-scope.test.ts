import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listCacheKey } from "@/lib/cached-list";
import type { DataTableQuery } from "@/components/ui/data-table";

/**
 * C-001 — a cache key is a tenancy boundary.
 *
 * Several keys in this codebase are built from an optional value:
 *
 *   `dashboard:finance:${viewerProfile?.college_id}:fee-stats`
 *   `dashboard:hod:${department?.id}:faculty-courses`
 *
 * When the optional is missing, JavaScript writes the literal string
 * `undefined` into the key instead of failing, and every caller in that
 * state shares ONE entry — across users and across colleges. The first
 * arrival decides what everyone else reads.
 *
 * These tests pin the guard that makes that impossible: such a key is never
 * read from and never written to. They do not assert on any particular page,
 * because pages come and go; they assert on the one function all of them
 * funnel through.
 */

/** A Redis stand-in that records what it was actually asked to do. */
function fakeRedis() {
  const store = new Map<string, unknown>();
  const calls: Array<{ op: string; key: string }> = [];
  return {
    store,
    calls,
    client: {
      get: vi.fn(async (key: string) => {
        calls.push({ op: "get", key });
        return store.has(key) ? store.get(key) : null;
      }),
      set: vi.fn(async (key: string, value: unknown) => {
        calls.push({ op: "set", key });
        store.set(key, value);
        return "OK";
      }),
      del: vi.fn(async (key: string) => {
        calls.push({ op: "del", key });
        return store.delete(key) ? 1 : 0;
      }),
      pipeline: () => {
        const p = {
          incr: (key: string) => (calls.push({ op: "incr", key }), p),
          expire: (key: string) => (calls.push({ op: "expire", key }), p),
          exec: async () => [],
        };
        return p;
      },
    },
  };
}

async function loadCache(client: unknown) {
  vi.resetModules();
  vi.doMock("@/lib/redis", () => ({ redis: client }));
  return import("@/lib/cache");
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/redis");
  vi.resetModules();
});

describe("a key with a missing scope segment never reaches Redis", () => {
  it("does not read or write a key containing `undefined`", async () => {
    const redis = fakeRedis();
    const { getCached } = await loadCache(redis.client);

    const value = await getCached("dashboard:finance:undefined:fee-stats", 60, async () => "COLLEGE A DATA");

    // The caller still gets a correct, live answer …
    expect(value).toBe("COLLEGE A DATA");
    // … and nothing was shared through Redis.
    expect(redis.calls).toEqual([]);
    expect(redis.client.get).not.toHaveBeenCalled();
    expect(redis.client.set).not.toHaveBeenCalled();
  });

  it("is the property that matters: two tenants cannot see each other's value", async () => {
    const redis = fakeRedis();
    const { getCached } = await loadCache(redis.client);

    const key = "analytics:director:undefined:mv";
    const a = await getCached(key, 60, async () => "COLLEGE A");
    const b = await getCached(key, 60, async () => "COLLEGE B");

    // Without the guard, b would have been served A's cached value.
    expect(a).toBe("COLLEGE A");
    expect(b).toBe("COLLEGE B");
  });

  it("treats a `null` segment the same way", async () => {
    const redis = fakeRedis();
    const { getCached } = await loadCache(redis.client);
    await getCached("reports:hod:null:mv", 60, async () => 1);
    expect(redis.calls).toEqual([]);
  });

  it("does not bump a shared version counter either", async () => {
    const redis = fakeRedis();
    const { invalidateCacheFamily } = await loadCache(redis.client);
    await invalidateCacheFamily("dashboard:hod", "undefined");
    expect(redis.calls).toEqual([]);
  });

  it("logs the broken key's family so it can be found and fixed — never the key itself", async () => {
    // The family and the bad segment locate the call site; the full key can
    // carry user and college ids, which do not belong in a log line.
    const redis = fakeRedis();
    const { getCached } = await loadCache(redis.client);
    await getCached("dashboard:finance:undefined:fee-stats", 60, async () => 1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("missing scope"),
      { family: "dashboard:finance", segment: "undefined" }
    );
  });
});

describe("a properly scoped key is cached as before", () => {
  const COLLEGE_A = "11111111-1111-4111-8111-111111111111";
  const COLLEGE_B = "22222222-2222-4222-8222-222222222222";

  it("reads through, writes back, and serves the second caller from Redis", async () => {
    const redis = fakeRedis();
    const { getCached } = await loadCache(redis.client);
    const key = `dashboard:finance:${COLLEGE_A}:fee-stats`;

    let fetches = 0;
    const fetcher = async () => {
      fetches += 1;
      return "A";
    };

    expect(await getCached(key, 60, fetcher)).toBe("A");
    expect(await getCached(key, 60, fetcher)).toBe("A");
    expect(fetches, "second call should have been served from cache").toBe(1);
    expect(redis.client.set).toHaveBeenCalledOnce();
  });

  it("keeps two colleges in separate entries", async () => {
    const redis = fakeRedis();
    const { getCached } = await loadCache(redis.client);

    const a = await getCached(`dashboard:finance:${COLLEGE_A}:fee-stats`, 60, async () => "A");
    const b = await getCached(`dashboard:finance:${COLLEGE_B}:fee-stats`, 60, async () => "B");
    expect([a, b]).toEqual(["A", "B"]);
  });

  it("an empty search term is a legitimate segment, not a missing one", async () => {
    // An empty search ("nobody typed anything") is the commonest list read
    // and must still be cached. It is written as its own token, "-", rather
    // than an empty trailing segment — the guard now rejects empty segments,
    // because an empty SCOPE segment is the same fault as `undefined`.
    const redis = fakeRedis();
    const { getCached } = await loadCache(redis.client);
    const q: DataTableQuery = { search: "", sortKey: null, sortDir: "asc", page: 1 };
    const key = listCacheKey("fees", COLLEGE_A, q, "due_date");

    expect(key).not.toBeNull();
    expect(key!.endsWith(":-")).toBe(true);
    await getCached(key, 30, async () => "rows");
    expect(redis.client.set).toHaveBeenCalledOnce();
  });
});

describe("the keys this repo builds centrally are scoped", () => {
  it("scopes a list key by college", () => {
    const q: DataTableQuery = { search: "x", sortKey: "name", sortDir: "asc", page: 2 };
    const a = listCacheKey("fees", "college-a", q, "name");
    const b = listCacheKey("fees", "college-b", q, "name");
    expect(a).not.toBe(b);
    expect(a).toContain("college-a");
  });
});

describe("a well-scoped family invalidation does reach Redis (guards the test above)", () => {
  it("bumps the counter for a real college id", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    const redis = fakeRedis();
    const { invalidateCacheFamily } = await loadCache(redis.client);
    await invalidateCacheFamily("dashboard:hod", "college-a");
    expect(redis.calls.map((c) => c.op)).toContain("incr");
    vi.unstubAllEnvs();
  });
});
