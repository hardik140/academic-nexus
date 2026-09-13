import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { stagingDb, as, verify, scalar, U, S, COLLEGE_A, COLLEGE_B, FEE_A } from "./staging/harness";

/**
 * Finance Integration Hub — the guarantees the DATABASE keeps (migration 049).
 *
 * Everything here is proven by reading rows back as the owner after acting
 * as a real role, because an RLS-filtered UPDATE reports success with zero
 * rows (the C3 rule that runs through this whole test suite).
 *
 * The load-bearing one, stated first because the rest is detail:
 *
 *     status = 'SYNCED' is impossible without an external identifier.
 *
 * An HTTP 200 is not an acknowledgement. If that constraint ever comes out,
 * every other control in the hub is decoration.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

let db: PGlite;
beforeAll(async () => { db = await stagingDb(); });
afterAll(async () => { await db?.close(); });

const fresh = () => stagingDb();

/** A connection in any state, created as the owner (bypassing the wizard). */
async function connection(
  d: PGlite,
  opts: { college?: string; provider?: string; status?: string; company?: string } = {}
): Promise<string> {
  const rows = await verify<{ id: string }>(
    d,
    `INSERT INTO finance_integration_connections
       (college_id, provider, display_name, status, external_company_id, external_company_name, created_by)
     VALUES ($1, $2, 'QA Books', 'DRAFT', $3, $3, $4) RETURNING id`,
    [opts.college ?? COLLEGE_A, opts.provider ?? "zoho_books", opts.company ?? "QA-ORG-1", U.admin]
  );
  const id = rows[0].id;
  if (opts.status && opts.status !== "DRAFT") {
    // Walk the real state machine rather than writing the status directly —
    // the trigger refuses shortcuts, and so should the fixture.
    const path: Record<string, string[]> = {
      CONFIGURING: ["CONFIGURING"],
      AUTH_REQUIRED: ["CONFIGURING", "AUTH_REQUIRED"],
      AUTHENTICATED: ["CONFIGURING", "AUTH_REQUIRED", "AUTHENTICATED"],
      VERIFIED: ["CONFIGURING", "AUTH_REQUIRED", "AUTHENTICATED", "VERIFIED"],
      ACTIVE: ["CONFIGURING", "AUTH_REQUIRED", "AUTHENTICATED", "VERIFIED", "ACTIVE"],
      DISABLED: ["DISABLED"],
    };
    for (const step of path[opts.status] ?? [opts.status]) {
      await verify(d, `UPDATE finance_integration_connections SET status=$2 WHERE id=$1`, [id, step]);
    }
  }
  return id;
}

async function syncOp(
  d: PGlite,
  connectionId: string,
  opts: { college?: string; entityId?: string; status?: string; key?: string } = {}
): Promise<string> {
  const rows = await verify<{ id: string }>(
    d,
    `INSERT INTO finance_sync_operations
       (college_id, connection_id, provider, entity_type, entity_id, operation, idempotency_key, status, system_actor)
     VALUES ($1, $2, 'zoho_books', 'payment', $3, 'create_payment', $4, 'PENDING', 'test') RETURNING id`,
    [opts.college ?? COLLEGE_A, connectionId, opts.entityId ?? (await somePayment(d)), opts.key ?? `an_${Math.random().toString(16).slice(2)}`]
  );
  const id = rows[0].id;
  if (opts.status && opts.status !== "PENDING") {
    const path: Record<string, string[]> = {
      QUEUED: ["QUEUED"],
      PROCESSING: ["QUEUED", "PROCESSING"],
      FAILED: ["QUEUED", "PROCESSING", "FAILED"],
      SYNCED: ["QUEUED", "PROCESSING"],
    };
    for (const step of path[opts.status] ?? [opts.status]) {
      await verify(d, `UPDATE finance_sync_operations SET status=$2 WHERE id=$1`, [id, step]);
    }
  }
  return id;
}

async function somePayment(d: PGlite): Promise<string> {
  const existing = await verify<{ id: string }>(d, `SELECT id FROM payments WHERE college_id=$1 LIMIT 1`, [COLLEGE_A]);
  if (existing.length) return existing[0].id;
  const rows = await verify<{ id: string }>(
    d,
    `INSERT INTO payments (college_id, fee_id, student_id, amount, method, status, processed_by)
     VALUES ($1, $2, $3, 100, 'upi', 'cleared', $4) RETURNING id`,
    [COLLEGE_A, FEE_A, S.a, U.finance]
  );
  return rows[0].id;
}

