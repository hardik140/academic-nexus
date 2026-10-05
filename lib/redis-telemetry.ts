import { redisLogSampleRate } from "@/lib/redis-config";

/**
 * Structured Redis events.
 *
 * The deployed Worker has Workers Logs enabled (wrangler.jsonc
 * `observability`), which indexes the fields of an object passed to
 * console.*. That is this repository's existing observability channel —
 * server-side Sentry is never initialised (there is no instrumentation.ts) —
 * so events go there as one flat object each, queryable by `event`,
 * `outcome`, `bucket` and `family`, rather than through a second system.
 *
 * NEVER LOGGED: keys (they contain user ids and digests), values, error
 * messages from the Upstash client (they embed the full command, including
 * cached payloads), credentials, URLs. Only the names below.
 *
 * Volume: success events are sampled (REDIS_LOG_SAMPLE_RATE, default 1 %),
 * every failure is written. Alert thresholds that read these events are in
 * REDIS_RATE_LIMIT_DESIGN.md §10.
 */

export type RedisFailureReason =
  | "unconfigured"
  | "circuit_open"
  | "timeout"
  | "auth"
  | "malformed"
  | "error";

export type RedisEvent =
  | { event: "redis.op"; op: string; outcome: "ok" | RedisFailureReason; ms: number }
  | { event: "redis.retry"; op: "request" }
  | { event: "redis.circuit"; state: "open" | "closed" }
  | {
      event: "redis.ratelimit";
      bucket: string;
      outcome: "allowed" | "denied" | "fail_open" | "fail_closed";
      reason?: RedisFailureReason;
      ms: number;
    }
  | {
      event: "redis.cache";
      family: string;
      outcome: "hit" | "miss" | "bypass" | "error" | "invalidated" | "stale_version";
      reason?: RedisFailureReason | "unscoped_key" | "uncacheable_query";
      ms?: number;
    };

const FAILURE_OUTCOMES = new Set(["denied", "fail_open", "fail_closed", "error", "bypass", "open"]);

function isFailure(e: RedisEvent): boolean {
  if (e.event === "redis.retry") return true;
  if (e.event === "redis.circuit") return true;
  if (e.event === "redis.op") return e.outcome !== "ok";
  if (e.event === "redis.cache" && e.outcome === "invalidated") return false;
  return FAILURE_OUTCOMES.has(e.outcome) || ("reason" in e && e.reason !== undefined);
}

/** Test hook: every event emitted, in order. */
export const recordedRedisEvents: RedisEvent[] = [];
let recording = false;
export function recordRedisEvents(on: boolean): void {
  recording = on;
  recordedRedisEvents.length = 0;
}

/**
 * Identical failure events are coalesced per isolate: the first is written
 * at once, repeats within FAILURE_WINDOW_MS are counted, and the next write
 * carries `count` — the number of occurrences it stands for. During an
 * outage every request fails the same way; without this, an outage would be
 * a log flood. Alert queries sum `count` (absent = 1), so totals stay exact.
 */
export const FAILURE_WINDOW_MS = 5_000;
const pending = new Map<string, { last: number; suppressed: number }>();

function signature(e: RedisEvent): string {
  const { ms: _ms, ...rest } = e as RedisEvent & { ms?: number };
  void _ms;
  return JSON.stringify(rest);
}

export function emitRedisEvent(e: RedisEvent): void {
  if (recording) recordedRedisEvents.push(e);
  if (!isFailure(e)) {
    if (Math.random() < redisLogSampleRate()) console.log(e);
    return;
  }
  const sig = signature(e);
  const now = Date.now();
  const state = pending.get(sig);
  if (state && now - state.last < FAILURE_WINDOW_MS) {
    state.suppressed += 1;
    return;
  }
  const count = (state?.suppressed ?? 0) + 1;
  pending.set(sig, { last: now, suppressed: 0 });
  if (pending.size > 500) pending.clear(); // bounded: signatures are names, not ids
  console.warn(count > 1 ? { ...e, count } : e);
}

/** Test hook. */
export function resetRedisTelemetry(): void {
  pending.clear();
}

/** Bucket name from a rate-limit key: the segment before the first colon. */
export function bucketOf(key: string): string {
  const colon = key.indexOf(":");
  return colon === -1 ? key : key.slice(0, colon);
}
