import { Ratelimit } from "@upstash/ratelimit";
import { redis } from "@/lib/redis";

export class RateLimitError extends Error {
  constructor(message = "Too many requests. Please try again shortly.") {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * Sliding-window rate limit check. Throws RateLimitError when `key` has
 * exceeded `limit` requests within `windowSeconds`.
 *
 * Fails open — never blocks a real request — when Redis is unconfigured or
 * the limiter call itself errors (network blip, Upstash outage), same
 * posture as lib/cache.ts. A rate limiter that's down should not become an
 * outage of its own.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<void> {
  if (!redis) return;

  try {
    const ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
      prefix: "ratelimit",
    });
    const { success } = await ratelimit.limit(key);
    if (!success) throw new RateLimitError();
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    // Redis itself failed — fail open rather than block real traffic.
  }
}
