import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  recordRedisMetric,
  routeLabel,
  setRedisMetricsDataset,
  REDIS_METRICS_BINDING,
  type AnalyticsEngineDataset,
} from "@/lib/redis-metrics";
import { emitRedisEvent, metricFor, resetRedisTelemetry, type RedisEvent } from "@/lib/redis-telemetry";

/**
 * Redis metrics (lib/redis-metrics.ts): one Analytics Engine data point per
 * Redis event, unsampled, with a fixed layout and nothing identifying in it.
 */

type Point = { indexes?: string[]; blobs?: string[]; doubles?: number[] };
let points: Point[];
const fake: AnalyticsEngineDataset = { writeDataPoint: (p) => void points.push(p) };

beforeEach(() => {
  points = [];
  setRedisMetricsDataset(fake);
  resetRedisTelemetry();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setRedisMetricsDataset(undefined);
  vi.restoreAllMocks();
});

describe("data point layout", () => {
  it("writes index, six blobs and three doubles in the documented order", () => {
    recordRedisMetric({ metric: "redis.cache", operation: "list:invoices", outcome: "hit", route: "/finance/invoices", ms: 4.2 });
    expect(points).toEqual([
      {
        indexes: ["redis.cache:list:invoices"],
        blobs: ["redis.cache", "list:invoices", "hit", "", expect.any(String), "/finance/invoices"],
        doubles: [4.2, 1, 0],
      },
    ]);
  });

  it("clips long operation names to the Analytics Engine index limit", () => {
    recordRedisMetric({ metric: "redis.command", operation: "x".repeat(300), outcome: "ok" });
    expect(points[0].indexes![0].length).toBeLessThanOrEqual(96);
    expect(points[0].blobs![1].length).toBeLessThanOrEqual(96);
  });

  it("is a no-op without the binding, and never throws when the binding does", () => {
    setRedisMetricsDataset(null);
    expect(() => recordRedisMetric({ metric: "redis.command", operation: "x", outcome: "ok" })).not.toThrow();
    setRedisMetricsDataset({ writeDataPoint: () => { throw new Error("quota"); } });
    expect(() => recordRedisMetric({ metric: "redis.command", operation: "x", outcome: "ok" })).not.toThrow();
  });

  it("finds the binding on the OpenNext context when no override is set", () => {
    setRedisMetricsDataset(undefined);
    const sym = Symbol.for("__cloudflare-context__");
    const g = globalThis as unknown as Record<symbol, unknown>;
    const previous = g[sym];
    g[sym] = { env: { [REDIS_METRICS_BINDING]: fake } };
    try {
      recordRedisMetric({ metric: "redis.command", operation: "cache.read", outcome: "ok" });
      expect(points).toHaveLength(1);
    } finally {
      g[sym] = previous;
    }
  });
});

describe("every event becomes a metric — unsampled", () => {
  it("writes successes even when log sampling is 0, and coalesced failures every time", () => {
    for (let i = 0; i < 50; i++) emitRedisEvent({ event: "redis.cache", family: "dash", outcome: "hit", ms: 1 });
    for (let i = 0; i < 5; i++) emitRedisEvent({ event: "redis.op", op: "cache.read", outcome: "timeout", ms: 1000 });
    expect(points.filter((p) => p.blobs![2] === "hit")).toHaveLength(50);
    expect(points.filter((p) => p.blobs![2] === "timeout")).toHaveLength(5);
    // the log channel coalesced the five identical failures into one line
    expect(vi.mocked(console.warn).mock.calls.length).toBe(1);
  });

  it("maps each event kind to the metric names the dashboards query", () => {
    const cases: [RedisEvent, string, string][] = [
      [{ event: "redis.op", op: "ratelimit", outcome: "circuit_open", ms: 0 }, "redis.command", "circuit_open"],
      [{ event: "redis.retry", op: "request" }, "redis.retry", "retry"],
      [{ event: "redis.circuit", state: "open" }, "redis.circuit", "open"],
      [{ event: "redis.ratelimit", bucket: "recordPayment", outcome: "denied", ms: 3 }, "redis.rate_limit", "denied"],
      [{ event: "redis.cache", family: "list:fees", outcome: "stale_version", ms: 2 }, "redis.cache", "stale"],
      [{ event: "redis.cache", family: "list:fees", outcome: "stored", ms: 2, bytes: 812 }, "redis.cache", "stored"],
      [{ event: "redis.cache", family: "list:fees", outcome: "bypass", reason: "uncacheable_query" }, "redis.cache", "bypass"],
    ];
    for (const [event, metric, outcome] of cases) {
      const m = metricFor(event);
      expect([m.metric, m.outcome]).toEqual([metric, outcome]);
    }
    expect(metricFor(cases[5][0]).bytes).toBe(812);
  });
});

describe("nothing identifying is ever written", () => {
  it("route labels keep at most two segments and drop anything id-like", () => {
    expect(routeLabel("/finance/invoices")).toBe("/finance/invoices");
    expect(routeLabel("/finance/invoices/4f6c1e2a-9b7d-4c1e-8a2b-100000000000")).toBe("/finance/invoices");
    expect(routeLabel("/student/12345/fees")).toBe("/student/:id");
    expect(routeLabel("/4f6c1e2a-9b7d-4c1e-8a2b-100000000000")).toBe("/:id");
    expect(routeLabel("/")).toBe("/");
    expect(routeLabel("/auth/" + "a".repeat(64))).toBe("/auth/:id");
  });

  it("events carry names only: no key, id or value reaches a data point", () => {
    // These are the shapes every call site emits (lib/cache.ts, lib/rate-limit.ts, lib/redis-guard.ts).
    emitRedisEvent({ event: "redis.ratelimit", bucket: "recordPayment", outcome: "allowed", ms: 2, route: "/finance/transactions" });
    emitRedisEvent({ event: "redis.cache", family: "list:invoices", outcome: "stored", bytes: 4096, ms: 3 });
    const text = JSON.stringify(points);
    for (const forbidden of ["nexus:", "user-", "college-", "@", "http"]) expect(text).not.toContain(forbidden);
  });
});
