import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  stagingDb, as, verify, scalar, U, S, COLLEGE_A, COLLEGE_B,
  BLOCK_A, BLOCK_B, ROOM_A102, ROOM_B201, ROOM_B202, ALLOC_A, ALLOC_C,
  PASS_A, PASS_C, FEE_A, FEE_C, FEE_B_COLLEGE, DEPT_CSE, OFF,
} from "./staging/harness";

/**
 * Hostel, gate-pass and finance certification against the real migrated
 * schema. These three domains were reported BLOCKED by the previous audit
 * because the dataset carried no hostel or fee rows. It now does, and every
 * one of them turned up a defect on first contact:
 *
 *   Warden A approved, vacated and re-housed Block B's students.
 *   A student inserted a gate pass that was already approved.
 *   A 'failed' payment credited the fee. A negative one debited it. One for
 *   50,000 against a 10,000 fee marked it paid. Deleting the payment left the
 *   credit behind. A College A finance user credited a College B fee.
 *
 * All fixed in 047 §7g–§7i. Every test here reads the row back afterwards.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

let db: PGlite;
beforeAll(async () => { db = await stagingDb(); });
afterAll(async () => { await db?.close(); });
const fresh = () => stagingDb();

// ══════════════════════════════════════════════════════════════
// Hostel — block ownership
// ══════════════════════════════════════════════════════════════

describe("warden block scope", () => {
  it("the fixture really does split the two wardens across two blocks", async () => {
    expect((await as(db, U.warden, `SELECT public.wardens_block('${BLOCK_A}') v`)).data[0].v).toBe(true);
    expect((await as(db, U.warden, `SELECT public.wardens_block('${BLOCK_B}') v`)).data[0].v).toBe(false);
    expect((await as(db, U.wardenB, `SELECT public.wardens_block('${BLOCK_B}') v`)).data[0].v).toBe(true);
    expect((await as(db, U.warden, `SELECT public.wardens_student('${S.a}') v`)).data[0].v).toBe(true);
    expect((await as(db, U.warden, `SELECT public.wardens_student('${S.c}') v`)).data[0].v).toBe(false);
  });

  it("Warden A cannot approve a Block-B student's gate pass", async () => {
    const d = await fresh();
    try {
      const r = await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${PASS_C}'`);
      expect(r.rows).toBe(0);
      expect(await scalar(d, `SELECT status FROM gate_passes WHERE id=$1`, [PASS_C])).toBe("pending");
    } finally { await d.close(); }
  });

  it("Warden A CAN approve their own block's pass — and Warden B theirs", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${PASS_A}'`)).rows).toBe(1);
      expect((await as(d, U.wardenB, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${PASS_C}'`)).rows).toBe(1);
    } finally { await d.close(); }
  });

  it("Warden A cannot touch Block-B rooms, allocations or place students there", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.warden, `UPDATE public.hostel_rooms SET status='maintenance' WHERE id='${ROOM_B201}'`)).rows).toBe(0);
      expect(await scalar(d, `SELECT status FROM hostel_rooms WHERE id=$1`, [ROOM_B201])).toBe("available");

      expect((await as(d, U.warden, `UPDATE public.hostel_allocations SET status='vacated' WHERE id='${ALLOC_C}'`)).rows).toBe(0);
      expect(await scalar(d, `SELECT status FROM hostel_allocations WHERE id=$1`, [ALLOC_C])).toBe("active");

      const ins = await as(d, U.warden,
        `INSERT INTO public.hostel_allocations (college_id, student_id, room_id, status)
           VALUES ('${COLLEGE_A}','${S.b}','${ROOM_B202}','active')`);
      expect(ins.ok).toBe(false);
    } finally { await d.close(); }
  });

  it("Warden A can manage their own block", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.warden, `UPDATE public.hostel_rooms SET status='maintenance' WHERE id='${ROOM_A102}'`)).rows).toBe(1);
      const ins = await as(d, U.warden,
        `INSERT INTO public.hostel_allocations (college_id, student_id, room_id, status)
           VALUES ('${COLLEGE_A}','${S.b}','${ROOM_A102}','active')`);
      expect(ins.error).toBeNull();
    } finally { await d.close(); }
  });

  it("a greedy UPDATE by Warden A narrows to Block A, never fails outright", async () => {
    const d = await fresh();
    try {
      const r = await as(d, U.warden, `UPDATE public.gate_passes SET status='rejected', approved_by=auth.uid(), approved_at=now()`);
      expect(r.ok).toBe(true);
      expect(await scalar(d, `SELECT status FROM gate_passes WHERE id=$1`, [PASS_A])).toBe("rejected");
      expect(await scalar(d, `SELECT status FROM gate_passes WHERE id=$1`, [PASS_C])).toBe("pending");
    } finally { await d.close(); }
  });

  it("a warden cannot claim another block — the master-data node is admin-only", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.warden, `UPDATE public.hostel_blocks SET warden_id=auth.uid() WHERE id='${BLOCK_B}'`)).rows).toBe(0);
      expect(await scalar(d, `SELECT warden_id FROM hostel_blocks WHERE id=$1`, [BLOCK_B])).toBe(U.wardenB);
    } finally { await d.close(); }
  });

  it("PROPAGATION: reassigning a block moves warden authority immediately", async () => {
    const d = await fresh();
    try {
      // Before: Warden A cannot act on Block B. (A complete, legal decision —
      // so the only thing that can zero it is scope, not the state machine.)
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${PASS_C}'`)).rows).toBe(0);
      // Admin reassigns Block B to Warden A.
      await verify(d, `UPDATE public.hostel_blocks SET warden_id=$1 WHERE id=$2`, [U.warden, BLOCK_B]);
      // Same session, no refresh: authority follows the row.
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${PASS_C}'`)).rows).toBe(1);
      // And Warden B has lost it.
      expect((await as(d, U.wardenB, `UPDATE public.hostel_rooms SET status='maintenance' WHERE id='${ROOM_B201}'`)).rows).toBe(0);
    } finally { await d.close(); }
  });

  it("a student with no active allocation is in nobody's scope", async () => {
    const d = await fresh();
    try {
      await verify(d, `UPDATE public.hostel_allocations SET status='vacated' WHERE id=$1`, [ALLOC_A]);
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${PASS_A}'`)).rows).toBe(0);
    } finally { await d.close(); }
  });

  it("wardens are confined to their own college", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET status='approved' WHERE college_id='${COLLEGE_B}'`)).rows).toBe(0);
      expect((await as(d, U.warden, `SELECT id FROM hostel_rooms WHERE college_id='${COLLEGE_B}'`)).data).toHaveLength(0);
    } finally { await d.close(); }
  });
});

// ══════════════════════════════════════════════════════════════
// Gate pass — workflow integrity
// ══════════════════════════════════════════════════════════════

describe("gate pass workflow", () => {
  it("a student can only file a PENDING request", async () => {
    const d = await fresh();
    try {
      const forged = await as(d, U.studentA,
        `INSERT INTO public.gate_passes (college_id, student_id, destination, exit_time, return_time, status, approved_by)
           VALUES ('${COLLEGE_A}','${S.a}','x',now(),now()+interval '1 day','approved','${U.warden}')`);
      expect(forged.ok).toBe(false);

      const preActive = await as(d, U.studentA,
        `INSERT INTO public.gate_passes (college_id, student_id, destination, exit_time, return_time, status, actual_exit)
           VALUES ('${COLLEGE_A}','${S.a}','x',now(),now()+interval '1 day','active',now())`);
      expect(preActive.ok).toBe(false);

      const legit = await as(d, U.studentA,
        `INSERT INTO public.gate_passes (college_id, student_id, destination, exit_time, return_time)
           VALUES ('${COLLEGE_A}','${S.a}','Home',now(),now()+interval '1 day')`);
      expect(legit.error).toBeNull();
      expect(await scalar(d, `SELECT count(*)::int FROM gate_passes WHERE student_id=$1 AND status='pending'`, [S.a])).toBe(2);
    } finally { await d.close(); }
  });

  it("a student cannot approve, activate or return their own pass", async () => {
    const d = await fresh();
    try {
      for (const sql of [
        `UPDATE public.gate_passes SET status='approved' WHERE id='${PASS_A}'`,
        `UPDATE public.gate_passes SET status='active', actual_exit=now() WHERE id='${PASS_A}'`,
        `UPDATE public.gate_passes SET status='returned', actual_return=now() WHERE id='${PASS_A}'`,
      ]) {
        expect((await as(d, U.studentA, sql)).rows, sql).toBe(0);
      }
      expect(await scalar(d, `SELECT status FROM gate_passes WHERE id=$1`, [PASS_A])).toBe("pending");
    } finally { await d.close(); }
  });

  it("a student cannot file a pass for another student, nor read theirs", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.studentA,
        `INSERT INTO public.gate_passes (college_id, student_id, destination, exit_time, return_time)
           VALUES ('${COLLEGE_A}','${S.b}','x',now(),now()+interval '1 day')`)).ok).toBe(false);
      expect((await as(d, U.studentA, `SELECT id FROM gate_passes WHERE id='${PASS_C}'`)).data).toHaveLength(0);
    } finally { await d.close(); }
  });

  it("the full pass lifecycle: the warden decides, and only a guard can move it", async () => {
    // Rewritten for migration 050. The warden's half is unchanged; the two
    // movement transitions are no longer theirs to write, so what this test
    // now asserts is the split: the decision lands, the movements do not,
    // and the pass is left exactly where the warden left it.
    const d = await fresh();
    try {
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${PASS_A}' AND status='pending'`)).rows).toBe(1);
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET status='active', actual_exit=now() WHERE id='${PASS_A}' AND status='approved'`)).rows).toBe(0);
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET status='returned', actual_return=now() WHERE id='${PASS_A}' AND status='active'`)).rows).toBe(0);
      const [row] = await verify<{ status: string; approved_by: string; actual_exit: string | null }>(d, `SELECT status, approved_by, actual_exit FROM gate_passes WHERE id=$1`, [PASS_A]);
      expect(row.status).toBe("approved");
      expect(row.approved_by).toBe(U.warden);
      expect(row.actual_exit).toBeNull();
    } finally { await d.close(); }
  });

  /**
   * Walks a pending pass to 'returned' along the only legal path.
   *
   * As the OWNER, so RLS is out of the way: since 050 the two movement
   * transitions are granted to no authenticated role, and these tests are
   * about the state machine underneath rather than about who may drive it.
   * The trigger still holds here and still enforces the order and the
   * stamps — see staging-gate-security.test.ts for the guard's real path.
   */
  const walkToReturned = async (d: PGlite, id: string) => {
    await verify(d, `UPDATE public.gate_passes SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1`, [id, U.warden]);
    await verify(d, `UPDATE public.gate_passes SET status='active', actual_exit=now() WHERE id=$1`, [id]);
    await verify(d, `UPDATE public.gate_passes SET status='returned', actual_return=now() WHERE id=$1`, [id]);
  };

  it("REPLAY: a returned pass cannot be re-activated by a status-guarded update", async () => {
    const d = await fresh();
    try {
      await walkToReturned(d, PASS_A);
      const guarded = await as(d, U.warden, `UPDATE public.gate_passes SET status='active' WHERE id='${PASS_A}' AND status='approved'`);
      expect(guarded.rows).toBe(0);
    } finally { await d.close(); }
  });

  it("the database itself refuses a raw returned -> active jump (047 §7m)", async () => {
    // Formerly recorded here as a DESIGN DECISION — RLS let a warden set any
    // status on an in-scope pass and only the app's compare-and-swap stood
    // in the way. The state machine now lives in the database; the full
    // matrix is in tests/staging-gate-pass-machine.test.ts.
    const d = await fresh();
    try {
      await walkToReturned(d, PASS_A);
      // Two layers now, and the test asserts both. RLS refuses the warden
      // silently (050 §16b: they hold no UPDATE on a decided pass), and the
      // trigger names the refusal when RLS is out of the way.
      const jump = await as(d, U.warden, `UPDATE public.gate_passes SET status='active' WHERE id='${PASS_A}' RETURNING id`);
      expect(jump.rows, "a warden replayed a returned pass").toBe(0);
      await expect(verify(d, `UPDATE gate_passes SET status='active' WHERE id=$1`, [PASS_A]))
        .rejects.toThrow(/may not move from returned to active/);
      expect(await scalar(d, `SELECT status FROM gate_passes WHERE id=$1`, [PASS_A])).toBe("returned");
    } finally { await d.close(); }
  });
});

