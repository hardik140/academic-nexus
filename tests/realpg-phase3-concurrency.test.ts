import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startCluster, session, concurrently, owner, REAL_PG_AVAILABLE, type Cluster } from "./realpg/harness";
import { U, S, COLLEGE_A, COLLEGE_B, DEPT_CSE } from "./staging/harness";

/**
 * Redis transformation Phase 3 under REAL concurrency: separate PostgreSQL
 * sessions, real row locks, real unique-index waits (PGlite has one
 * connection and cannot show any of this).
 *
 * - queue_finance_sync_batch (migration 059): ten "Sync now" presses over
 *   the same window at once, and presses overlapping workers that claim
 *   with 056's compare-and-swap. Invariant: one operation per payment,
 *   counted once, claimed at most once.
 * - send_announcement: concurrent sends are each complete and separate.
 */

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });
const maybe = REAL_PG_AVAILABLE ? describe : describe.skip;
if (!REAL_PG_AVAILABLE) {
  describe("Phase 3 concurrency (real PostgreSQL)", () => {
    it.skip("BLOCKED: no PostgreSQL binary on this machine", () => {});
  });
}

const CONN = "00000094-0000-4000-8000-000000000001";
const PAYMENTS = 1200;
const LINKED = 30;

function seedSyncWindow(cluster: Cluster, db: string) {
  owner(
    cluster,
    db,
    `SET session_replication_role = replica;
     INSERT INTO public.finance_integration_connections (id, college_id, display_name, provider, status)
       VALUES ('${CONN}', '${COLLEGE_A}', 'QA Zoho', 'zoho_books', 'ACTIVE');
     INSERT INTO public.fees (id, college_id, student_id, type, amount, paid_amount, due_date, status)
       SELECT ('00000093-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${COLLEGE_A}', '${S.a}', 'QA sync', 1000, 0, DATE '2030-01-01', 'pending'
       FROM generate_series(1, ${PAYMENTS}) g;
     INSERT INTO public.payments (id, college_id, fee_id, student_id, amount, method, status, created_at)
       SELECT ('00000092-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${COLLEGE_A}',
              ('00000093-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${S.a}', 1000, 'upi', 'cleared',
              TIMESTAMPTZ '2026-08-01 00:00Z' + (g || ' minutes')::interval
       FROM generate_series(1, ${PAYMENTS}) g;
     INSERT INTO public.finance_external_links (college_id, connection_id, entity_type, entity_id, external_id)
       SELECT '${COLLEGE_A}', '${CONN}', 'payment', ('00000092-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'EXT-' || g
       FROM generate_series(1, ${LINKED}) g;`
  );
}

/**
 * One "Sync now" press, as syncNow() makes it: one call per batch, each its
 * OWN statement and so its own transaction (autocommit), the cursor carried
 * between them. Batches of 100, so 1,200 payments take 12 calls plus the
 * short one; the extra calls after it return nothing. Prints
 * "PRESS queued|skipped|scanned".
 */
const BATCH_CALL = `WITH r AS (SELECT * FROM public.queue_finance_sync_batch('${CONN}', '2026-08-01', '2026-08-31', (SELECT c FROM press_cursor), (SELECT i FROM press_cursor), 100))
UPDATE press_cursor SET c = COALESCE(r.last_created, press_cursor.c), i = COALESCE(r.last_id, press_cursor.i),
       q = q + r.queued, s = s + r.skipped, n = n + r.scanned FROM r;`;
const PRESS = [
  "CREATE TEMP TABLE press_cursor (c TIMESTAMPTZ, i UUID, q INT, s INT, n INT);",
  "INSERT INTO press_cursor VALUES (NULL, NULL, 0, 0, 0);",
  ...Array.from({ length: 14 }, () => BATCH_CALL),
  "SELECT 'PRESS ' || q || '|' || s || '|' || n FROM press_cursor;",
].join("\n");

/**
 * A worker: claims QUEUED operations with 056's compare-and-swap, one
 * operation per statement (each its own transaction, as the real worker's
 * update is), many times over. Prints "WON <id>" for each claim it wins.
 */
