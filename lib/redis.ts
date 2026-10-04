import { Redis } from "@upstash/redis";
import { redisTimeoutMs, resolveRedisEnvironment } from "@/lib/redis-config";
import { emitRedisEvent } from "@/lib/redis-telemetry";

/**
 * Shared Upstash Redis client — HTTP-based, safe to call from any serverless
 * invocation with no connection-pool management.
 *
 * `null` when UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN aren't set,
 * or when this process's Redis environment is refused (lib/redis-config.ts:
 * e.g. a dev server or a test run pointed at the production namespace).
 * Callers never use this directly for a decision: they go through
 * lib/redis-guard.ts, which bounds the call and applies the failure policy.
 *
 * REQUEST BUDGET
 *
 * The client's defaults were 5 retries with exponential backoff (≈4.3 s of
 * waiting) and NO request deadline, so a hung Upstash held a request for as
 * long as the platform allowed. Now:
 *
 * - `signal` is a FUNCTION. The client calls it once per command, before its
 *   retry loop, so one AbortSignal.timeout covers every attempt: the whole
 *   command, retries included, ends within redisTimeoutMs(). It must be a
 *   function — given a plain AbortSignal, @upstash/redis turns an abort into
 *   a fake successful response whose result is the string "Aborted", which a
 *   GET would hand back as if it were the cached value.
 * - one retry, 50 ms apart, for a genuinely transient network error. The
 *   client retries only when fetch itself throws (never on an HTTP error),
 *   so an auth failure or a server error is not retried at all.
 */
const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
const environment = resolveRedisEnvironment();

if (url && token && !environment.ok) {
  console.error({ event: "redis.config", outcome: "refused", reason: environment.reason });
}

export const REDIS_RETRIES = 1;
const RETRY_BACKOFF_MS = 50;

export const redis =
  url && token && environment.ok
    ? new Redis({
        url,
        token,
        retry: {
          retries: REDIS_RETRIES,
          backoff: () => {
            emitRedisEvent({ event: "redis.retry", op: "request" });
            return RETRY_BACKOFF_MS;
          },
        },
        signal: () => AbortSignal.timeout(redisTimeoutMs()),
      })
    : null;

