import { redisBuildId } from "@/lib/redis-config";
import { REDIS_NAMESPACE, redisOp } from "@/lib/redis-guard";
import { emitRedisEvent } from "@/lib/redis-telemetry";

/**
 * Cache-aside read-through helper. Falls back to calling `fetcher()`
 * directly — no throw, no stale-forever risk — whenever Redis is
 * unconfigured, unreachable, slow (lib/redis-guard.ts bounds every call),
 * or the circuit is open, so a cache outage degrades to "uncached" instead
 * of taking the page down.
 *
 * KEY LAYOUT (every key Redis sees)
 *
 *   <env>:nexus:c:<build>:<key>              value, build-scoped
 *   <env>:nexus:cv:<family>:<scope>          family version counter
 *
 * - `<env>:nexus` keeps development and production apart in the one shared
 *   Upstash database (lib/redis-config.ts).
 * - `<build>` keeps an old Worker and a new one from reading each other's
 *   value shapes during a rollout. TTLs are 15–300 s, so nothing piles up.
 * - There is no exact-key delete. The one entry that needed it, the
 *   middleware's profile, was removed in Phase 2.1: session admission
 *   (migration 058) now returns the role and status it reads anyway.
 * - Version counters are environment-scoped only: they are plain integers,
 *   identical in meaning to every build.
 */

/**
 * A cache key is a security boundary here, because every cached value is
 * somebody's tenant-scoped or user-scoped data.
 *
 * Keys in this codebase are built by interpolation, and several are built
 * from an optional value:
 *
 *   `dashboard:finance:${viewerProfile?.college_id}:fee-stats`
 *   `dashboard:hod:${department?.id}:faculty-courses`
 *
 * When that optional is missing, JavaScript writes `undefined` into the key,
 * and every caller in that state shares ONE entry, across users and across
 * colleges. So the key is checked rather than trusted: a key with a missing
 * or empty segment is not repaired and not guessed at — the cache is skipped
 * entirely, the read goes to the database, and the fault is logged.
 */
const MISSING_SEGMENTS = new Set(["undefined", "null", "NaN", ""]);
const MAX_KEY_LENGTH = 200;

export function unscopedSegment(key: string): string | null {
  if (key.length > MAX_KEY_LENGTH) return "<too long>";
  for (const segment of key.split(":")) {
    if (MISSING_SEGMENTS.has(segment.trim())) return segment === "" ? "<empty>" : segment;
    if (/\s/.test(segment)) return "<whitespace>";
  }
  return null;
}

export interface CacheOptions {
  /**
   * Versioned invalidation. A write calls invalidateCacheFamily(family,
   * scope), which bumps one counter; every entry of that family in that
   * scope — every page, sort, search and viewer — becomes unreachable at
   * once, without enumerating keys. `scope` is the tenant: the college id.
   */
  family?: string;
  scope?: string;
}

/**
 * A key that belongs to a versioned family — what read sites pass so the
 * family travels with the key: `getCached(versionedKey(key, FAMILY, collegeId), ...)`.
 * A null `key` stays null (uncacheable query).
 */
export interface VersionedKey {
  key: string;
  family: string;
  scope: string;
}

export function versionedKey(key: string | null, family: string, scope: string): VersionedKey | null {
  return key === null ? null : { key, family, scope };
}

interface Versioned<T> {
  v: number;
  d: T;
}

/** Version counters outlive every value (max TTL 300 s) by a wide margin. */
const VERSION_TTL_SECONDS = 86_400;
const MAX_VERSIONED_TTL_SECONDS = 3_600;

function familyLabel(key: string, opts?: CacheOptions): string {
  if (opts?.family) return opts.family;
  const parts = key.split(":");
  return parts.length > 1 ? `${parts[0]}:${parts[1]}` : parts[0];
}

function valueKey(key: string): string {
  return `${REDIS_NAMESPACE}:c:${redisBuildId()}:${key}`;
}

function versionKey(family: string, scope: string): string {
  return `${REDIS_NAMESPACE}:cv:${family}:${scope}`;
}

/**
 * @param keyOrSpec  null means "this query is not cacheable" (lib/cached-list.ts
 *             returns null for an over-long search or an invalid page) —
 *             the read goes straight to the database.
 */