const CLAIM = `WITH c AS (SELECT id, attempt_number FROM public.finance_sync_operations
               WHERE connection_id = '${CONN}' AND status = 'QUEUED' ORDER BY random() LIMIT 1),
     w AS (UPDATE public.finance_sync_operations o
              SET status = 'PROCESSING', started_at = clock_timestamp(), attempt_number = c.attempt_number + 1
             FROM c WHERE o.id = c.id AND o.status = 'QUEUED' AND o.attempt_number = c.attempt_number
           RETURNING o.id)
SELECT 'WON ' || id FROM w;`;
/**
 * The worker first waits (up to 60 s) until a press has committed an
 * operation, so the claims really do overlap the presses whatever the
 * machine's load: under a busy full suite the workers could otherwise finish
 * before the first press had queued anything.
 */
const WAIT_FOR_WORK = `DO $$
DECLARE i int := 0;
BEGIN
  WHILE i < 6000 AND NOT EXISTS (SELECT 1 FROM public.finance_sync_operations WHERE connection_id = '${CONN}' AND status = 'QUEUED') LOOP
    PERFORM pg_sleep(0.01);
    i := i + 1;
  END LOOP;
END $$;`;
const WORKER = [WAIT_FOR_WORK, ...Array.from({ length: 400 }, (_, i) => (i % 20 === 19 ? "SELECT pg_sleep(0.02);" : CLAIM))].join("\n");

const lines = (stdout: string, tag: string) => stdout.split(/\r?\n/).filter((l) => l.startsWith(`${tag} `)).map((l) => l.slice(tag.length + 1).trim());