// ══════════════════════════════════════════════════════════════
// The rule
// ══════════════════════════════════════════════════════════════

describe("a transaction is SYNCED only with an external identifier (§40, §101)", () => {
  it("refuses SYNCED with no external_id — from the console, with RLS out of the picture", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      const op = await syncOp(d, conn, { status: "SYNCED" });
      await expect(verify(d, `UPDATE finance_sync_operations SET status='SYNCED' WHERE id=$1`, [op]))
        .rejects.toThrow(/SYNCED requires an external identifier|fso_synced_needs_external_id/);
      expect(await scalar(d, `SELECT status FROM finance_sync_operations WHERE id=$1`, [op])).toBe("PROCESSING");
    } finally { await d.close(); }
  });

  it("accepts SYNCED once an identifier is present, and then freezes it", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      const op = await syncOp(d, conn, { status: "SYNCED" });
      await verify(d, `UPDATE finance_sync_operations SET status='SYNCED', external_id='P-1' WHERE id=$1`, [op]);
      expect(await scalar(d, `SELECT external_id FROM finance_sync_operations WHERE id=$1`, [op])).toBe("P-1");
      // §72: an acknowledged document is never renamed.
      await expect(verify(d, `UPDATE finance_sync_operations SET external_id='P-2' WHERE id=$1`, [op]))
        .rejects.toThrow(/external id, once recorded, is immutable/);
    } finally { await d.close(); }
  });

  it("the only move off SYNCED is to RECONCILIATION_REQUIRED", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      const op = await syncOp(d, conn, { status: "SYNCED" });
      await verify(d, `UPDATE finance_sync_operations SET status='SYNCED', external_id='P-1' WHERE id=$1`, [op]);
      for (const bad of ["FAILED", "QUEUED", "CANCELLED", "PROCESSING"]) {
        await expect(verify(d, `UPDATE finance_sync_operations SET status=$2 WHERE id=$1`, [op, bad]), bad)
          .rejects.toThrow(/may not move from SYNCED/);
      }
      await verify(d, `UPDATE finance_sync_operations SET status='RECONCILIATION_REQUIRED' WHERE id=$1`, [op]);
      expect(await scalar(d, `SELECT status FROM finance_sync_operations WHERE id=$1`, [op])).toBe("RECONCILIATION_REQUIRED");
    } finally { await d.close(); }
  });
});

// ══════════════════════════════════════════════════════════════
// Idempotency and identity (§52, §86)
// ══════════════════════════════════════════════════════════════

describe("one payment, one external document", () => {
  it("the same idempotency key cannot be journalled twice on one connection", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      await syncOp(d, conn, { key: "an_same" });
      await expect(syncOp(d, conn, { key: "an_same" })).rejects.toThrow(/duplicate key|unique/i);
    } finally { await d.close(); }
  });

  it("a payment may hold only one external link per connection, and an external id only one payment", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      const pay = await somePayment(d);
      const other = (await verify<{ id: string }>(d,
        `INSERT INTO payments (college_id, fee_id, student_id, amount, method, status, processed_by)
         VALUES ($1,$2,$3,50,'cash','cleared',$4) RETURNING id`, [COLLEGE_A, FEE_A, S.a, U.finance]))[0].id;

      await verify(d, `INSERT INTO finance_external_links (college_id, connection_id, entity_type, entity_id, external_id) VALUES ($1,$2,'payment',$3,'P-1')`, [COLLEGE_A, conn, pay]);
      // a second document for the same payment
      await expect(verify(d, `INSERT INTO finance_external_links (college_id, connection_id, entity_type, entity_id, external_id) VALUES ($1,$2,'payment',$3,'P-2')`, [COLLEGE_A, conn, pay]))
        .rejects.toThrow(/duplicate key|unique/i);
      // the same document claimed by a second payment
      await expect(verify(d, `INSERT INTO finance_external_links (college_id, connection_id, entity_type, entity_id, external_id) VALUES ($1,$2,'payment',$3,'P-1')`, [COLLEGE_A, conn, other]))
        .rejects.toThrow(/duplicate key|unique/i);
      expect(await scalar(d, `SELECT count(*)::int FROM finance_external_links WHERE connection_id=$1`, [conn])).toBe(1);
    } finally { await d.close(); }
  });

  it("a link is immutable — re-pointing it is a delete and re-create under audit", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      const pay = await somePayment(d);
      await verify(d, `INSERT INTO finance_external_links (college_id, connection_id, entity_type, entity_id, external_id) VALUES ($1,$2,'payment',$3,'P-1')`, [COLLEGE_A, conn, pay]);
      await expect(verify(d, `UPDATE finance_external_links SET external_id='P-9' WHERE connection_id=$1`, [conn]))
        .rejects.toThrow(/immutable/);
    } finally { await d.close(); }
  });

  it("the journal cannot be pruned", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      const op = await syncOp(d, conn);
      await expect(verify(d, `DELETE FROM finance_sync_operations WHERE id=$1`, [op]))
        .rejects.toThrow(/append-only/);
      // and neither can a connection that has one
      await expect(verify(d, `DELETE FROM finance_integration_connections WHERE id=$1`, [conn]))
        .rejects.toThrow(/violates|RESTRICT/i);
    } finally { await d.close(); }
  });
});

