import { redis } from "@/lib/redis";

/**
 * Cache-aside read-through helper. Falls back to calling `fetcher()`
 * directly — no throw, no stale-forever risk — whenever Redis is
 * unconfigured or unreachable, so a cache outage degrades to "uncached"
 * instead of taking the page down.
 */
/**
 * A cache key is a security boundary here, because every cached value is
 * somebody's tenant-scoped or user-scoped data.
 *
 * WHAT THIS CATCHES
 *
 * Keys in this codebase are built by interpolation, and several are built
 * from an optional value:
 *
 *   `dashboard:finance:${viewerProfile?.college_id}:fee-stats`
 *   `dashboard:hod:${department?.id}:faculty-courses`
 *
 * When that optional is missing, JavaScript does not fail — it writes the
 * five characters `undefined` into the key. Every caller in that state then
 * shares ONE cache entry, across users and across colleges, and the first
 * one to arrive decides what the rest of them read.
 *
 * Today that is not a data leak: the same missing profile that produces the
 * broken key also leaves RLS with no college to match, so the value cached
 * under it is empty. But nothing enforces that coupling — it is a
 * coincidence of two unrelated code paths, and it would stop holding the
 * moment one of those queries stopped depending on the profile row.
 *
 * So the key is checked rather than trusted. A key with a missing segment is
 * not repaired and not guessed at: the cache is skipped entirely, the read
 * goes to the database, and the fault is logged with the key that caused it.
 * Correct answer, no shared entry, and an operator can see it.
 */
function unscopedSegment(key: string): string | null {
  for (const segment of key.split(":")) {
    if (segment === "undefined" || segment === "null") return segment;
  }
  return null;
}

export async function getCached<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  if (!redis) return fetcher();

  const missing = unscopedSegment(key);
  if (missing) {
    console.error("[cache] refusing a key with a missing scope segment", { key, segment: missing });
    return fetcher();
  }

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
  // Nothing was ever written under such a key (see getCached), so there is
  // nothing to delete — and issuing the DEL anyway would be the one write
  // that touches the shared entry this guard exists to avoid.
  if (unscopedSegment(key)) return;
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
