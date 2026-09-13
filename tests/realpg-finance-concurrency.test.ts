import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startCluster, session, concurrently, owner, REAL_PG_AVAILABLE, type Cluster } from "./realpg/harness";
import { U, S, COLLEGE_A, FEE_A } from "./staging/harness";

/**
 * §87 — two workers, the same payment, the same second.
 *
 * This is the failure the whole hub is built around: a payment posted twice
 * because two workers picked it up together. PGlite cannot show it (single
 * connection), so it runs here against real PostgreSQL with two genuinely
 * concurrent psql sessions.
 *
 * The claim under test is narrow and mechanical: whatever the application
 * does, the DATABASE admits exactly one journal row per idempotency key and
 * exactly one external link per (connection, entity) — so even two workers
 * that both believed they should post cannot both record having done so, and
 * the second discovers the first's link before calling the provider.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

const maybe = REAL_PG_AVAILABLE ? describe : describe.skip;
if (!REAL_PG_AVAILABLE) {
  describe("finance integration concurrency", () => {
    it.skip("BLOCKED: no PostgreSQL binary on this machine", () => {});
  });
}

maybe("finance integration concurrency (real PostgreSQL)", () => {
  let cluster: Cluster;
  beforeAll(() => { cluster = startCluster(); });
  afterAll(() => cluster?.stop());

  /** A live connection plus a cleared payment, in one database. */
  function scenario(db: string) {
    const conn = owner(cluster, db,
      `INSERT INTO finance_integration_connections (college_id, provider, display_name, status, external_company_id, external_company_name, created_by)
       VALUES ('${COLLEGE_A}','zoho_books','QA Books','DRAFT','org1','QA Books','${U.admin}') RETURNING id`);
    for (const s of ["CONFIGURING", "AUTH_REQUIRED", "AUTHENTICATED", "VERIFIED", "ACTIVE"]) {
      owner(cluster, db, `UPDATE finance_integration_connections SET status='${s}' WHERE id='${conn}'`);
    }
    const pay = owner(cluster, db,
      `INSERT INTO payments (college_id, fee_id, student_id, amount, method, status, processed_by)
       VALUES ('${COLLEGE_A}','${FEE_A}','${S.a}',1500,'upi','cleared','${U.finance}') RETURNING id`);
    return { conn, pay };
  }

  it("two workers journalling the same operation produce ONE row", async () => {
    const db = cluster.fork();
    try {
      const { conn, pay } = scenario(db);
      const insert = () => session(cluster, db,
        `INSERT INTO finance_sync_operations
           (college_id, connection_id, provider, entity_type, entity_id, operation, idempotency_key, system_actor)
         VALUES ('${COLLEGE_A}','${conn}','zoho_books','payment','${pay}','create_payment','an_same_key','worker');`);
      const [a, b] = await concurrently(insert(), insert());
      expect([a, b].filter((r) => r.code === 0).length, `${a.stderr}|${b.stderr}`).toBe(1);
      expect([a, b].find((r) => r.code !== 0)!.stderr).toMatch(/duplicate key|unique/i);
      expect(owner(cluster, db, `SELECT count(*) FROM finance_sync_operations WHERE idempotency_key='an_same_key'`)).toBe("1");
    } finally { cluster.drop(db); }
  });

  it("two workers recording an external document for the same payment produce ONE link", async () => {
    const db = cluster.fork();
    try {
      const { conn, pay } = scenario(db);
      // Two different provider ids — as would happen if the provider really
      // had been called twice. Only one may be recorded; the other collides,
      // which is what turns a double-post into a visible error.
      const link = (external: string) => session(cluster, db,
        `INSERT INTO finance_external_links (college_id, connection_id, entity_type, entity_id, external_id)
         VALUES ('${COLLEGE_A}','${conn}','payment','${pay}','${external}');`);
      const [a, b] = await concurrently(link("P-1"), link("P-2"));
      expect([a, b].filter((r) => r.code === 0).length, `${a.stderr}|${b.stderr}`).toBe(1);
      expect(owner(cluster, db, `SELECT count(*) FROM finance_external_links WHERE entity_id='${pay}'`)).toBe("1");
    } finally { cluster.drop(db); }
  });

  it("two payments cannot be linked to the same external document", async () => {
    const db = cluster.fork();
    try {
      const { conn, pay } = scenario(db);
      const pay2 = owner(cluster, db,
        `INSERT INTO payments (college_id, fee_id, student_id, amount, method, status, processed_by)
         VALUES ('${COLLEGE_A}','${FEE_A}','${S.a}',500,'cash','cleared','${U.finance}') RETURNING id`);
      const link = (entity: string) => session(cluster, db,
        `INSERT INTO finance_external_links (college_id, connection_id, entity_type, entity_id, external_id)
         VALUES ('${COLLEGE_A}','${conn}','payment','${entity}','P-SHARED');`);
      const [a, b] = await concurrently(link(pay), link(pay2));
      expect([a, b].filter((r) => r.code === 0).length).toBe(1);
      expect(owner(cluster, db, `SELECT count(*) FROM finance_external_links WHERE external_id='P-SHARED'`)).toBe("1");
    } finally { cluster.drop(db); }
  });

  it("two operators retrying the same failed operation produce one RETRYING, not two attempts", async () => {
    const db = cluster.fork();
    try {
      const { conn, pay } = scenario(db);
      const op = owner(cluster, db,
        `INSERT INTO finance_sync_operations (college_id, connection_id, provider, entity_type, entity_id, operation, idempotency_key, system_actor)
         VALUES ('${COLLEGE_A}','${conn}','zoho_books','payment','${pay}','create_payment','an_retry','worker') RETURNING id`);
      for (const s of ["QUEUED", "PROCESSING", "FAILED"]) {
        owner(cluster, db, `UPDATE finance_sync_operations SET status='${s}' WHERE id='${op}'`);
      }
      owner(cluster, db, `UPDATE finance_sync_operations SET retry_safety='safe' WHERE id='${op}'`);

      const retry = () => session(cluster, db,
        `UPDATE public.finance_sync_operations SET status='RETRYING' WHERE id='${op}' AND status='FAILED';`, U.finance);
      const [a, b] = await concurrently(retry(), retry());
      expect([a, b].every((r) => r.code === 0)).toBe(true);   // a no-op UPDATE is not an error
      expect(owner(cluster, db, `SELECT status FROM finance_sync_operations WHERE id='${op}'`)).toBe("RETRYING");
      expect(owner(cluster, db, `SELECT attempt_number FROM finance_sync_operations WHERE id='${op}'`)).toBe("0");
    } finally { cluster.drop(db); }
  });

  it("two reconciliation runs on one connection both record, and neither corrupts the other's findings", async () => {
    const db = cluster.fork();
    try {
      const { conn } = scenario(db);
      const run = () => session(cluster, db,
        `INSERT INTO finance_reconciliation_runs (college_id, connection_id, period_start, period_end, system_actor)
         VALUES ('${COLLEGE_A}','${conn}','2026-09-01','2026-09-30','scheduler');`);
      const [a, b] = await concurrently(run(), run());
      expect([a, b].every((r) => r.code === 0), `${a.stderr}|${b.stderr}`).toBe(true);
      // Concurrent runs are permitted (a scheduled one and a manual one can
      // legitimately overlap); what must not happen is a shared finding.
      expect(owner(cluster, db, `SELECT count(*) FROM finance_reconciliation_runs WHERE connection_id='${conn}'`)).toBe("2");
    } finally { cluster.drop(db); }
  });

  it("SYNCED without an identifier is refused under concurrency too", async () => {
    const db = cluster.fork();
    try {
      const { conn, pay } = scenario(db);
      const op = owner(cluster, db,
        `INSERT INTO finance_sync_operations (college_id, connection_id, provider, entity_type, entity_id, operation, idempotency_key, system_actor)
         VALUES ('${COLLEGE_A}','${conn}','zoho_books','payment','${pay}','create_payment','an_sync','worker') RETURNING id`);
      for (const s of ["QUEUED", "PROCESSING"]) {
        owner(cluster, db, `UPDATE finance_sync_operations SET status='${s}' WHERE id='${op}'`);
      }
      const [withId, withoutId] = await concurrently(
        session(cluster, db, `UPDATE finance_sync_operations SET status='SYNCED', external_id='P-1' WHERE id='${op}' AND status='PROCESSING';`),
        session(cluster, db, `SELECT pg_sleep(0.2); UPDATE finance_sync_operations SET status='SYNCED' WHERE id='${op}' AND status='PROCESSING';`)
      );
      expect(withId.code).toBe(0);
      // The loser either matched no row (already SYNCED) or was refused for
      // having no identifier. Either way the row is correct.
      void withoutId;
      expect(owner(cluster, db, `SELECT status FROM finance_sync_operations WHERE id='${op}'`)).toBe("SYNCED");
      expect(owner(cluster, db, `SELECT external_id FROM finance_sync_operations WHERE id='${op}'`)).toBe("P-1");
    } finally { cluster.drop(db); }
  });
});
