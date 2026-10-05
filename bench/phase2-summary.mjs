// Median across the alternating runs of bench/phase2.bench.ts:
//   node bench/phase2-summary.mjs  ->  bench/results/phase2-summary.json
import { readFileSync, writeFileSync } from "node:fs";
const load = (l) => [1, 2, 3].map((i) => JSON.parse(readFileSync(`bench/results/phase2-${l}-${i}.json`, "utf8")));
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pick = (runs, path) => med(runs.map((r) => path.split(".").reduce((o, k) => o?.[k], r)).filter((v) => typeof v === "number"));
const side = (runs) => ({
  middlewareWarm: {
    p50: pick(runs, "middleware.warm.latencyMs.p50"), p95: pick(runs, "middleware.warm.latencyMs.p95"), p99: pick(runs, "middleware.warm.latencyMs.p99"),
    redisRoundTrips: pick(runs, "middleware.warm.redisRoundTripsPerRequest"), redisCommands: pick(runs, "middleware.warm.redisCommandsPerRequest"),
    dbQueries: pick(runs, "middleware.warm.dbQueriesPerRequest"),
  },
  middlewareCold: {
    p50: pick(runs, "middleware.cold.latencyMs.p50"), p95: pick(runs, "middleware.cold.latencyMs.p95"), p99: pick(runs, "middleware.cold.latencyMs.p99"),
    redisRoundTrips: pick(runs, "middleware.cold.redisRoundTripsPerRequest"), redisCommands: pick(runs, "middleware.cold.redisCommandsPerRequest"),
    dbQueries: pick(runs, "middleware.cold.dbQueriesPerRequest"),
  },
  cacheMissPlain: { p50: pick(runs, "cacheSequential.missLatencyMs.p50"), p95: pick(runs, "cacheSequential.missLatencyMs.p95"), p99: pick(runs, "cacheSequential.missLatencyMs.p99") },
  cacheMissWriteBehind: { p50: pick(runs, "cacheWriteBehind.missLatencyMs.p50"), p95: pick(runs, "cacheWriteBehind.missLatencyMs.p95"), p99: pick(runs, "cacheWriteBehind.missLatencyMs.p99") },
  cacheHit: { p50: pick(runs, "cacheSequential.hitLatencyMs.p50"), p95: pick(runs, "cacheSequential.hitLatencyMs.p95"), p99: pick(runs, "cacheSequential.hitLatencyMs.p99") },
  hitRatio: pick(runs, "cacheSequential.hitRatio"),
  stampede: Object.fromEntries([1, 10, 50, 100].map((n) => [n, { dbQueries: pick(runs, `stampede.concurrent_${n}.dbQueries`), redisRoundTrips: pick(runs, `stampede.concurrent_${n}.redisRoundTrips`), redisCommands: pick(runs, `stampede.concurrent_${n}.redisCommands`), wallMs: pick(runs, `stampede.concurrent_${n}.wallMs`) }])),
  paymentInvalidation: { redisRoundTrips: pick(runs, "paymentInvalidation.redisRoundTrips"), redisCommands: pick(runs, "paymentInvalidation.redisCommands"), latencyMs: pick(runs, "paymentInvalidation.latencyMs") },
});
const out = { note: "LOCAL; median of 3 alternating runs; counts exact, latency modelled (Redis 4 ms, DB 10 ms, Auth 15 ms per call)", before: side(load("before")), after: side(load("after")) };
writeFileSync("bench/results/phase2-summary.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 1));
