# Redis metrics

Every Redis event the app emits is written, unsampled, as one data point to
the Workers Analytics Engine dataset `nexus_redis_metrics` (binding
`REDIS_METRICS` in `wrangler.jsonc`, code in `lib/redis-metrics.ts`). The log
events in `lib/redis-telemetry.ts` are unchanged and stay the tool for
diagnosing a failure. These metrics are for measuring.

**Status: built and tested, not deployed.** The dataset does not exist until
a deploy that includes the binding receives traffic. Nothing below has been
run against real data yet.

## Layout

| Column | Meaning |
|---|---|
| `index1` | `<metric>:<operation>`, the sampling key |
| `blob1` | metric: `redis.command`, `redis.cache`, `redis.rate_limit`, `redis.circuit`, `redis.retry` |
| `blob2` | operation: an op name (`cache.read`, `cache.write`, `ratelimit`, …), a cache family, or a rate-limit bucket |
| `blob3` | outcome (below) |
| `blob4` | reason, when the outcome is not itself one |
| `blob5` | environment: `production`, `preview`, `development`, `test`, `e2e`, … |
| `blob6` | route: two path segments with ids removed, where the caller knows it (the middleware); otherwise empty |
| `double1` | milliseconds of the Redis call |
| `double2` | 1 |
| `double3` | stored value size in characters (`redis.cache` / `stored` only; equals bytes for ASCII JSON) |

Outcomes by metric:

| Metric | Outcomes |
|---|---|
| `redis.command` | `ok`, `timeout`, `circuit_open`, `auth`, `malformed`, `error`, `unconfigured` |
| `redis.cache` | `hit`, `miss`, `stale` (version bumped), `bypass`, `error`, `stored`, `invalidated` |
| `redis.rate_limit` | `allowed`, `denied`, `fail_open`, `fail_closed` |
| `redis.circuit` | `open`, `closed` |
| `redis.retry` | `retry` |

Never written: keys, values, user or college ids, IPs, tokens, URLs, error
messages. A test (`tests/redis-metrics.test.ts`) fails if one appears.

## The metrics the audit asked for

Analytics Engine samples at query time. Always weight by `_sample_interval`.

| Metric | Query shape |
|---|---|
| `redis.command.count` | `sum(_sample_interval)` where `blob1 = 'redis.command'` |
| `redis.command.latency` | `quantileExactWeighted(0.95)(double1, _sample_interval)` where `blob1 = 'redis.command' AND blob3 = 'ok'` |
| `redis.timeout` | `sumIf(_sample_interval, blob3 = 'timeout')` on `redis.command` |
| `redis.circuit_open` | `sumIf(_sample_interval, blob3 = 'circuit_open')` on `redis.command` |
| `redis.cache.hit` / `.miss` / `.stale` / `.error` / `.bypass` | `sumIf(_sample_interval, blob3 = '<outcome>')` on `redis.cache` |
| `redis.rate_limit.allowed` / `.denied` | `sumIf(_sample_interval, blob3 = '<outcome>')` on `redis.rate_limit` |
| `redis.payload_size` | `quantileExactWeighted(0.95)(double3, _sample_interval)` where `blob3 = 'stored'` |

### Hit ratio per cache family, last hour

```sql
SELECT
  blob2 AS family,
  sumIf(_sample_interval, blob3 = 'hit') AS hits,
  sumIf(_sample_interval, blob3 IN ('miss', 'stale')) AS misses,
  sumIf(_sample_interval, blob3 = 'error') AS errors,
  sumIf(_sample_interval, blob3 = 'bypass') AS bypasses,
  hits / (hits + misses) AS hit_ratio
FROM nexus_redis_metrics
WHERE blob1 = 'redis.cache' AND blob5 = 'production'
  AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY family
ORDER BY hits + misses DESC
```

### Command latency and rate per operation, last hour

```sql
SELECT
  blob2 AS operation,
  sum(_sample_interval) AS commands,
  quantileExactWeighted(0.5)(double1, _sample_interval) AS p50_ms,
  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms,
  quantileExactWeighted(0.99)(double1, _sample_interval) AS p99_ms,
  sumIf(_sample_interval, blob3 = 'timeout') AS timeouts,
  sumIf(_sample_interval, blob3 = 'circuit_open') AS circuit_open
FROM nexus_redis_metrics
WHERE blob1 = 'redis.command' AND blob5 = 'production'
  AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY operation
```

### Commands per minute (billing and saturation)

```sql
SELECT
  toStartOfInterval(timestamp, INTERVAL '1' MINUTE) AS minute,
  sum(_sample_interval) AS commands
FROM nexus_redis_metrics
WHERE blob1 = 'redis.command' AND blob5 = 'production'
  AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY minute
ORDER BY minute
```

### Rate-limit decisions per bucket, last day

```sql
SELECT
  blob2 AS bucket,
  sumIf(_sample_interval, blob3 = 'allowed') AS allowed,
  sumIf(_sample_interval, blob3 = 'denied') AS denied,
  sumIf(_sample_interval, blob3 = 'fail_open') AS fail_open,
  sumIf(_sample_interval, blob3 = 'fail_closed') AS fail_closed
FROM nexus_redis_metrics
WHERE blob1 = 'redis.rate_limit' AND blob5 = 'production'
  AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY bucket
ORDER BY denied DESC
```

### Running a query

```sh
curl "https://api.cloudflare.com/client/v4/accounts/<account_id>/analytics_engine/sql" \
  --header "Authorization: Bearer <API token with Account Analytics: Read>" \
  --data "<SQL>"
```

The account id is public in `wrangler whoami`. The token is not in this
repository and must not be added to it.

## Cost

One `writeDataPoint` per Redis event. It is not awaited and never adds latency
to a request. Analytics Engine bills by data points written and queries run.
Check the account's plan before enabling this on high traffic. A signed-in page
writes about six data points today: one per Redis command plus one per cache
or rate-limit decision (`tests/redis-integration.test.ts` pins the sequence).
