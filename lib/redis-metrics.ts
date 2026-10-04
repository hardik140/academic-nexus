/**
 * Redis metrics: one Workers Analytics Engine data point per Redis event.
 *
 * WHY A SECOND CHANNEL
 *
 * lib/redis-telemetry.ts writes events to Workers Logs, and that is right
 * for diagnosis: every failure, with its reason. It is wrong for MEASURING:
 * successes are sampled at 1 % and repeated failures are coalesced, so a log
 * query can tell you that hits happen but not the hit ratio, the p95, or the
 * command rate. The audit (bench/results/redis-audit.json) could not measure
 * any of those for exactly this reason.
 *
 * Analytics Engine is built for this: writeDataPoint() is fire-and-forget,
 * never awaited, never on the response path, and the dataset is queried with
 * SQL (docs: REDIS_METRICS.md). Every event is written, unsampled; Analytics
 * Engine applies its own sampling at query time and reports it
 * (`_sample_interval`), so counts stay exact in aggregate.
 *
 * DATA POINT LAYOUT (stable — queries depend on it)
 *
 *   index1   `${metric}:${operation}`               (sampling key, ≤ 96 bytes)
 *   blob1    metric      redis.command | redis.cache | redis.rate_limit | redis.circuit | redis.retry
 *   blob2    operation   op name, cache family, or rate-limit bucket
 *   blob3    outcome     ok | timeout | circuit_open | auth | malformed | error | unconfigured
 *                        hit | miss | stale | bypass | error | stored | invalidated
 *                        allowed | denied | fail_open | fail_closed | open | closed | retry
 *   blob4    reason      failure reason where the outcome is not itself one
 *   blob5    environment production | preview | staging | development | test | e2e | unresolved
 *   blob6    route       a normalised path where the caller knows it, else ""
 *   double1  ms          latency of the Redis call (0 when none was made)
 *   double2  count       occurrences this point stands for (always 1 here)
 *   double3  bytes       serialised value size (cache writes only)
 *
 * NEVER WRITTEN: keys, values, user ids, IPs, tokens, URLs, error messages.
 * Operation names are code constants (op names, family names, bucket names),
 * never anything derived from a request.
 *
 * Where the binding does not exist (local development, tests, a build, a
 * Worker deployed without it) this is a no-op.
 */

/** The subset of the Analytics Engine binding this module uses. */
export interface AnalyticsEngineDataset {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

export interface RedisMetric {
  metric: "redis.command" | "redis.cache" | "redis.rate_limit" | "redis.circuit" | "redis.retry";
  operation: string;
  outcome: string;
  reason?: string;
  route?: string;
  ms?: number;
  bytes?: number;
}

/** wrangler.jsonc `analytics_engine_datasets[].binding`. */
export const REDIS_METRICS_BINDING = "REDIS_METRICS";

let override: AnalyticsEngineDataset | null | undefined;
let environmentLabel = "unresolved";

/** Test hook: route metrics to a fake dataset (null = none). `undefined` restores the real lookup. */
export function setRedisMetricsDataset(dataset: AnalyticsEngineDataset | null | undefined): void {
  override = dataset;
}

/** Set once by lib/redis-guard.ts from the resolved Redis environment. */
export function setRedisMetricsEnvironment(environment: string): void {
  environmentLabel = environment;
}

/**
 * The binding, read from the context the OpenNext worker entry publishes on
 * the global scope. Read through the symbol rather than by importing
 * @opennextjs/cloudflare, so this module costs nothing outside the Worker.
 */
function dataset(): AnalyticsEngineDataset | null {
  if (override !== undefined) return override;
  try {
    const context = (globalThis as Record<symbol, { env?: Record<string, unknown> } | undefined>)[
      Symbol.for("__cloudflare-context__")
    ];
    const binding = context?.env?.[REDIS_METRICS_BINDING] as AnalyticsEngineDataset | undefined;
    return binding && typeof binding.writeDataPoint === "function" ? binding : null;
  } catch {
    return null;
  }
}

const MAX_BLOB = 96;
const clip = (s: string) => (s.length > MAX_BLOB ? s.slice(0, MAX_BLOB) : s);

export function recordRedisMetric(m: RedisMetric): void {
  const ds = dataset();
  if (!ds) return;
  try {
    ds.writeDataPoint({
      indexes: [clip(`${m.metric}:${m.operation}`)],
      blobs: [m.metric, clip(m.operation), m.outcome, m.reason ?? "", environmentLabel, clip(m.route ?? "")],
      doubles: [Number.isFinite(m.ms) ? (m.ms as number) : 0, 1, Number.isFinite(m.bytes) ? (m.bytes as number) : 0],
    });
  } catch {
    // Metrics must never fail a request.
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A route label that cannot carry an identifier: at most the first two path
 * segments, with any id-like segment replaced. `/finance/invoices/<uuid>`
 * becomes `/finance/invoices`; `/student/12345` becomes `/student/:id`.
 */
export function routeLabel(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean).slice(0, 2);
  const safe = segments.map((s) => (UUID.test(s) || /\d/.test(s) || s.length > 40 ? ":id" : s));
  return "/" + safe.join("/");
}
