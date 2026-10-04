import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emitRedisEvent, FAILURE_WINDOW_MS, resetRedisTelemetry } from "@/lib/redis-telemetry";

describe("Redis telemetry", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetRedisTelemetry();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("writes every distinct failure", () => {
    emitRedisEvent({ event: "redis.ratelimit", bucket: "recordPayment", outcome: "fail_closed", reason: "timeout", ms: 1000 });
    emitRedisEvent({ event: "redis.ratelimit", bucket: "approveRefund", outcome: "fail_closed", reason: "timeout", ms: 1000 });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("coalesces an identical failure storm into one line per window that carries the count", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const e = { event: "redis.ratelimit", bucket: "ip", outcome: "fail_open", reason: "circuit_open", ms: 0 } as const;
    for (let i = 0; i < 250; i++) emitRedisEvent({ ...e, ms: i % 3 });
    expect(warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(FAILURE_WINDOW_MS + 1);
    emitRedisEvent(e);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(expect.objectContaining({ bucket: "ip", count: 250 }));
  });

  it("samples successes (0 in tests by default), so a healthy Redis is not a log flood", () => {
    for (let i = 0; i < 100; i++) emitRedisEvent({ event: "redis.cache", family: "list:fees", outcome: "hit", ms: 2 });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("writes every success when the sample rate is 1", () => {
    vi.stubEnv("REDIS_LOG_SAMPLE_RATE", "1");
    emitRedisEvent({ event: "redis.cache", family: "list:fees", outcome: "hit", ms: 2 });
    expect(log).toHaveBeenCalledOnce();
  });

  it("treats an invalidation as routine, not a failure", () => {
    emitRedisEvent({ event: "redis.cache", family: "list:fees", outcome: "invalidated" });
    expect(warn).not.toHaveBeenCalled();
  });
});
