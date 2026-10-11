/**
 * Migration 060's only index on an existing table, measured on a LOCAL real
 * PostgreSQL (tests/realpg harness; never a hosted database):
 *
 *   CREATE INDEX IF NOT EXISTS idx_payments_cleared_keyset
 *     ON public.payments (college_id, created_at, id) WHERE status = 'cleared';
 *
 * For each payments size: how long the plain build holds its SHARE lock
 * (payment writes wait for exactly this long), and the cost of one
 * finance_sync_step / reconciliation page query with and without it.
 *
 *   npx tsx bench/phase3-index-build.ts
 */
import { writeFileSync } from "node:fs";
import { startCluster, owner, REAL_PG_AVAILABLE } from "../tests/realpg/harness";
import { COLLEGE_A, COLLEGE_B, S } from "../tests/staging/harness";

if (!REAL_PG_AVAILABLE) {
  console.log("BLOCKED: no PostgreSQL binary on this machine");
  process.exit(0);
}

const SIZES = [100_000, 1_000_000];
// One batch of a run half-way through the window, exactly as finance_sync_step reads it.
const BATCH = (cursorSql: string) => `
  SELECT p.id, p.created_at FROM public.payments p
  WHERE p.college_id = '${COLLEGE_A}' AND p.status = 'cleared'
    AND p.created_at >= '2026-01-01'::timestamp AT TIME ZONE 'UTC'
    AND p.created_at < '2027-01-01'::timestamp AT TIME ZONE 'UTC'
    AND p.created_at <= now()
    AND (p.created_at, p.id) > (${cursorSql})
  ORDER BY p.created_at, p.id LIMIT 500`;

function execMs(cluster: ReturnType<typeof startCluster>, db: string, sql: string): number {
  // Best of three: EXPLAIN ANALYZE's own execution time, no client overhead.
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const plan = owner(cluster, db, `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`);
    best = Math.min(best, JSON.parse(plan)[0]["Execution Time"]);
  }
  return Math.round(best * 10) / 10;
}

const cluster = startCluster();
const results: Record<string, unknown>[] = [];
try {
  for (const n of SIZES) {
    const db = cluster.fork();
    try {
      // Three colleges' worth of rows, 80% cleared, a year of timestamps.
      owner(
        cluster,
        db,
        `SET session_replication_role = replica;
         DROP INDEX IF EXISTS public.idx_payments_cleared_keyset;
         INSERT INTO public.payments (id, college_id, fee_id, student_id, amount, method, status, created_at)
         SELECT gen_random_uuid(), CASE WHEN g % 3 = 0 THEN '${COLLEGE_B}'::uuid ELSE '${COLLEGE_A}'::uuid END,
                gen_random_uuid(), '${S.a}', 1000, 'upi', CASE WHEN g % 5 = 0 THEN 'pending' ELSE 'cleared' END,
                TIMESTAMPTZ '2026-01-01 00:00Z' + (g * (31536000.0 / ${n})) * interval '1 second'
         FROM generate_series(1, ${n}) g;
         ANALYZE public.payments;`
      );
      const mid = `SELECT created_at, id FROM public.payments WHERE college_id = '${COLLEGE_A}' AND status = 'cleared' ORDER BY created_at, id OFFSET ${Math.floor(n / 3)} LIMIT 1`;
      const cursor = owner(cluster, db, mid).split("|");
      const cursorSql = `'${cursor[0]}'::timestamptz, '${cursor[1]}'::uuid`;
      const without = execMs(cluster, db, BATCH(cursorSql));

      const t0 = performance.now();
      owner(cluster, db, `CREATE INDEX IF NOT EXISTS idx_payments_cleared_keyset ON public.payments (college_id, created_at, id) WHERE status = 'cleared'`);
      const buildMs = Math.round(performance.now() - t0);
      owner(cluster, db, "ANALYZE public.payments");
      const withIdx = execMs(cluster, db, BATCH(cursorSql));
      const size = owner(cluster, db, `SELECT pg_size_pretty(pg_relation_size('public.idx_payments_cleared_keyset'))`);

      const row = { payments: n, build_ms_incl_psql_start: buildMs, index_size: size, batch_ms_without_index: without, batch_ms_with_index: withIdx };
      results.push(row);
      console.log(JSON.stringify(row));
    } finally {
      cluster.drop(db);
    }
  }
} finally {
  cluster.stop();
}
writeFileSync("bench/results/phase3-index-build-local.json", JSON.stringify({ label: "LOCAL", engine: "tests/realpg harness, fsync=off", results }, null, 2) + "\n");