// ══════════════════════════════════════════════════════════════
// Finance — ledger integrity
// ══════════════════════════════════════════════════════════════

describe("finance ledger", () => {
  const pay = (fee: string, student: string, amount: number, status = "cleared", college = COLLEGE_A) =>
    `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status, processed_by)
       VALUES ('${college}','${fee}','${student}',${amount},'cash','${status}',auth.uid())`;
  const paid = (d: PGlite, fee = FEE_A) => scalar(d, `SELECT paid_amount::numeric FROM fees WHERE id=$1`, [fee]).then(Number);
  const feeStatus = (d: PGlite, fee = FEE_A) => scalar(d, `SELECT status FROM fees WHERE id=$1`, [fee]);

  it("a cleared payment credits the fee and moves it to partial, then paid", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.finance, pay(FEE_A, S.a, 4000))).error).toBeNull();
      expect(await paid(d)).toBe(4000);
      expect(await feeStatus(d)).toBe("partial");
      expect((await as(d, U.finance, pay(FEE_A, S.a, 6000))).error).toBeNull();
      expect(await paid(d)).toBe(10000);
      expect(await feeStatus(d)).toBe("paid");
      expect(await scalar(d, `SELECT count(*)::int FROM payments WHERE fee_id=$1`, [FEE_A])).toBe(2);
    } finally { await d.close(); }
  });

  it("a FAILED or PENDING payment is recorded but credits nothing", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.finance, pay(FEE_A, S.a, 1000, "failed"))).error).toBeNull();
      expect((await as(d, U.finance, pay(FEE_A, S.a, 500, "pending"))).error).toBeNull();
      expect(await paid(d)).toBe(0);
      expect(await feeStatus(d)).toBe("pending");
      expect(await scalar(d, `SELECT count(*)::int FROM payments WHERE fee_id=$1`, [FEE_A])).toBe(2);
    } finally { await d.close(); }
  });

  it("negative and zero amounts are refused", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.finance, pay(FEE_A, S.a, -2000))).ok).toBe(false);
      expect((await as(d, U.finance, pay(FEE_A, S.a, 0))).ok).toBe(false);
      expect(await paid(d)).toBe(0);
    } finally { await d.close(); }
  });

  it("OVERPAYMENT is refused by the database, and nothing lands", async () => {
    const d = await fresh();
    try {
      const r = await as(d, U.finance, pay(FEE_A, S.a, 50000));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/exceeds the outstanding balance/i);
      expect(await paid(d)).toBe(0);
      expect(await scalar(d, `SELECT count(*)::int FROM payments WHERE fee_id=$1`, [FEE_A])).toBe(0);

      // and exactly to the boundary is fine
      expect((await as(d, U.finance, pay(FEE_A, S.a, 10000))).error).toBeNull();
      expect((await as(d, U.finance, pay(FEE_A, S.a, 1))).ok).toBe(false);
    } finally { await d.close(); }
  });

  it("a payment cannot name a student who does not own the fee", async () => {
    const d = await fresh();
    try {
      const r = await as(d, U.finance, pay(FEE_A, S.c, 100));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/foreign key/i);
    } finally { await d.close(); }
  });

  it("CROSS-COLLEGE: a College A finance user cannot credit a College B fee", async () => {
    const d = await fresh();
    try {
      // The row says College A (so the tenancy predicate passes); the fee is
      // College B's. This used to land and credit the other institution.
      const r = await as(d, U.finance, pay(FEE_B_COLLEGE, S.bStudent, 100));
      expect(r.ok).toBe(false);
      expect(await paid(d, FEE_B_COLLEGE)).toBe(0);
    } finally { await d.close(); }
  });

  it("deleting a cleared payment reverses its credit", async () => {
    const d = await fresh();
    try {
      await as(d, U.finance, pay(FEE_A, S.a, 4000));
      expect(await paid(d)).toBe(4000);
      const id = String(await scalar(d, `SELECT id FROM payments WHERE fee_id=$1`, [FEE_A]));
      expect((await as(d, U.finance, `DELETE FROM public.payments WHERE id='${id}'`)).rows).toBe(1);
      expect(await paid(d)).toBe(0);
      expect(await feeStatus(d)).toBe("pending");
    } finally { await d.close(); }
  });

  it("a payment's identity is immutable after the fact", async () => {
    const d = await fresh();
    try {
      await as(d, U.finance, pay(FEE_A, S.a, 4000));
      const id = String(await scalar(d, `SELECT id FROM payments WHERE fee_id=$1`, [FEE_A]));
      expect((await as(d, U.finance, `UPDATE public.payments SET amount=9000 WHERE id='${id}'`)).ok).toBe(false);
      expect((await as(d, U.finance, `UPDATE public.payments SET student_id='${S.c}' WHERE id='${id}'`)).ok).toBe(false);
      // state may still change — that is what a refund does
      expect((await as(d, U.finance, `UPDATE public.payments SET status='refunded' WHERE id='${id}'`)).rows).toBe(1);
      expect(await paid(d)).toBe(4000); // not auto-debited: see the design note in 047 §7i
    } finally { await d.close(); }
  });

  it("processed_by cannot be forged", async () => {
    const d = await fresh();
    try {
      const r = await as(d, U.finance,
        `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status, processed_by)
           VALUES ('${COLLEGE_A}','${FEE_A}','${S.a}',100,'cash','cleared','${U.director}')`);
      expect(r.ok).toBe(false);
    } finally { await d.close(); }
  });

  it("no other role can record a payment or edit a fee", async () => {
    const d = await fresh();
    try {
      for (const [label, uid] of [["student", U.studentA], ["teacher", U.teacherA], ["hod", U.hodCse], ["warden", U.warden], ["director", U.director], ["super_admin", U.superAdmin]] as const) {
        expect((await as(d, uid, pay(FEE_A, S.a, 100))).ok, `${label} payment`).toBe(false);
        expect((await as(d, uid, `UPDATE public.fees SET amount=1 WHERE id='${FEE_A}'`)).rows, `${label} fee edit`).toBe(0);
      }
      expect(await paid(d)).toBe(0);
    } finally { await d.close(); }
  });

  it("a student sees only their own fees and payments", async () => {
    const d = await fresh();
    try {
      await as(d, U.finance, pay(FEE_A, S.a, 100));
      await as(d, U.finance, pay(FEE_C, S.c, 100));
      expect((await as(d, U.studentA, `SELECT id FROM fees`)).data).toHaveLength(1);
      expect((await as(d, U.studentA, `SELECT id FROM payments`)).data).toHaveLength(1);
      expect((await as(d, U.studentA, `SELECT id FROM fees WHERE id='${FEE_C}'`)).data).toHaveLength(0);
    } finally { await d.close(); }
  });

  it("NOT IMPLEMENTED: receipts are never generated", async () => {
    const d = await fresh();
    try {
      await as(d, U.finance, pay(FEE_A, S.a, 100));
      // receipt_number exists on the table and is written by nothing.
      expect(await scalar(d, `SELECT count(*)::int FROM payments WHERE receipt_number IS NOT NULL`)).toBe(0);
    } finally { await d.close(); }
  });
});