export async function getCached<T>(
  keyOrSpec: string | VersionedKey | null,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
  options?: CacheOptions
): Promise<T> {
  const key = keyOrSpec === null || typeof keyOrSpec === "string" ? keyOrSpec : keyOrSpec.key;
  const opts: CacheOptions | undefined =
    keyOrSpec !== null && typeof keyOrSpec === "object"
      ? { ...options, family: keyOrSpec.family, scope: keyOrSpec.scope }
      : options;
  const family = familyLabel(key ?? "uncacheable", opts);
  if (key === null) {
    emitRedisEvent({ event: "redis.cache", family, outcome: "bypass", reason: "uncacheable_query" });
    return fetcher();
  }
  if (!REDIS_NAMESPACE) return fetcher();

  const missing =
    unscopedSegment(key) ??
    (opts?.family !== undefined ? unscopedSegment(`${opts.family}:${opts.scope ?? ""}`) : null);
  if (missing) {
    console.error("[cache] refusing a key with a missing scope segment", { family, segment: missing });
    emitRedisEvent({ event: "redis.cache", family, outcome: "bypass", reason: "unscoped_key" });
    return fetcher();
  }
  const versioned = opts?.family !== undefined && opts.scope !== undefined;
  if (versioned && ttlSeconds > MAX_VERSIONED_TTL_SECONDS) {
    throw new Error("getCached: a versioned entry may not outlive its version counter");
  }

  const vKey = valueKey(key);
  let currentVersion = 0;

  if (versioned) {
    const read = await redisOp("cache.read", (r) =>
      r.mget<[Versioned<T> | null, number | string | null]>(vKey, versionKey(opts.family!, opts.scope!))
    );
    if (read.ok) {
      const [entry, version] = read.value;
      currentVersion = Number(version ?? 0) || 0;
      if (entry && typeof entry === "object" && "v" in entry) {
        if (entry.v === currentVersion) {
          emitRedisEvent({ event: "redis.cache", family, outcome: "hit", ms: read.ms });
          return entry.d;
        }
        emitRedisEvent({ event: "redis.cache", family, outcome: "stale_version", ms: read.ms });
      } else {
        emitRedisEvent({ event: "redis.cache", family, outcome: "miss", ms: read.ms });
      }
    } else {
      emitRedisEvent({ event: "redis.cache", family, outcome: "error", reason: read.reason, ms: read.ms });
      return fetcher();
    }
  } else {
    const read = await redisOp("cache.read", (r) => r.get<T>(vKey));
    if (read.ok && read.value !== null && read.value !== undefined) {
      emitRedisEvent({ event: "redis.cache", family, outcome: "hit", ms: read.ms });
      return read.value;
    }
    if (!read.ok) {
      emitRedisEvent({ event: "redis.cache", family, outcome: "error", reason: read.reason, ms: read.ms });
      return fetcher();
    }
    emitRedisEvent({ event: "redis.cache", family, outcome: "miss", ms: read.ms });
  }

  const fresh = await fetcher();

  // Stamped with the version read BEFORE the fetch: if a write bumped the
  // counter meanwhile, this entry is already stale and the next read misses.
  const stored: unknown = versioned ? ({ v: currentVersion, d: fresh } satisfies Versioned<T>) : fresh;
  const write = await redisOp("cache.write", (r) => r.set(vKey, stored, { ex: ttlSeconds }));
  if (!write.ok) {
    emitRedisEvent({ event: "redis.cache", family, outcome: "error", reason: write.reason, ms: write.ms });
  }
  return fresh;
}

/**
 * Invalidate every cached entry of `family` within `scope` (a college): one
 * INCR, whatever the number of pages, sorts, searches and viewers cached.
 * The counter expires a day after the last write, far beyond any value's
 * TTL, so a counter that lapses can never resurrect an old entry.
 */
export async function invalidateCacheFamily(family: string, scope: string): Promise<void> {
  if (!REDIS_NAMESPACE) return;
  if (unscopedSegment(`${family}:${scope}`)) return;
  const key = versionKey(family, scope);
  const result = await redisOp("cache.version", async (r) => {
    const pipe = r.pipeline();
    pipe.incr(key);
    pipe.expire(key, VERSION_TTL_SECONDS);
    return pipe.exec();
  });
  emitRedisEvent({
    event: "redis.cache",
    family,
    outcome: result.ok ? "invalidated" : "error",
    ...(result.ok ? {} : { reason: result.reason }),
  });
}
