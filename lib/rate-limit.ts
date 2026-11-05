import { Ratelimit } from "@upstash/ratelimit";
import { redis } from "@/lib/redis";
import { redisTimeoutMs } from "@/lib/redis-config";
import { namespacedKey, redisOp } from "@/lib/redis-guard";
import { emitRedisEvent, type RedisFailureReason } from "@/lib/redis-telemetry";
import { bucketName, bucketPolicy, type UnavailablePolicy } from "@/lib/rate-limit-policy";

export class RateLimitError extends Error {
  /** Seconds until the caller may retry, when the limiter could tell us. */
  readonly retryAfterSeconds: number;

  constructor(message = "Too many requests. Please try again shortly.", retryAfterSeconds = 60) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The limiter could not reach Redis, and this bucket is not allowed to run
 * unlimited. Distinct from RateLimitError because it means something
 * different to both the caller and the operator: 429 says "you are going too
 * fast", 503 says "we cannot currently tell how fast you are going".
 */
export class RateLimiterUnavailableError extends Error {
  constructor(message = "This action is temporarily unavailable. Please try again shortly.") {
    super(message);
    this.name = "RateLimiterUnavailableError";
  }
}

/**
 * WHY THIS FILE HAS A FAILURE POLICY AT ALL
 *
 * The previous version swallowed every Redis failure and returned normally:
 *
 *   } catch (err) {
 *     if (err instanceof RateLimitError) throw err;
 *     // Redis itself failed — fail open rather than block real traffic.
 *   }
 *
 * and returned early when Redis was not configured at all. Both are the same
 * decision — when the limiter cannot work, let everything through — and it
 * was applied uniformly to browsing a dashboard and to approving a refund.
 *
 * That makes the rate limiter's own availability the attacker's lever: an
 * Upstash outage, or a forgotten environment variable on a new deployment,
 * silently converts every bucket in the application to unlimited. Nothing
 * logs it and nothing surfaces it, so the first sign is the damage.
 *
 * So the decision is now per bucket and declared in one place
 * (lib/rate-limit-policy.ts). Security-sensitive buckets FAIL CLOSED: if we
 * cannot count the request, we do not perform it. A small, documented set of
 * coarse/read buckets still FAIL OPEN, because taking the whole site down
 * when the cache tier blinks is its own outage and those buckets are not an
 * authorization boundary.
 *
 * WHAT IS NOT CHANGED HERE
 *
 * The algorithm. @upstash/ratelimit's sliding window executes as a single
 * Lua script inside Redis (verified in node_modules/@upstash/ratelimit —
 * every limiter goes through redis.eval), so the count-and-decide step is
 * already atomic across concurrent requests and across application
 * instances. It is not a GET/compute/SET race. That was measured, not
 * assumed — see REDIS_RATE_LIMIT_DESIGN.md for the recorded runs.
 */

/**
 * Limiter instances are cached per (limit, window). Constructing one is
 * cheap but not free, and the previous code built a new one on every single
 * call — once per rate-limited action, on a serverless path where that cost
 * is paid on every invocation.
 *
 * `prefix` puts every bucket under `<environment>:nexus:rl`, so a development
 * server sharing the production Upstash database never counts against a
 * production bucket (lib/redis-config.ts).
 *
 * `timeout` is set explicitly, and its result is NOT trusted. On timeout,
 * @upstash/ratelimit resolves `{ success: true, reason: "timeout" }` instead
 * of throwing — the previous code read only `success`, so a slow Upstash
 * turned every fail-closed bucket (payments, refunds, approvals) into
 * unlimited. limiterResultFault() below classifies that result as a timeout,
 * and the bucket's policy decides.
 */
const limiters = new Map<string, Ratelimit>();

function limiterFor(client: NonNullable<typeof redis>, limit: number, windowSeconds: number): Ratelimit {
  const cacheKey = `${limit}:${windowSeconds}`;
  let existing = limiters.get(cacheKey);
  if (!existing) {
    existing = new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
      prefix: namespacedKey("rl", "v1") ?? "unconfigured:rl",
      timeout: redisTimeoutMs(),
    });
    limiters.set(cacheKey, existing);
  }
  return existing;
}