// ══════════════════════════════════════════════════════════════
// Retry safety, in the database (§68)
// ══════════════════════════════════════════════════════════════

describe("an unsafe failure cannot be retried by anyone", () => {
  it("RETRYING is refused unless the previous outcome was classified safe", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      const op = await syncOp(d, conn, { status: "FAILED" });
      await verify(d, `UPDATE finance_sync_operations SET retry_safety='unsafe' WHERE id=$1`, [op]);
      await expect(verify(d, `UPDATE finance_sync_operations SET status='RETRYING' WHERE id=$1`, [op]))
        .rejects.toThrow(/not safe to retry/);
      // and an operator through RLS fares no better
      const r = await as(d, U.finance, `UPDATE public.finance_sync_operations SET status='RETRYING' WHERE id='${op}'`);
      expect(r.ok).toBe(false);
      expect(await scalar(d, `SELECT status FROM finance_sync_operations WHERE id=$1`, [op])).toBe("FAILED");

      await verify(d, `UPDATE finance_sync_operations SET retry_safety='safe' WHERE id=$1`, [op]);
      await verify(d, `UPDATE finance_sync_operations SET status='RETRYING' WHERE id=$1`, [op]);
      expect(await scalar(d, `SELECT status FROM finance_sync_operations WHERE id=$1`, [op])).toBe("RETRYING");
    } finally { await d.close(); }
  });

  it("attempt_number only moves forward", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      const op = await syncOp(d, conn);
      await verify(d, `UPDATE finance_sync_operations SET attempt_number=3 WHERE id=$1`, [op]);
      await expect(verify(d, `UPDATE finance_sync_operations SET attempt_number=1 WHERE id=$1`, [op]))
        .rejects.toThrow(/only moves forward/);
    } finally { await d.close(); }
  });

  it("identity columns are frozen, so a journal row cannot be re-aimed at another payment", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      const op = await syncOp(d, conn);
      for (const set of [`entity_id='${S.a}'`, `operation='create_refund'`, `idempotency_key='an_other'`, `college_id='${COLLEGE_B}'`]) {
        await expect(verify(d, `UPDATE finance_sync_operations SET ${set} WHERE id=$1`, [op]), set)
          .rejects.toThrow(/identity columns are immutable/);
      }
    } finally { await d.close(); }
  });
});

// ══════════════════════════════════════════════════════════════
// Connection lifecycle (§47, §43)
// ══════════════════════════════════════════════════════════════

