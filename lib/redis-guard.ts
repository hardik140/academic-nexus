import { redis } from "@/lib/redis";
import { redisNamespace, redisTimeoutMs, resolveRedisEnvironment } from "@/lib/redis-config";
import { emitRedisEvent, type RedisFailureReason } from "@/lib/redis-telemetry";

/**
 * THE one way application code talks to Redis. It returns an outcome instead
 * of throwing, so every caller is forced to decide what a failure means —
 * and the decision lives in the caller's policy (lib/rate-limit-policy.ts for
 * rate limits, "go to the database" for caches), never in the client's
 * defaults.
 *
 * What it adds over the client:
 *
 * 1. A hard deadline. The client's own AbortSignal (lib/redis.ts) ends the
 *    HTTP request; this race is the backstop for anything that ignores the
 *    signal, so no Redis call can hold a request past redisTimeoutMs() plus
 *    a small grace.
 * 2. Classification of failures by TYPE, never by message (the client's
 *    messages embed the full command, payload included).
 * 3. A per-isolate circuit breaker. During an outage every Redis call would
 *    otherwise pay the full deadline — the middleware alone makes up to three
 *    calls per request. After CIRCUIT_THRESHOLD consecutive failures the
 *    circuit opens for CIRCUIT_COOLDOWN_MS: calls fail instantly with
 *    "circuit_open" (the caller's policy still applies, unchanged). After the
 *    cooldown ONE call is let through as a probe; success closes the
 *    circuit, failure re-opens it. That is the recovery path.
 */

export type RedisOutcome<T> =
  | { ok: true; value: T; ms: number }
  | { ok: false; reason: RedisFailureReason; ms: number };

const environment = resolveRedisEnvironment();

/** `<environment>:nexus`, or null when this process may not use Redis. */
export const REDIS_NAMESPACE: string | null = environment.ok ? redisNamespace(environment.environment) : null;

export const CIRCUIT_THRESHOLD = 3;
export const CIRCUIT_COOLDOWN_MS = 10_000;
const DEADLINE_GRACE_MS = 50;

let consecutiveFailures = 0;
let openUntil = 0;
let probing = false;

/** Test hook. */
export function resetRedisGuard(): void {
  consecutiveFailures = 0;
  openUntil = 0;
  probing = false;
}

export function circuitIsOpen(now = Date.now()): boolean {
  return openUntil > now;
}

class DeadlineExceeded extends Error {
  constructor() {
    super("deadline exceeded");
    this.name = "DeadlineExceeded";
  }
}

function classify(err: unknown): RedisFailureReason {
  const name = err instanceof Error ? err.name : "";
  if (name === "DeadlineExceeded" || name === "AbortError" || name === "TimeoutError") return "timeout";
  if (name === "UpstashJSONParseError" || name === "SyntaxError") return "malformed";
  if (name === "UpstashError") {
    // UpstashError carries the server's reason first; an auth refusal is the
    // one worth telling apart from an outage, because no retry will fix it.
    const msg = err instanceof Error ? err.message.slice(0, 40).toLowerCase() : "";
    if (msg.includes("unauthorized") || msg.includes("wrongpass") || msg.includes("noauth")) return "auth";
  }
  return "error";
}

function recordFailure(): void {
  consecutiveFailures += 1;
  if (probing || consecutiveFailures >= CIRCUIT_THRESHOLD) {
    if (!circuitIsOpen()) emitRedisEvent({ event: "redis.circuit", state: "open" });
    openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
  }
  probing = false;
}

function recordSuccess(): void {
  if (openUntil !== 0 || probing) emitRedisEvent({ event: "redis.circuit", state: "closed" });
  consecutiveFailures = 0;
  openUntil = 0;
  probing = false;
}

/**
 * Run one Redis operation under the deadline and the breaker.
 *
 * `validate` inspects a RESOLVED value and may still call it a failure — the
 * rate limiter needs this, because @upstash/ratelimit reports its own timeout
 * as a resolved `{ success: true, reason: "timeout" }`.
 */
export async function redisOp<T>(
  op: string,
  run: (client: NonNullable<typeof redis>) => Promise<T>,
  validate?: (value: T) => RedisFailureReason | null
): Promise<RedisOutcome<T>> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  if (!redis || !REDIS_NAMESPACE) {
    return { ok: false, reason: "unconfigured", ms: 0 };
  }
  if (circuitIsOpen(started)) {
    emitRedisEvent({ event: "redis.op", op, outcome: "circuit_open", ms: 0 });
    return { ok: false, reason: "circuit_open", ms: 0 };
  }
  if (openUntil !== 0) {
    // Cooldown over: this call is the probe.
    if (probing) return { ok: false, reason: "circuit_open", ms: 0 };
    probing = true;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineExceeded()), redisTimeoutMs() + DEADLINE_GRACE_MS);
    });
    const value = await Promise.race([run(redis), deadline]);
    const invalid = validate ? validate(value) : null;
    if (invalid) {
      recordFailure();
      emitRedisEvent({ event: "redis.op", op, outcome: invalid, ms: elapsed() });
      return { ok: false, reason: invalid, ms: elapsed() };
    }
    recordSuccess();
    emitRedisEvent({ event: "redis.op", op, outcome: "ok", ms: elapsed() });
    return { ok: true, value, ms: elapsed() };
  } catch (err) {
    const reason = classify(err);
    recordFailure();
    emitRedisEvent({ event: "redis.op", op, outcome: reason, ms: elapsed() });
    return { ok: false, reason, ms: elapsed() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A full key: `<environment>:nexus:<category>:<rest>`. Null when Redis is unusable. */
export function namespacedKey(category: string, rest: string): string | null {
  return REDIS_NAMESPACE ? `${REDIS_NAMESPACE}:${category}:${rest}` : null;
}
