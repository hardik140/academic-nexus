import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startCluster, session, concurrently, owner, REAL_PG_AVAILABLE, type Cluster } from "./realpg/harness";
import { U, S, COLLEGE_A, COLLEGE_B, DEPT_CSE } from "./staging/harness";

/**
 * Redis transformation Phase 3 under REAL concurrency: separate PostgreSQL
 * sessions, real row locks, real unique-index waits (PGlite has one
 * connection and cannot show any of this).
 *
 * - finance_sync_step (migration 060): a run past 100,000 payments finished
 *   by a second press; ten "Sync now" presses at once; presses overlapping
 *   workers that claim with 056's compare-and-swap; a backend killed in the
 *   middle of a batch. Invariant: one operation per payment, each batch
 *   processed once, claimed at most once.
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
const pid = (g: number) => `00000092-0000-4000-8000-${String(g).padStart(12, "0")}`;

function seedSyncWindow(cluster: Cluster, db: string, payments = PAYMENTS, linked = LINKED) {
  owner(
    cluster,
    db,
    `SET session_replication_role = replica;
     INSERT INTO public.finance_integration_connections (id, college_id, display_name, provider, status)
       VALUES ('${CONN}', '${COLLEGE_A}', 'QA Zoho', 'zoho_books', 'ACTIVE');
     INSERT INTO public.fees (id, college_id, student_id, type, amount, paid_amount, due_date, status)
       SELECT ('00000093-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${COLLEGE_A}', '${S.a}', 'QA sync', 1000, 0, DATE '2030-01-01', 'pending'
       FROM generate_series(1, ${payments}) g;
     INSERT INTO public.payments (id, college_id, fee_id, student_id, amount, method, status, created_at)
       SELECT ('00000092-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${COLLEGE_A}',
              ('00000093-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${S.a}', 1000, 'upi', 'cleared',
              TIMESTAMPTZ '2026-08-01 00:00Z' + ((g / 2) || ' seconds')::interval
       FROM generate_series(1, ${payments}) g;
     INSERT INTO public.finance_external_links (college_id, connection_id, entity_type, entity_id, external_id)
       SELECT '${COLLEGE_A}', '${CONN}', 'payment', ('00000092-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'EXT-' || g
       FROM generate_series(1, ${linked}) g;
     ANALYZE public.payments;`
  );
}

/**
 * One "Sync now" press, as syncNow() makes it: at most `batches` calls, each
 * its OWN statement and so its own transaction (autocommit), the run id
 * carried from the first. A call after the run completes returns its final
 * state and scans nothing. Prints "PRESS run|status|queued|skipped|scanned".
 */
function pressScript(batches: number, limit: number): string {
  const step = `WITH r AS (SELECT * FROM public.finance_sync_step('${CONN}', '2026-08-01', '2026-08-31', (SELECT run FROM press), ${limit}))
UPDATE press SET run = r.run_id, status = COALESCE(r.error, r.run_status), q = q + r.queued, s = s + r.skipped, n = n + r.scanned FROM r;`;
  return [
    "CREATE TEMP TABLE press (run UUID, status TEXT, q INT, s INT, n INT);",
    "INSERT INTO press VALUES (NULL, NULL, 0, 0, 0);",
    ...Array.from({ length: batches }, () => step),
    "SELECT 'PRESS ' || run || '|' || status || '|' || q || '|' || s || '|' || n FROM press;",
  ].join("\n");
}
const PRESS = pressScript(30, 100);

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
const pressOf = (stdout: string) => {
  const [run, status, q, s, n] = lines(stdout, "PRESS")[0].split("|");
  return { run, status, queued: Number(q), skipped: Number(s), scanned: Number(n) };
};
const opsSummary = (cluster: Cluster, db: string) => {
  const [ops, distinct, linkedOps] = owner(
    cluster,
    db,
    `SELECT count(*), count(DISTINCT entity_id),
            count(*) FILTER (WHERE entity_id IN (SELECT entity_id FROM public.finance_external_links WHERE connection_id = '${CONN}'))
     FROM public.finance_sync_operations WHERE connection_id = '${CONN}'`
  ).split("|").map(Number);
  return { ops, distinct, linkedOps };
};

