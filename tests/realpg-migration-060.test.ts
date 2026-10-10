import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { startCluster, session, concurrently, owner, REAL_PG_AVAILABLE, type Cluster } from "./realpg/harness";
import { U, S, COLLEGE_A } from "./staging/harness";

/**
 * Migration 060 as it would be deployed, on a LOCAL real PostgreSQL:
 *
 * - the payments index build: fails fast (lock_timeout) instead of queueing
 *   every payment write behind a long transaction; an INVALID index left by
 *   a failed CONCURRENTLY pre-build, or a same-named index with another
 *   definition, is replaced; a valid pre-built one is kept;
 * - the upgrade path from the real pre-059 schema: 001..058, data, 059 (with
 *   operations queued through 059's queue_finance_sync_batch), then 060.
 */

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });
const maybe = REAL_PG_AVAILABLE ? describe : describe.skip;
if (!REAL_PG_AVAILABLE) {
  describe("migration 060 deployment (real PostgreSQL)", () => {
    it.skip("BLOCKED: no PostgreSQL binary on this machine", () => {});
  });
}

const ROOT = process.cwd().replace(/\\/g, "/");
const M060 = `${ROOT}/supabase/migrations/060_finance_sync_runs.sql`;
const INDEX = "public.idx_payments_cleared_keyset";
const DEF = "CREATE INDEX idx_payments_cleared_keyset ON public.payments USING btree (college_id, created_at, id) WHERE (status = 'cleared'::text)";
const CONN = "00000094-0000-4000-8000-000000000001";

/** Applies 060 the way a transactional runner does: the whole file in one transaction. */
const apply060 = (cluster: Cluster, db: string, delay = 0) =>
  session(cluster, db, `${delay ? `SELECT pg_sleep(${delay});\n` : ""}BEGIN;\n\\i '${M060}'\nCOMMIT;`);
const indexState = (cluster: Cluster, db: string) =>
  owner(cluster, db, `SELECT COALESCE((SELECT i.indexrelid::oid || '|' || i.indisvalid || '|' || pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indexrelid = to_regclass('${INDEX}')), 'none')`);