describe("connection state machine", () => {
  it("cannot jump from DRAFT straight to ACTIVE", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d);
      await expect(verify(d, `UPDATE finance_integration_connections SET status='ACTIVE' WHERE id=$1`, [conn]))
        .rejects.toThrow(/may not move from DRAFT to ACTIVE/);
    } finally { await d.close(); }
  });

  it("cannot be activated without a confirmed external company (§43)", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "VERIFIED" });
      await verify(d, `UPDATE finance_integration_connections SET external_company_id=NULL, external_company_name=NULL, organization_id=NULL WHERE id=$1`, [conn]);
      await expect(verify(d, `UPDATE finance_integration_connections SET status='ACTIVE' WHERE id=$1`, [conn]))
        .rejects.toThrow(/without a verified external company/);
    } finally { await d.close(); }
  });

  it("provider and college are immutable — a Tally connection never becomes a Zoho one", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      await expect(verify(d, `UPDATE finance_integration_connections SET provider='tallyprime' WHERE id=$1`, [conn]))
        .rejects.toThrow(/provider is immutable/);
      await expect(verify(d, `UPDATE finance_integration_connections SET college_id=$2 WHERE id=$1`, [conn, COLLEGE_B]))
        .rejects.toThrow(/college_id is immutable/);
    } finally { await d.close(); }
  });

  it("a revoked connection must be re-authorised, not simply switched back on", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      await verify(d, `UPDATE finance_integration_connections SET status='REVOKED' WHERE id=$1`, [conn]);
      await expect(verify(d, `UPDATE finance_integration_connections SET status='ACTIVE' WHERE id=$1`, [conn]))
        .rejects.toThrow(/may not move from REVOKED to ACTIVE/);
      await verify(d, `UPDATE finance_integration_connections SET status='AUTH_REQUIRED' WHERE id=$1`, [conn]);
      expect(await scalar(d, `SELECT status FROM finance_integration_connections WHERE id=$1`, [conn])).toBe("AUTH_REQUIRED");
    } finally { await d.close(); }
  });
});

// ══════════════════════════════════════════════════════════════
// Credentials (§46, §85)
// ══════════════════════════════════════════════════════════════

describe("credentials are unreadable by every authenticated role", () => {
  it("admin, finance, director and super_admin all read zero rows and cannot write one", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      await verify(d,
        `INSERT INTO finance_integration_credentials (connection_id, college_id, ciphertext, iv, auth_tag)
         VALUES ($1,$2,'CIPHERTEXT','IV','TAG')`, [conn, COLLEGE_A]);
      expect(await scalar(d, `SELECT count(*)::int FROM finance_integration_credentials`)).toBe(1);

      for (const uid of [U.admin, U.finance, U.director, U.superAdmin, U.studentA]) {
        const read = await as(d, uid, `SELECT ciphertext FROM public.finance_integration_credentials`);
        expect(read.data.length, `role read rows: ${uid}`).toBe(0);
        const write = await as(d, uid,
          `INSERT INTO public.finance_integration_credentials (connection_id, college_id, ciphertext, iv, auth_tag) VALUES ('${conn}','${COLLEGE_A}','X','Y','Z')`);
        expect(write.ok, `role wrote: ${uid}`).toBe(false);
        const del = await as(d, uid, `DELETE FROM public.finance_integration_credentials`);
        expect(del.rows, `role deleted: ${uid}`).toBe(0);
      }
      expect(await scalar(d, `SELECT ciphertext FROM finance_integration_credentials`)).toBe("CIPHERTEXT");
    } finally { await d.close(); }
  });
});

// ══════════════════════════════════════════════════════════════
// RBAC / RLS split (§74)
// ══════════════════════════════════════════════════════════════