maybe("Phase 3 concurrency (real PostgreSQL)", () => {
  let cluster: Cluster;
  beforeAll(() => {
    cluster = startCluster();
  });
  afterAll(() => cluster?.stop());

  it("100,500 payments: the first press stops at 200 × 500 and says so; the next press finishes the SAME run past the old ceiling", async () => {
    const db = cluster.fork();
    const total = 100_500;
    try {
      seedSyncWindow(cluster, db, total, 0);
      const first = await session(cluster, db, pressScript(200, 500), U.finance);
      expect(first.code, first.stderr).toBe(0);
      const p1 = pressOf(first.stdout);
      expect(p1).toMatchObject({ status: "RUNNING", scanned: 100_000, queued: 100_000 });

      // A separate process, knowing nothing of the first (as after a restart).
      const second = await session(cluster, db, pressScript(200, 500), U.finance);
      expect(second.code, second.stderr).toBe(0);
      const p2 = pressOf(second.stdout);
      expect(p2).toMatchObject({ run: p1.run, status: "COMPLETE", scanned: 500, queued: 500 });

      expect(opsSummary(cluster, db)).toEqual({ ops: total, distinct: total, linkedOps: 0 });
      const past = owner(cluster, db, `SELECT count(*) FROM public.finance_sync_operations WHERE connection_id = '${CONN}' AND entity_id IN ('${pid(100_001)}', '${pid(100_500)}')`);
      expect(past).toBe("2");
      const run = owner(cluster, db, `SELECT status || '|' || batches || '|' || scanned FROM public.finance_sync_runs WHERE id = '${p1.run}'`);
      expect(run).toBe("COMPLETE|202|100500");
    } finally {
      cluster.drop(db);
    }
  });

  it("ten concurrent Sync Now presses over 1,200 payments: they share one run, each batch is processed once, one operation per payment", async () => {
    const db = cluster.fork();
    try {
      seedSyncWindow(cluster, db);
      const results = await concurrently(...Array.from({ length: 10 }, () => session(cluster, db, PRESS, U.finance)));
      for (const r of results) expect(r.code, r.stderr).toBe(0);
      const presses = results.map((r) => pressOf(r.stdout));
      for (const p of presses) expect(p.status).toBe("COMPLETE");
      // A press that started after the run completed opens a fresh run that
      // rescans and queues nothing; normally all ten share the first.
      const runs = new Set(presses.map((p) => p.run)).size;
      expect(presses.reduce((sum, p) => sum + p.scanned, 0)).toBe(PAYMENTS * runs); // each batch by exactly one press
      expect(presses.reduce((sum, p) => sum + p.queued, 0)).toBe(PAYMENTS - LINKED);
      expect(presses.reduce((sum, p) => sum + p.skipped, 0)).toBe(LINKED * runs);
      expect(opsSummary(cluster, db)).toEqual({ ops: PAYMENTS - LINKED, distinct: PAYMENTS - LINKED, linkedOps: 0 });
      expect(owner(cluster, db, `SELECT count(*) FROM public.finance_sync_runs WHERE status = 'RUNNING'`)).toBe("0");
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

  it("a backend killed in the middle of a batch: its operations and cursor roll back together; the next press redoes exactly that batch", async () => {
    const db = cluster.fork();
    try {
      seedSyncWindow(cluster, db, 500, 0);
      const ok = await session(cluster, db, pressScript(2, 100), U.finance);
      expect(pressOf(ok.stdout)).toMatchObject({ status: "RUNNING", scanned: 200 });
      // The third batch runs inside a transaction whose backend then dies.
      const killed = await session(
        cluster,
        db,
        `BEGIN;
         SELECT 'MID ' || scanned FROM public.finance_sync_step('${CONN}', '2026-08-01', '2026-08-31', NULL, 100);
         RESET ROLE;
         SELECT pg_terminate_backend(pg_backend_pid());`,
        U.finance
      );
      expect(lines(killed.stdout, "MID")).toEqual(["100"]); // it did the work...
      expect(killed.code).not.toBe(0); // ...and never committed it
      expect(owner(cluster, db, `SELECT scanned || '|' || cursor_id FROM public.finance_sync_runs`)).toBe(`200|${pid(200)}`);
      expect(opsSummary(cluster, db).ops).toBe(200);

      const rest = await session(cluster, db, pressScript(10, 100), U.finance);
      expect(pressOf(rest.stdout)).toMatchObject({ status: "COMPLETE", scanned: 300, queued: 300 });
      expect(opsSummary(cluster, db)).toEqual({ ops: 500, distinct: 500, linkedOps: 0 });
    } finally {
      cluster.drop(db);
    }
  });

  it("finance of college B cannot drive college A's connection or run, even concurrently with A", async () => {
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
      expect(owner(cluster, db, `SELECT count(DISTINCT created_by) FROM public.finance_sync_operations WHERE connection_id = '${CONN}'`)).toBe("1");
      expect(owner(cluster, db, `SELECT count(DISTINCT created_by) || '|' || count(*) FROM public.finance_sync_runs`)).toBe("1|1");
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