maybe("migration 060 deployment (real PostgreSQL)", () => {
  let cluster: Cluster;
  beforeAll(() => {
    cluster = startCluster();
  });
  afterAll(() => cluster?.stop());

  it("the chain builds the index with exactly the definition the guard expects, and re-applying 060 keeps it", async () => {
    const db = cluster.fork();
    try {
      const before = indexState(cluster, db);
      expect(before.split("|").slice(1)).toEqual(["true", DEF]);
      const r = await apply060(cluster, db);
      expect(r.code, r.stderr).toBe(0);
      expect(indexState(cluster, db)).toBe(before); // same oid: not dropped and rebuilt
    } finally {
      cluster.drop(db);
    }
  });

  it("behind a long transaction on payments, the build gives up after lock_timeout (not after the transaction), changes nothing, and succeeds when re-run", async () => {
    const db = cluster.fork();
    try {
      owner(cluster, db, `DROP INDEX ${INDEX}`);
      const started = Date.now();
      const [holder, migration] = await Promise.all([
        // An uncommitted payment write: ROW EXCLUSIVE on payments for 20 s.
        session(
          cluster,
          db,
          `BEGIN;
           SET session_replication_role = replica;
           INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status)
           VALUES ('${COLLEGE_A}', gen_random_uuid(), '${S.a}', 1, 'upi', 'cleared');
           SELECT pg_sleep(20);
           COMMIT;`
        ),
        apply060(cluster, db, 1).then((r) => ({ ...r, ms: Date.now() - started })),
      ]);
      expect(holder.code, holder.stderr).toBe(0);
      expect(migration.code).not.toBe(0);
      expect(migration.stderr).toMatch(/lock timeout/);
      expect(migration.ms).toBeLessThan(12_000); // ~1 s delay + 5 s lock_timeout, not the holder's 20 s
      expect(indexState(cluster, db)).toBe("none");
      const retry = await apply060(cluster, db);
      expect(retry.code, retry.stderr).toBe(0);
      expect(indexState(cluster, db).split("|").slice(1)).toEqual(["true", DEF]);
    } finally {
      cluster.drop(db);
    }
  });

  it("the timed-out build released its place quickly: a payment write issued meanwhile was not held for the holder's 20 s", async () => {
    const db = cluster.fork();
    try {
      owner(cluster, db, `DROP INDEX ${INDEX}`);
      const t0 = Date.now();
      const [, , writer] = await concurrently(
        session(
          cluster,
          db,
          `BEGIN; SET session_replication_role = replica;
           INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status) VALUES ('${COLLEGE_A}', gen_random_uuid(), '${S.a}', 1, 'upi', 'cleared');
           SELECT pg_sleep(20); COMMIT;`
        ),
        apply060(cluster, db, 1),
        // Arrives after the build is queued; would wait behind it for the whole 20 s without lock_timeout.
        session(
          cluster,
          db,
          `SELECT pg_sleep(3); SET session_replication_role = replica;
           INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status) VALUES ('${COLLEGE_A}', gen_random_uuid(), '${S.a}', 2, 'upi', 'cleared');
           SELECT 'WROTE ' || (extract(epoch FROM clock_timestamp()) * 1000)::bigint;`
        )
      );
      expect(writer.code, writer.stderr).toBe(0);
      const wroteAt = Number(writer.stdout.split(/\r?\n/).find((l) => l.startsWith("WROTE "))!.slice(6));
      const holderEnds = t0 + 20_000;
      expect(wroteAt).toBeLessThan(holderEnds - 5_000); // ~6 s, when the build gave up
    } finally {
      cluster.drop(db);
    }
  });

  it("an INVALID index left by a failed CONCURRENTLY build, or a same-named index with another definition, is replaced", async () => {
    const db = cluster.fork();
    try {
      owner(cluster, db, `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${INDEX}'::regclass`);
      expect(indexState(cluster, db).split("|")[1]).toBe("false");
      expect((await apply060(cluster, db)).code).toBe(0);
      expect(indexState(cluster, db).split("|").slice(1)).toEqual(["true", DEF]);

      owner(cluster, db, `DROP INDEX ${INDEX}; CREATE INDEX idx_payments_cleared_keyset ON public.payments (college_id)`);
      expect((await apply060(cluster, db)).code).toBe(0);
      expect(indexState(cluster, db).split("|").slice(1)).toEqual(["true", DEF]);
    } finally {
      cluster.drop(db);
    }
  });

  it("a valid index pre-built with CONCURRENTLY outside any transaction is kept, not rebuilt", async () => {
    const db = cluster.fork();
    try {
      owner(cluster, db, `DROP INDEX ${INDEX}`);
      owner(cluster, db, `CREATE INDEX CONCURRENTLY idx_payments_cleared_keyset ON public.payments (college_id, created_at, id) WHERE status = 'cleared'`);
      const prebuilt = indexState(cluster, db);
      expect(prebuilt.split("|").slice(1)).toEqual(["true", DEF]);
      expect((await apply060(cluster, db)).code).toBe(0);
      expect(indexState(cluster, db)).toBe(prebuilt);
    } finally {
      cluster.drop(db);
    }
  });

  it("upgrade path: 001..058 + data, then 059 with operations queued through queue_finance_sync_batch, then 060 — nothing duplicated, the old function gone", async () => {
    const db = `qa_upgrade_${process.pid}`;
    owner(cluster, "postgres", `CREATE DATABASE ${db}`);
    try {
      const files = readdirSync(join(ROOT, "supabase/migrations")).filter((x) => x.endsWith(".sql")).sort();
      const upTo058 = files.filter((f) => f < "059");
      expect(upTo058.at(-1)).toMatch(/^058_/);
      const run = async (script: string) => {
        const r = await session(cluster, db, script);
        expect(r.code, r.stderr).toBe(0);
        return r;
      };
      await run([`\\i '${ROOT}/tests/staging/platform.sql'`, ...upTo058.map((f) => `\\i '${ROOT}/supabase/migrations/${f}'`), `\\i '${ROOT}/tests/staging/qa-dataset.sql'`].join("\n"));
      owner(
        cluster,
        db,
        `SET session_replication_role = replica;
         INSERT INTO public.finance_integration_connections (id, college_id, display_name, provider, status) VALUES ('${CONN}', '${COLLEGE_A}', 'QA Zoho', 'zoho_books', 'ACTIVE');
         INSERT INTO public.fees (id, college_id, student_id, type, amount, paid_amount, due_date, status)
           SELECT ('00000093-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${COLLEGE_A}', '${S.a}', 'QA', 1000, 0, DATE '2030-01-01', 'pending' FROM generate_series(1, 1500) g;
         INSERT INTO public.payments (id, college_id, fee_id, student_id, amount, method, status, created_at)
           SELECT ('00000092-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${COLLEGE_A}', ('00000093-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
                  '${S.a}', 1000, 'upi', 'cleared', TIMESTAMPTZ '2026-08-01 00:00Z' + (g || ' seconds')::interval FROM generate_series(1, 1500) g;`
      );
      await run(`\\i '${ROOT}/supabase/migrations/${files.find((f) => f.startsWith("059_"))}'`);
      // Under 059: the first 600 queued by the old cursorless function.
      await run(
        `SET request.jwt.claim.sub = '${U.finance}'; SET ROLE authenticated;
         SELECT * FROM public.queue_finance_sync_batch('${CONN}', '2026-08-01', '2026-08-31', NULL, NULL, 600);`
      );
      expect(owner(cluster, db, `SELECT count(*) FROM public.finance_sync_operations`)).toBe("600");

      await run(`BEGIN;\n\\i '${M060}'\nCOMMIT;`);
      expect(owner(cluster, db, `SELECT count(*) FROM pg_proc WHERE proname = 'queue_finance_sync_batch'`)).toBe("0");
      expect(indexState(cluster, db).split("|").slice(1)).toEqual(["true", DEF]);

      const press = await run(
        `SET request.jwt.claim.sub = '${U.finance}'; SET ROLE authenticated;
         SELECT 'STEP ' || run_status || '|' || queued || '|' || scanned FROM public.finance_sync_step('${CONN}', '2026-08-01', '2026-08-31', NULL, 1000);
         SELECT 'STEP ' || run_status || '|' || queued || '|' || scanned FROM public.finance_sync_step('${CONN}', '2026-08-01', '2026-08-31', NULL, 1000);`
      );
      const steps = press.stdout.split(/\r?\n/).filter((l) => l.startsWith("STEP "));
      expect(steps).toEqual(["STEP RUNNING|400|1000", "STEP COMPLETE|500|500"]);
      expect(owner(cluster, db, `SELECT count(*) || '|' || count(DISTINCT entity_id) FROM public.finance_sync_operations`)).toBe("1500|1500");
    } finally {
      owner(cluster, "postgres", `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    }
  });
});
