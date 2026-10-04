import { redisLogSampleRate } from "@/lib/redis-config";
import { recordRedisMetric, type RedisMetric } from "@/lib/redis-metrics";

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
 *
 * Every event — sampled or not — is ALSO written, unsampled, as a metric data
 * point (lib/redis-metrics.ts → Workers Analytics Engine). Logs answer "what
 * went wrong"; metrics answer "how often, how fast, what ratio".
 */

export type RedisFailureReason =
  | "unconfigured"
  | "circuit_open"
  | "timeout"
  | "auth"
  | "malformed"
  | "error";

export type RedisEvent =
  | { event: "redis.op"; op: string; outcome: "ok" | RedisFailureReason; ms: number; route?: string }
  | { event: "redis.retry"; op: "request" }
  | { event: "redis.circuit"; state: "open" | "closed" }
  | {
      event: "redis.ratelimit";
      bucket: string;
      outcome: "allowed" | "denied" | "fail_open" | "fail_closed";
      reason?: RedisFailureReason;
      ms: number;
      route?: string;
    }
  | {
      event: "redis.cache";
      family: string;
      outcome: "hit" | "miss" | "bypass" | "error" | "invalidated" | "stale_version" | "stored";
      reason?: RedisFailureReason | "unscoped_key" | "uncacheable_query";
      ms?: number;
      /** Serialised size of a stored value (outcome "stored" only). */
      bytes?: number;
      route?: string;
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

/** The metric data point for an event (lib/redis-metrics.ts layout). */
export function metricFor(e: RedisEvent): RedisMetric {
  switch (e.event) {
    case "redis.op":
      return { metric: "redis.command", operation: e.op, outcome: e.outcome, ms: e.ms, route: e.route };
    case "redis.retry":
      return { metric: "redis.retry", operation: e.op, outcome: "retry" };
    case "redis.circuit":
      return { metric: "redis.circuit", operation: "breaker", outcome: e.state };
    case "redis.ratelimit":
      return { metric: "redis.rate_limit", operation: e.bucket, outcome: e.outcome, reason: e.reason, ms: e.ms, route: e.route };
    case "redis.cache":
      return {
        metric: "redis.cache",
        operation: e.family,
        outcome: e.outcome === "stale_version" ? "stale" : e.outcome,
        reason: e.reason,
        ms: e.ms,
        bytes: e.bytes,
        route: e.route,
      };
  }
}

export function emitRedisEvent(e: RedisEvent): void {
  if (recording) recordedRedisEvents.push(e);
  recordRedisMetric(metricFor(e));
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
