import { redis } from "@/lib/redis";

/**
 * Cache-aside read-through helper. Falls back to calling `fetcher()`
 * directly — no throw, no stale-forever risk — whenever Redis is
 * unconfigured or unreachable, so a cache outage degrades to "uncached"
 * instead of taking the page down.
 */
export async function getCached<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  if (!redis) return fetcher();

  try {
    const cached = await redis.get<T>(key);
    if (cached !== null && cached !== undefined) return cached;
  } catch {
    // Redis read failed — fall through to a live fetch below.
  }

  const fresh = await fetcher();

  try {
    await redis.set(key, fresh, { ex: ttlSeconds });
  } catch {
    // Redis write failed — the caller still gets fresh data, just uncached.
  }

  return fresh;
}
