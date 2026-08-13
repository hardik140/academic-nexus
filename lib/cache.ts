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

/**
 * Explicit cache-bust for the exact key a write just affected — e.g. list
 * pages using getCached() for real pagination (Phase 2/3 of the load
 * review), where the actor's current page/sort/search is a deterministic
 * key. Unlike the dashboards' pure TTL-only caching (fine for aggregate
 * counts, where a few seconds' staleness is invisible), a CRUD list needs
 * this: an admin who just created a row and doesn't see it appear reads
 * that as a bug, not a cache. Same fail-open posture as getCached — a
 * failed delete just means that one key rides out its TTL instead of
 * clearing immediately, never an error surfaced to the caller.
 */
export async function invalidateCache(key: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch {
    // Best-effort — see getCached's fail-open rationale above.
  }
}

/**
 * Shared by lib/supabase/middleware.ts (reader) and every write that
 * changes a profile's role/status (invalidator) — a single definition so
 * the two sides can't drift into mismatched key strings.
 */
export function middlewareProfileCacheKey(userId: string): string {
  return `mw-profile:${userId}`;
}