describe("who may do what", () => {
  it("finance reads connections but cannot create or change one; admin can", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      expect((await as(d, U.finance, `SELECT id FROM public.finance_integration_connections`)).data.length).toBe(1);

      const financeInsert = await as(d, U.finance,
        `INSERT INTO public.finance_integration_connections (college_id, provider, display_name, created_by) VALUES ('${COLLEGE_A}','busy','Sneak','${U.finance}')`);
      expect(financeInsert.ok).toBe(false);
      expect((await as(d, U.finance, `UPDATE public.finance_integration_connections SET display_name='x' WHERE id='${conn}'`)).rows).toBe(0);

      expect((await as(d, U.admin, `UPDATE public.finance_integration_connections SET display_name='Renamed' WHERE id='${conn}' RETURNING id`)).rows).toBe(1);
      expect(await scalar(d, `SELECT display_name FROM finance_integration_connections WHERE id=$1`, [conn])).toBe("Renamed");
    } finally { await d.close(); }
  });

  it("a connection is created as DRAFT, in the creator's name", async () => {
    const d = await fresh();
    try {
      const forged = await as(d, U.admin,
        `INSERT INTO public.finance_integration_connections (college_id, provider, display_name, status, created_by) VALUES ('${COLLEGE_A}','zoho_books','Sneak','ACTIVE','${U.admin}')`);
      expect(forged.ok).toBe(false);
      const impersonated = await as(d, U.admin,
        `INSERT INTO public.finance_integration_connections (college_id, provider, display_name, created_by) VALUES ('${COLLEGE_A}','zoho_books','Sneak','${U.director}')`);
      expect(impersonated.ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM finance_integration_connections WHERE display_name='Sneak'`)).toBe(0);
    } finally { await d.close(); }
  });

  it("an operator may queue and cancel, but may never declare an outcome (§76)", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      const pay = await somePayment(d);

      const queued = await as(d, U.finance,
        `INSERT INTO public.finance_sync_operations (college_id, connection_id, provider, entity_type, entity_id, operation, idempotency_key, created_by)
         VALUES ('${COLLEGE_A}','${conn}','zoho_books','payment','${pay}','create_payment','an_op1','${U.finance}') RETURNING id, status`);
      expect(queued.ok, queued.error ?? "").toBe(true);
      expect(queued.data[0].status).toBe("PENDING");
      const opId = queued.data[0].id as string;

      // Client-asserted external id at insert time — the §76 attack.
      const forged = await as(d, U.finance,
        `INSERT INTO public.finance_sync_operations (college_id, connection_id, provider, entity_type, entity_id, operation, idempotency_key, created_by, external_id)
         VALUES ('${COLLEGE_A}','${conn}','zoho_books','payment','${pay}','create_payment','an_op2','${U.finance}','FORGED-1')`);
      expect(forged.ok).toBe(false);

      // Queue it — allowed.
      expect((await as(d, U.finance, `UPDATE public.finance_sync_operations SET status='QUEUED' WHERE id='${opId}' RETURNING id`)).rows).toBe(1);
      // Declare it synced — refused by the policy's WITH CHECK.
      const declare = await as(d, U.finance, `UPDATE public.finance_sync_operations SET status='SYNCED', external_id='FORGED-1' WHERE id='${opId}'`);
      expect(declare.rows).toBe(0);
      expect(await scalar(d, `SELECT status FROM finance_sync_operations WHERE id=$1`, [opId])).toBe("QUEUED");
      expect(await scalar(d, `SELECT external_id FROM finance_sync_operations WHERE id=$1`, [opId])).toBeNull();
    } finally { await d.close(); }
  });

  it("nobody may write an external link through the API — it comes from a verified response", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      const pay = await somePayment(d);
      for (const uid of [U.finance, U.admin]) {
        const r = await as(d, uid,
          `INSERT INTO public.finance_external_links (college_id, connection_id, entity_type, entity_id, external_id) VALUES ('${COLLEGE_A}','${conn}','payment','${pay}','FORGED')`);
        expect(r.ok, uid).toBe(false);
      }
      expect(await scalar(d, `SELECT count(*)::int FROM finance_external_links`)).toBe(0);
    } finally { await d.close(); }
  });

  it("a student, teacher, hod or warden sees nothing of the hub at all", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      await syncOp(d, conn);
      for (const uid of [U.studentA, U.teacherA, U.hodCse, U.warden, U.director, U.superAdmin]) {
        for (const table of ["finance_integration_connections", "finance_sync_operations", "finance_account_mappings", "finance_external_links", "finance_reconciliation_runs"]) {
          const r = await as(d, uid, `SELECT * FROM public.${table}`);
          expect(r.data.length, `${uid} read ${table}`).toBe(0);
        }
      }
    } finally { await d.close(); }
  });
});

// ══════════════════════════════════════════════════════════════
// Tenant isolation (§75)
// ══════════════════════════════════════════════════════════════

describe("a College A connection can never process College B data", () => {
  it("College B's finance user cannot see, use or act on College A's connection", async () => {
    const d = await fresh();
    try {
      const connA = await connection(d, { college: COLLEGE_A, status: "ACTIVE" });
      const payA = await somePayment(d);

      // bHod is College B staff; the dataset has no College B finance user,
      // so the strongest available College B actor is used.
      expect((await as(d, U.bHod, `SELECT id FROM public.finance_integration_connections`)).data.length).toBe(0);
      const cross = await as(d, U.bHod,
        `INSERT INTO public.finance_sync_operations (college_id, connection_id, provider, entity_type, entity_id, operation, idempotency_key, created_by)
         VALUES ('${COLLEGE_B}','${connA}','zoho_books','payment','${payA}','create_payment','an_cross','${U.bHod}')`);
      expect(cross.ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM finance_sync_operations WHERE idempotency_key='an_cross'`)).toBe(0);
    } finally { await d.close(); }
  });

  it("an operation cannot straddle two colleges even from the console", async () => {
    const d = await fresh();
    try {
      const connA = await connection(d, { college: COLLEGE_A, status: "ACTIVE" });
      const payA = await somePayment(d);
      await expect(verify(d,
        `INSERT INTO finance_sync_operations (college_id, connection_id, provider, entity_type, entity_id, operation, idempotency_key, system_actor)
         VALUES ($1,$2,'zoho_books','payment',$3,'create_payment','an_x','test')`, [COLLEGE_B, connA, payA]))
        // The entity-tenant trigger fires before the composite FK is even
        // reached, so the refusal names the payment rather than the key. Both
        // are the same boundary; either message is the boundary holding.
        .rejects.toThrow(/does not exist in this college|fso_connection_tenant_fkey|violates foreign key/);
    } finally { await d.close(); }
  });

  it("an operation cannot name a payment from another college (§85 IDOR)", async () => {
    const d = await fresh();
    try {
      const connA = await connection(d, { college: COLLEGE_A, status: "ACTIVE" });
      const payB = (await verify<{ id: string }>(d,
        `INSERT INTO payments (college_id, fee_id, student_id, amount, method, status)
         VALUES ($1, '00000014-0000-4000-8000-000000000003', $2, 100, 'cash', 'cleared') RETURNING id`,
        [COLLEGE_B, S.bStudent]))[0].id;
      await expect(verify(d,
        `INSERT INTO finance_sync_operations (college_id, connection_id, provider, entity_type, entity_id, operation, idempotency_key, system_actor)
         VALUES ($1,$2,'zoho_books','payment',$3,'create_payment','an_idor','test')`, [COLLEGE_A, connA, payB]))
        .rejects.toThrow(/does not exist in this college/);
    } finally { await d.close(); }
  });

  it("a mapping cannot be attached to another college's connection", async () => {
    const d = await fresh();
    try {
      const connA = await connection(d, { college: COLLEGE_A, status: "ACTIVE" });
      await expect(verify(d,
        `INSERT INTO finance_account_mappings (college_id, connection_id, kind, local_key, external_name)
         VALUES ($1,$2,'fee_head','Tuition','X')`, [COLLEGE_B, connA]))
        .rejects.toThrow(/fam_connection_tenant_fkey|violates foreign key/);
    } finally { await d.close(); }
  });
});

