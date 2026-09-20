import { Ratelimit } from "@upstash/ratelimit";
import { redis } from "@/lib/redis";
import { bucketPolicy, type UnavailablePolicy } from "@/lib/rate-limit-policy";

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
 */
const limiters = new Map<string, Ratelimit>();

function limiterFor(limit: number, windowSeconds: number): Ratelimit {
  const cacheKey = `${limit}:${windowSeconds}`;
  let existing = limiters.get(cacheKey);
  if (!existing) {
    existing = new Ratelimit({
      redis: redis!,
      limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
      prefix: "ratelimit",
    });
    limiters.set(cacheKey, existing);
  }
  return existing;
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

function unavailable(key: string, policy: UnavailablePolicy, reason: string): void {
  if (policy === "allow") return;
  console.error("[rate-limit] refusing a fail-closed action: limiter unavailable", { key, reason });
  throw new RateLimiterUnavailableError();
}

/**
 * Sliding-window rate limit check. Throws RateLimitError when `key` has
 * exceeded `limit` requests within `windowSeconds`.
 *
 * `key` must start with the action name (the convention everywhere in this
 * repo is `actionName:${actor.userId}`) — that prefix is what selects the
 * failure policy, so a mis-named key is a classified-as-unknown key, and
 * unknown fails closed.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<void> {
  const policy = bucketPolicy(key);

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
    unavailable(key, policy, "redis-not-configured");
    return;
  }

  let result: { success: boolean; reset: number };
  try {
    result = await limiterFor(limit, windowSeconds).limit(key);
  } catch (err) {
    // A genuine limiter fault: network, Upstash outage, quota. Never a
    // RateLimitError — that is thrown below, outside this try.
    console.error("[rate-limit] limiter call failed", {
      key,
      reason: err instanceof Error ? err.message : String(err),
    });
    unavailable(key, policy, "redis-call-failed");
    return;
  }

  if (!result.success) {
    const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
    throw new RateLimitError(undefined, retryAfter);
  }
}