// ══════════════════════════════════════════════════════════════
// Propagation — HOD reassignment, the accidental proof from the probe
// ══════════════════════════════════════════════════════════════

describe("HOD reassignment propagates instantly", () => {
  it("the new HOD gains review scope and the old one loses it, mid-session", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.teacherA, `SELECT public.heads_offering_department('${OFF.dsB3}') v`)).data[0].v).toBe(false);
      expect((await as(d, U.hodCse, `SELECT public.heads_offering_department('${OFF.dsB3}') v`)).data[0].v).toBe(true);

      // Director reassigns CSE to Teacher A — the intended path.
      expect((await as(d, U.director, `UPDATE public.departments SET hod_id='${U.teacherA}' WHERE id='${DEPT_CSE}'`)).rows).toBe(1);

      expect((await as(d, U.teacherA, `SELECT public.heads_offering_department('${OFF.dsB3}') v`)).data[0].v).toBe(true);
      expect((await as(d, U.hodCse, `SELECT public.heads_offering_department('${OFF.dsB3}') v`)).data[0].v).toBe(false);

      // The old HOD can no longer act; the new one can. No cache, no refresh.
      await verify(d, `INSERT INTO public.leave_requests (id, college_id, requested_by, leave_type, start_date, end_date, reason, status)
        VALUES ('0000000f-0000-4000-8000-0000000000d1','${COLLEGE_A}','${U.teacherB}','casual','2026-09-20','2026-09-20','QA','pending')`);
      expect((await as(d, U.hodCse, `UPDATE public.leave_requests SET status='approved', approved_by=auth.uid() WHERE id='0000000f-0000-4000-8000-0000000000d1'`)).rows).toBe(0);
      expect((await as(d, U.teacherA, `UPDATE public.leave_requests SET status='approved', approved_by=auth.uid() WHERE id='0000000f-0000-4000-8000-0000000000d1'`)).rows).toBe(0);
      // Teacher A's profile role is still 'teacher', so the role gate refuses
      // — hod_id alone is not enough, and that is correct: assign_hod (the
      // Server Action) sets both. Recorded so nobody reads "hod_id moved"
      // as "authority moved" on its own.
      await verify(d, `UPDATE public.profiles SET role='hod' WHERE id=$1`, [U.teacherA]);
      expect((await as(d, U.teacherA, `UPDATE public.leave_requests SET status='approved', approved_by=auth.uid() WHERE id='0000000f-0000-4000-8000-0000000000d1'`)).rows).toBe(1);
    } finally { await d.close(); }
  });
});