// ══════════════════════════════════════════════════════════════
// Mappings and reconciliation
// ══════════════════════════════════════════════════════════════

describe("mappings and reconciliation findings", () => {
  it("one mapping per (connection, kind, local key) — two ledgers for one fee head is impossible", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      expect((await as(d, U.finance,
        `INSERT INTO public.finance_account_mappings (college_id, connection_id, kind, local_key, external_name) VALUES ('${COLLEGE_A}','${conn}','fee_head','Tuition Fee','Tuition Income') RETURNING id`)).rows).toBe(1);
      const second = await as(d, U.finance,
        `INSERT INTO public.finance_account_mappings (college_id, connection_id, kind, local_key, external_name) VALUES ('${COLLEGE_A}','${conn}','fee_head','Tuition Fee','Other Income')`);
      expect(second.ok).toBe(false);
      expect(await scalar(d, `SELECT external_name FROM finance_account_mappings WHERE local_key='Tuition Fee'`)).toBe("Tuition Income");
    } finally { await d.close(); }
  });

  it("a reconciliation finding is immutable; only its resolution is recorded, in a person's name", async () => {
    const d = await fresh();
    try {
      const conn = await connection(d, { status: "ACTIVE" });
      const run = (await verify<{ id: string }>(d,
        `INSERT INTO finance_reconciliation_runs (college_id, connection_id, period_start, period_end, system_actor)
         VALUES ($1,$2,'2026-09-01','2026-09-30','test') RETURNING id`, [COLLEGE_A, conn]))[0].id;
      const item = (await verify<{ id: string }>(d,
        `INSERT INTO finance_reconciliation_items (college_id, run_id, difference_type, detail, local_amount)
         VALUES ($1,$2,'AMOUNT_MISMATCH','Payment X: 100 here, 90 there',100) RETURNING id`, [COLLEGE_A, run]))[0].id;

      // Rewriting the finding — refused.
      await expect(verify(d, `UPDATE finance_reconciliation_items SET local_amount=90 WHERE id=$1`, [item]))
        .rejects.toThrow(/finding is immutable/);
      await expect(verify(d, `UPDATE finance_reconciliation_items SET detail='nothing wrong' WHERE id=$1`, [item]))
        .rejects.toThrow(/finding is immutable/);

      // Resolving without saying anything, or in someone else's name — refused.
      expect((await as(d, U.finance, `UPDATE public.finance_reconciliation_items SET status='resolved', resolved_by=auth.uid() WHERE id='${item}'`)).rows).toBe(0);
      expect((await as(d, U.finance, `UPDATE public.finance_reconciliation_items SET status='resolved', resolution='ok', resolved_by='${U.admin}' WHERE id='${item}'`)).rows).toBe(0);

      // Resolving properly — allowed, once.
      expect((await as(d, U.finance, `UPDATE public.finance_reconciliation_items SET status='resolved', resolution='Voucher re-entered', resolved_by=auth.uid(), resolved_at=now() WHERE id='${item}' RETURNING id`)).rows).toBe(1);
      expect((await as(d, U.finance, `UPDATE public.finance_reconciliation_items SET status='accepted', resolution='again', resolved_by=auth.uid() WHERE id='${item}'`)).rows).toBe(0);
      expect(await scalar(d, `SELECT resolution FROM finance_reconciliation_items WHERE id=$1`, [item])).toBe("Voucher re-entered");
    } finally { await d.close(); }
  });
});