type LimitResult = { success: boolean; reset: number; remaining: number; reason?: string };

/**
 * Anything other than a well-formed verdict is a fault, never a verdict:
 * the library's own timeout, a non-boolean `success`, a non-numeric reset.
 */
export function limiterResultFault(result: unknown): RedisFailureReason | null {
  if (!result || typeof result !== "object") return "malformed";
  const r = result as Partial<LimitResult>;
  if (r.reason === "timeout") return "timeout";
  if (typeof r.success !== "boolean") return "malformed";
  if (typeof r.reset !== "number" || !Number.isFinite(r.reset)) return "malformed";
  if (typeof r.remaining !== "number" || !Number.isFinite(r.remaining)) return "malformed";
  return null;
}

/**
 * True in a deployed environment. A developer running the app with no
 * Upstash credentials should not have every mutation refuse to run; a
 * production deployment with no Upstash credentials has no rate limiting at
 * all, which for a fail-closed bucket is exactly the situation the policy
 * exists to refuse.
 */
function isDeployed(): boolean {
  return process.env.NODE_ENV === "production";
}

let warnedUnconfigured = false;

/**
 * Sliding-window rate limit check. Throws RateLimitError when `key` has
 * exceeded `limit` requests within `windowSeconds`, and
 * RateLimiterUnavailableError when the limiter cannot give a trustworthy
 * answer and the bucket's risk class is fail-closed.
 *
 * `key` must start with the action name (the convention everywhere in this
 * repo is `actionName:${actor.userId}`) — that prefix is what selects the
 * failure policy, so a mis-named key is a classified-as-unknown key, and
 * unknown fails closed.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  /** Metrics only: a normalised route label (lib/redis-metrics.ts routeLabel). */
  options: { route?: string } = {}
): Promise<void> {
  const route = options.route;
  const policy = bucketPolicy(key);
  const bucket = bucketName(key);

  if (!redis) {
    if (!isDeployed()) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        console.warn(
          "[rate-limit] UPSTASH_REDIS_REST_URL/TOKEN are not set — rate limiting is disabled. " +
            "This is allowed outside production only."
        );
      }
      return;
    }
    return unavailable(bucket, policy, "unconfigured", 0, route);
  }

  const client = redis;
  const outcome = await redisOp(
    "ratelimit",
    () => limiterFor(client, limit, windowSeconds).limit(key) as Promise<LimitResult>,
    limiterResultFault,
    route
  );

  if (!outcome.ok) return unavailable(bucket, policy, outcome.reason, outcome.ms, route);

  if (!outcome.value.success) {
    emitRedisEvent({ event: "redis.ratelimit", bucket, outcome: "denied", ms: outcome.ms, route });
    const retryAfter = Math.max(1, Math.ceil((outcome.value.reset - Date.now()) / 1000));
    throw new RateLimitError(undefined, retryAfter);
  }
  emitRedisEvent({ event: "redis.ratelimit", bucket, outcome: "allowed", ms: outcome.ms, route });
}

/**
 * The limiter gave no trustworthy answer (unconfigured, timeout, error,
 * malformed result, circuit open). The bucket's risk class decides, here and
 * nowhere else.
 */
function unavailable(
  bucket: string,
  policy: UnavailablePolicy,
  reason: RedisFailureReason,
  ms: number,
  route?: string
): void {
  if (policy === "allow") {
    emitRedisEvent({ event: "redis.ratelimit", bucket, outcome: "fail_open", reason, ms, route });
    return;
  }
  emitRedisEvent({ event: "redis.ratelimit", bucket, outcome: "fail_closed", reason, ms, route });
  throw new RateLimiterUnavailableError();
}