maybe("Phase 3 concurrency (real PostgreSQL)", () => {
  let cluster: Cluster;
  beforeAll(() => {
    cluster = startCluster();
  });
  afterAll(() => cluster?.stop());

  it("ten concurrent Sync Now presses over 1,200 payments: one operation per postable payment, each counted once", async () => {
    const db = cluster.fork();
    try {
      seedSyncWindow(cluster, db);
      const results = await concurrently(...Array.from({ length: 10 }, () => session(cluster, db, PRESS, U.finance)));
      for (const r of results) expect(r.code, r.stderr).toBe(0);
      const presses = results.map((r) => lines(r.stdout, "PRESS")[0].split("|").map(Number));
      // Every press scanned the whole window; between them, every postable
      // payment was queued exactly once.
      for (const [, skipped, scanned] of presses) {
        expect(scanned).toBe(PAYMENTS);
        expect(skipped).toBe(LINKED);
      }
      expect(presses.reduce((sum, [queued]) => sum + queued, 0)).toBe(PAYMENTS - LINKED);

      const [ops, distinct, queued, linkedOps] = owner(
        cluster,
        db,
        `SELECT count(*), count(DISTINCT entity_id), count(*) FILTER (WHERE status = 'QUEUED'),
                count(*) FILTER (WHERE entity_id IN (SELECT entity_id FROM public.finance_external_links WHERE connection_id = '${CONN}'))
         FROM public.finance_sync_operations WHERE connection_id = '${CONN}'`
      ).split("|").map(Number);
      expect({ ops, distinct, queued, linkedOps }).toEqual({ ops: PAYMENTS - LINKED, distinct: PAYMENTS - LINKED, queued: PAYMENTS - LINKED, linkedOps: 0 });
    } finally {
      cluster.drop(db);
    }
  });

  it("Sync Now presses overlapping five workers: no operation duplicated, none claimed twice, no invalid transition", async () => {
    const db = cluster.fork();
    try {
      seedSyncWindow(cluster, db);
      const runs = await concurrently(
        ...Array.from({ length: 5 }, () => session(cluster, db, PRESS, U.finance)),
        ...Array.from({ length: 5 }, () => session(cluster, db, WORKER))
      );
      for (const r of runs) expect(r.code, r.stderr).toBe(0);
      const wonIds = runs.slice(5).flatMap((r) => lines(r.stdout, "WON"));
      expect(new Set(wonIds).size).toBe(wonIds.length); // no operation won by two workers
      expect(wonIds.length).toBeGreaterThan(0); // the workers really did overlap the presses

      const [ops, distinct, processing, attemptsAboveOne, stillQueued] = owner(
        cluster,
        db,
        `SELECT count(*), count(DISTINCT entity_id), count(*) FILTER (WHERE status = 'PROCESSING'),
                count(*) FILTER (WHERE attempt_number > 1), count(*) FILTER (WHERE status = 'QUEUED')
         FROM public.finance_sync_operations WHERE connection_id = '${CONN}'`
      ).split("|").map(Number);
      expect(ops).toBe(PAYMENTS - LINKED);
      expect(distinct).toBe(PAYMENTS - LINKED);
      expect(processing).toBe(wonIds.length);
      expect(attemptsAboveOne).toBe(0);
      expect(processing + stillQueued).toBe(PAYMENTS - LINKED);
    } finally {
      cluster.drop(db);
    }
  });

  it("finance of college B cannot queue college A's connection, even concurrently with A", async () => {
    const db = cluster.fork();
    try {
      seedSyncWindow(cluster, db);
      const bFinance = "00000003-0000-4000-8000-0000000000f1";
      owner(
        cluster,
        db,
        `SET session_replication_role = replica;
         INSERT INTO auth.users (id) VALUES ('${bFinance}') ON CONFLICT DO NOTHING;
         INSERT INTO public.profiles (id, college_id, email, full_name, role, status)
         VALUES ('${bFinance}', '${COLLEGE_B}', 'bfin@qa.test', 'B Finance', 'finance', 'active');`
      );
      const [a, b] = await concurrently(session(cluster, db, PRESS, U.finance), session(cluster, db, PRESS, bFinance));
      expect(a.code, a.stderr).toBe(0);
      expect(b.code).not.toBe(0);
      expect(b.stderr).toMatch(/connection not found in your college/);
      const created = owner(cluster, db, `SELECT count(DISTINCT created_by) FROM public.finance_sync_operations WHERE connection_id = '${CONN}'`);
      expect(created).toBe("1");
    } finally {
      cluster.drop(db);
    }
  });

  it("five concurrent announcements to 1,500 students: each complete, each separate, no duplicates", async () => {
    const db = cluster.fork();
    try {
      owner(
        cluster,
        db,
        `SET session_replication_role = replica;
         INSERT INTO auth.users (id) SELECT ('0000009f-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid FROM generate_series(1, 1500) g ON CONFLICT DO NOTHING;
         INSERT INTO public.profiles (id, college_id, email, full_name, role, status)
           SELECT ('0000009f-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${COLLEGE_A}', 'c' || g || '@qa.test', 'QA ' || g, 'student', 'active'
           FROM generate_series(1, 1500) g;
         INSERT INTO public.students (id, college_id, user_id, department_id, enrollment_number, batch_year, status)
           SELECT ('00000099-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${COLLEGE_A}',
                  ('0000009f-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${DEPT_CSE}', 'C-' || g, 2025, 'active'
           FROM generate_series(1, 1500) g;`
      );
      const students = Number(owner(cluster, db, `SELECT count(*) FROM public.profiles WHERE college_id = '${COLLEGE_A}' AND role = 'student'`));
      const sends = await concurrently(
        ...Array.from({ length: 5 }, (_, i) =>
          session(cluster, db, `SELECT recipient_count FROM public.send_announcement('${COLLEGE_A}', 'Notice ${i}', 'Body', 'students');`, U.director)
        )
      );
      for (const r of sends) {
        expect(r.code, r.stderr).toBe(0);
        expect(Number(r.stdout.split(/\r?\n/).pop())).toBe(students);
      }
      const [announcements, rows, dupes] = owner(
        cluster,
        db,
        `SELECT count(DISTINCT announcement_id), count(*),
                count(*) - count(DISTINCT (announcement_id, receiver_id))
         FROM public.notifications WHERE title LIKE 'Notice %'`
      ).split("|").map(Number);
      expect({ announcements, rows, dupes }).toEqual({ announcements: 5, rows: 5 * students, dupes: 0 });
    } finally {
      cluster.drop(db);
    }
  });
});