// ══════════════════════════════════════════════════════════════
// The hub changes no money
// ══════════════════════════════════════════════════════════════

describe("the hub cannot move money", () => {
  it("nothing in migration 049 touches fees or payments", async () => {
    const sql = (await import("node:fs")).readFileSync("supabase/migrations/049_finance_integration_hub.sql", "utf8");
    // References are fine (the entity-tenant trigger reads them); writes are not.
    expect(/UPDATE\s+public\.(fees|payments)\b/i.test(sql)).toBe(false);
    expect(/INSERT\s+INTO\s+public\.(fees|payments)\b/i.test(sql)).toBe(false);
    expect(/DELETE\s+FROM\s+public\.(fees|payments)\b/i.test(sql)).toBe(false);
  });

  it("a full journal + link + reconciliation cycle leaves the ledger byte-identical", async () => {
    const d = await fresh();
    try {
      const snapshot = () => verify(d, `SELECT md5(string_agg(f::text,'|' ORDER BY f.id)) h, count(*)::int n FROM fees f`);
      const conn = await connection(d, { status: "ACTIVE" });
      const pay = await somePayment(d);
      // Snapshot AFTER the payment exists: recording a payment legitimately
      // credits its fee (047 §7i). What is measured here is what the HUB
      // does on top of that, which must be nothing.
      const before = await snapshot();
      const op = await syncOp(d, conn, { entityId: pay, status: "SYNCED" });
      await verify(d, `INSERT INTO finance_external_links (college_id, connection_id, entity_type, entity_id, external_id) VALUES ($1,$2,'payment',$3,'P-1')`, [COLLEGE_A, conn, pay]);
      await verify(d, `UPDATE finance_sync_operations SET status='SYNCED', external_id='P-1' WHERE id=$1`, [op]);
      const run = (await verify<{ id: string }>(d,
        `INSERT INTO finance_reconciliation_runs (college_id, connection_id, period_start, period_end, system_actor) VALUES ($1,$2,'2026-09-01','2026-09-30','test') RETURNING id`, [COLLEGE_A, conn]))[0].id;
      await verify(d, `INSERT INTO finance_reconciliation_items (college_id, run_id, difference_type, detail) VALUES ($1,$2,'AMOUNT_MISMATCH','x')`, [COLLEGE_A, run]);
      expect(await snapshot()).toEqual(before);
    } finally { await d.close(); }
  });
});
