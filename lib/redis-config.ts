import { createHash } from "node:crypto";

/**
 * Redis configuration that every Redis caller shares: which environment's
 * keys this process may touch, how long one Redis call may take, and how
 * keys are namespaced. Pure functions of the environment, so tests can
 * exercise every branch without a client.
 *
 * WHY A NAMESPACE AT ALL
 *
 * The production Worker's secrets are synced from a developer's .env.local
 * (scripts/sync-cf-secrets.mjs), so local development and production talk
 * to the SAME Upstash database. Before this module, both wrote identical
 * key strings: a dev server could fill a production rate-limit bucket, and
 * a branch with a different value shape could poison a production cache
 * entry. Every key now starts with `<environment>:nexus:`.
 */

export const REDIS_ENVIRONMENTS = ["production", "preview", "staging", "development", "test", "e2e"] as const;
export type RedisEnvironment = (typeof REDIS_ENVIRONMENTS)[number];

const APP = "nexus";

export type EnvironmentResolution =
  | { ok: true; environment: RedisEnvironment }
  | { ok: false; reason: string };

/**
 * The environment whose keys this process may touch.
 *
 * - `REDIS_ENV` wins when set, and must be one of REDIS_ENVIRONMENTS.
 * - Unset: `next dev` is development, vitest is test, a built bundle is
 *   production — so the deployed Worker needs no new variable to keep
 *   working.
 * - The production namespace is refused outside a production bundle: a
 *   development server or a test run pointed at it is a misconfiguration,
 *   and the safe answer is "no Redis", never "share production's keys".
 */
export function resolveRedisEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  // The literal `process.env.NODE_ENV` is inlined by Next at build time, so a
  // built bundle knows it is a production build even where the runtime's
  // process.env carries no NODE_ENV (a Worker's holds only its bindings).
  // Read through `env.NODE_ENV` instead, a production Worker could resolve
  // as "not production", refuse its own namespace, and disable Redis — which
  // fails every high-risk action closed. Tests pass `env` and are read from it.
  nodeEnv: string | undefined = env === process.env ? process.env.NODE_ENV : env.NODE_ENV
): EnvironmentResolution {
  const explicit = env.REDIS_ENV?.trim();
  let environment: RedisEnvironment;
  if (explicit) {
    if (!(REDIS_ENVIRONMENTS as readonly string[]).includes(explicit)) {
      return { ok: false, reason: "REDIS_ENV is not a known environment" };
    }
    environment = explicit as RedisEnvironment;
  } else {
    environment = nodeEnv === "test" ? "test" : nodeEnv === "development" ? "development" : "production";
  }
  if (environment === "production" && nodeEnv !== "production") {
    return { ok: false, reason: "the production namespace is only usable from a production build" };
  }
  return { ok: true, environment };
}

/** `<environment>:nexus` — the first two segments of every Redis key. */
export function redisNamespace(environment: RedisEnvironment): string {
  return `${environment}:${APP}`;
}

/**
 * The longest one Redis call may take, retries included, in milliseconds.
 *
 * Default 1000. Recorded latency (REDIS_RATE_LIMIT_DESIGN.md §4,
 * PERFORMANCE_TEST_REPORT.md): a COLD call from a developer machine in
 * India — TLS and HTTP handshake included — took 639 ms; warm calls are
 * tens of milliseconds. 1000 ms admits the cold case with margin and still
 * caps a hung Upstash at one second instead of the client's previous
 * ~4.3 s of retries plus an unbounded fetch. Overridable with
 * REDIS_TIMEOUT_MS, clamped to 100–5000.
 */
export const DEFAULT_REDIS_TIMEOUT_MS = 1000;

export function redisTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.REDIS_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(raw)) return DEFAULT_REDIS_TIMEOUT_MS;
  return Math.min(5000, Math.max(100, raw));
}

/**
 * Identifies the deployed build, so cached VALUES written by one build are
 * never read by another (an old Worker and a new one can run side by side
 * during a rollout, with different value shapes). Inlined at build time by
 * next.config.ts. Cache TTLs are 15–300 s, so a new build starts with a
 * cold cache for at most five minutes and the old build's entries expire on
 * their own — nothing accumulates.
 */
export function redisBuildId(raw: string | undefined = process.env.NEXT_PUBLIC_REDIS_BUILD_ID): string {
  // The literal `process.env.NEXT_PUBLIC_REDIS_BUILD_ID` above is what Next
  // replaces at build time. Read through any other expression (an `env`
  // parameter, a destructure) it is NOT inlined, and on the Worker — whose
  // process.env holds only bindings — every build would read "local".
  const id = (raw ?? "").trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(id) ? id : "local";
}

/**
 * A short, stable digest for putting an identifier into a key without
 * storing it raw (client IPs, search text). Not a secret: an IPv4 address
 * can be recovered by enumeration. The point is that keys never hold the
 * raw value and never grow with user input.
 */
export function keyDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

/** Fraction of SUCCESS events written to the log. Failures are always written. */
export function redisLogSampleRate(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseFloat(env.REDIS_LOG_SAMPLE_RATE ?? "");
  if (!Number.isFinite(raw)) return env.NODE_ENV === "test" ? 0 : 0.01;
  return Math.min(1, Math.max(0, raw));
}
