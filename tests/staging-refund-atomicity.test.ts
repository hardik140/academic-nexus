import { describe, it, expect, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { stagingDb, as, verify, scalar, U, S, COLLEGE_A, FEE_A } from "./staging/harness";

/**
 * Refund approval — money must move exactly once per approved request.
 *
 * approveRefund used to be three separate statements from the application:
 *   1. UPDATE fees    SET paid_amount = X - r WHERE paid_amount = X   (CAS)
 *   2. UPDATE payments SET status = 'refunded' (when fully refunded)
 *   3. UPDATE refund_requests SET status = 'approved' WHERE status = 'pending'
 * with "balance just changed — retry" as the documented response to a lost
 * CAS in step 1. Two approvers on the same request interleave as:
 *
 *   A1: reads request (pending), fee (X)      A2: reads request (pending), fee (X)
 *   A1: step 1 OK (X -> X-r)                  A2: step 1 loses CAS -> retries
 *                                             A2: re-reads request — STILL pending
 *                                             A2: re-reads fee (X-r); step 1 OK (X-r -> X-2r)
 *   A1: step 3 OK (approved)                  A2: step 3 loses claim -> throws
 *
 * The fee is now debited 2r for one approved refund. This is not a race a
 * single-connection engine can *run*, but it IS a fixed sequence of
 * independent statements, so it can be replayed exactly — which is what
 * the first test does, against the OLD statement sequence, to show the
 * defect is real rather than theoretical.
 *
 * The fix is 047 §7o: approve_refund(request_id), one SQL function, one
 * transaction, row locks on the request and the payment. The remaining
 * tests drive it as finance.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const fresh = () => stagingDb();
const paid = (d: PGlite) => scalar(d, `SELECT paid_amount::numeric FROM fees WHERE id=$1`, [FEE_A]).then(Number);

async function clearedPayment(d: PGlite, amount: number): Promise<string> {
  const r = await as(d, U.finance,
    `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status, processed_by)
       VALUES ('${COLLEGE_A}','${FEE_A}','${S.a}',${amount},'cash','cleared',auth.uid()) RETURNING id`);
  expect(r.ok, r.error ?? "").toBe(true);
  return r.data[0].id as string;
}

async function refundRequest(d: PGlite, paymentId: string, amount: number): Promise<string> {
  const r = await as(d, U.studentA,
    `INSERT INTO public.refund_requests (college_id, student_id, payment_id, amount, reason)
       VALUES ('${COLLEGE_A}','${S.a}','${paymentId}',${amount},'x') RETURNING id`);
  expect(r.ok, r.error ?? "").toBe(true);
  return r.data[0].id as string;
}

describe("the old three-statement sequence", () => {
  it("REPRODUCED: two approvers' interleaving debits the fee twice for one approval", async () => {
    const d = await fresh();
    try {
      const payment = await clearedPayment(d, 4000);
      const request = await refundRequest(d, payment, 1000);
      const X = await paid(d); // 4000

      // A1 and A2 both read: request pending, fee paid = X.
      // A1 step 1 — CAS on X succeeds.
      expect((await as(d, U.finance, `UPDATE public.fees SET paid_amount=${X - 1000}, status='partial' WHERE id='${FEE_A}' AND paid_amount=${X} RETURNING id`)).rows).toBe(1);
      // A2 step 1 — CAS on X loses; the app tells A2 to retry.
      expect((await as(d, U.finance, `UPDATE public.fees SET paid_amount=${X - 1000}, status='partial' WHERE id='${FEE_A}' AND paid_amount=${X} RETURNING id`)).rows).toBe(0);
      // A2 retries: the request is still pending (A1 has not reached step 3).
      expect(await scalar(d, `SELECT status FROM refund_requests WHERE id=$1`, [request])).toBe("pending");
      // A2 re-reads fee (X-1000) and its CAS now succeeds.
      expect((await as(d, U.finance, `UPDATE public.fees SET paid_amount=${X - 2000}, status='partial' WHERE id='${FEE_A}' AND paid_amount=${X - 1000} RETURNING id`)).rows).toBe(1);
      // A1 step 3 claims the request; A2's claim then loses and throws.
      expect((await as(d, U.finance, `UPDATE public.refund_requests SET status='approved', reviewed_by=auth.uid(), reviewed_at=now() WHERE id='${request}' AND status='pending' RETURNING id`)).rows).toBe(1);
      expect((await as(d, U.finance, `UPDATE public.refund_requests SET status='approved', reviewed_by=auth.uid(), reviewed_at=now() WHERE id='${request}' AND status='pending' RETURNING id`)).rows).toBe(0);

      // One approved refund of 1000; the fee lost 2000.
      expect(await paid(d)).toBe(X - 2000);
      expect(await scalar(d, `SELECT count(*)::int FROM refund_requests WHERE payment_id=$1 AND status='approved'`, [payment])).toBe(1);
    } finally { await d.close(); }
  });
});

describe("approve_refund() — one transaction", () => {
  it("approves once: fee debited by the refund, request approved by the caller, payment left cleared while partially refunded", async () => {
    const d = await fresh();
    try {
      const payment = await clearedPayment(d, 4000);
      const request = await refundRequest(d, payment, 1000);
      const before = await paid(d);
      const r = await as(d, U.finance, `SELECT public.approve_refund('${request}')`);
      expect(r.ok, r.error ?? "").toBe(true);
      expect(await paid(d)).toBe(before - 1000);
      const req = (await verify<{ status: string; reviewed_by: string }>(d, `SELECT status, reviewed_by FROM refund_requests WHERE id=$1`, [request]))[0];
      expect(req).toEqual({ status: "approved", reviewed_by: U.finance });
      expect(await scalar(d, `SELECT status FROM payments WHERE id=$1`, [payment])).toBe("cleared");
    } finally { await d.close(); }
  });

  it("a second approval of the same request is refused and moves no money", async () => {
    const d = await fresh();
    try {
      const payment = await clearedPayment(d, 4000);
      const request = await refundRequest(d, payment, 1000);
      await as(d, U.finance, `SELECT public.approve_refund('${request}')`);
      const after = await paid(d);
      const again = await as(d, U.finance, `SELECT public.approve_refund('${request}')`);
      expect(again.ok).toBe(false);
      expect(again.error).toMatch(/already/);
      expect(await paid(d)).toBe(after);
    } finally { await d.close(); }
  });

  it("refunds against one payment cannot exceed it in total; the last one fully refunds the payment", async () => {
    const d = await fresh();
    try {
      const payment = await clearedPayment(d, 3000);
      const r1 = await refundRequest(d, payment, 2000);
      const r2 = await refundRequest(d, payment, 2000);
      expect((await as(d, U.finance, `SELECT public.approve_refund('${r1}')`)).ok).toBe(true);
      const over = await as(d, U.finance, `SELECT public.approve_refund('${r2}')`);
      expect(over.ok).toBe(false);
      expect(over.error).toMatch(/exceeds the refundable balance/);
      expect(await scalar(d, `SELECT status FROM refund_requests WHERE id=$1`, [r2])).toBe("pending");
      // a request that fits exactly closes the payment out
      const r3 = await refundRequest(d, payment, 1000);
      expect((await as(d, U.finance, `SELECT public.approve_refund('${r3}')`)).ok).toBe(true);
      expect(await scalar(d, `SELECT status FROM payments WHERE id=$1`, [payment])).toBe("refunded");
      expect(await scalar(d, `SELECT paid_amount::numeric FROM fees WHERE id=$1`, [FEE_A]).then(Number)).toBe(0);
      expect(await scalar(d, `SELECT status FROM fees WHERE id=$1`, [FEE_A])).toBe("refunded");
    } finally { await d.close(); }
  });

  it("only finance/admin of the request's college can approve; a student, a teacher and college B's staff cannot", async () => {
    const d = await fresh();
    try {
      const payment = await clearedPayment(d, 1000);
      const request = await refundRequest(d, payment, 500);
      for (const uid of [U.studentA, U.teacherA, U.hodCse, U.warden, U.bHod]) {
        const r = await as(d, uid, `SELECT public.approve_refund('${request}')`);
        expect(r.ok, uid).toBe(false);
      }
      expect(await scalar(d, `SELECT status FROM refund_requests WHERE id=$1`, [request])).toBe("pending");
      expect(await paid(d)).toBe(1000);
    } finally { await d.close(); }
  });

  it("failure injection: an exception after the fee is debited rolls the whole approval back", async () => {
    // The function is one transaction, so a failure at its LAST statement
    // must leave the fee untouched. The last statement is the request
    // claim; forcing it to fail from outside means making the row
    // unclaimable between the lock and the update — which the lock itself
    // prevents. So the injected failure is the payment-status update, via a
    // trigger that raises only for this test.
    const d = await fresh();
    try {
      const payment = await clearedPayment(d, 1000);
      const request = await refundRequest(d, payment, 1000);
      await verify(d, `CREATE OR REPLACE FUNCTION public.qa_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$`);
      await verify(d, `CREATE TRIGGER qa_fail BEFORE UPDATE OF status ON public.payments FOR EACH ROW WHEN (NEW.status='refunded') EXECUTE FUNCTION public.qa_fail()`);
      const r = await as(d, U.finance, `SELECT public.approve_refund('${request}')`);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/injected/);
      expect(await paid(d)).toBe(1000);
      expect(await scalar(d, `SELECT status FROM refund_requests WHERE id=$1`, [request])).toBe("pending");
    } finally { await d.close(); }
  });
});

describe("payment idempotency (047 §7p)", () => {
  const pay = (d: PGlite, amount: number, ref: string | null, fee = FEE_A) => as(d, U.finance,
    `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status, processed_by, transaction_ref)
       VALUES ('${COLLEGE_A}','${fee}','${S.a}',${amount},'upi','cleared',auth.uid(),${ref === null ? "NULL" : `'${ref}'`}) RETURNING id`);

  it("the same UPI reference sent five times records exactly one payment", async () => {
    const d = await fresh();
    try {
      const results = [];
      for (let i = 0; i < 5; i++) results.push(await pay(d, 2000, "UPI-2026-0001"));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results.filter((r) => !r.ok)) expect(r.error).toMatch(/idx_payments_transaction_ref_once/);
      expect(await scalar(d, `SELECT count(*)::int FROM payments WHERE transaction_ref='UPI-2026-0001'`)).toBe(1);
      expect(await paid(d)).toBe(2000);
    } finally { await d.close(); }
  });

  it("the same reference in two colleges is two different settlements", async () => {
    const d = await fresh();
    try {
      expect((await pay(d, 100, "REF-SHARED")).ok).toBe(true);
      const b = await verify(d, `INSERT INTO payments (college_id, fee_id, student_id, amount, method, status, transaction_ref)
        VALUES ('00000001-0000-4000-8000-000000000002','00000014-0000-4000-8000-000000000003','00000004-0000-4000-8000-000000000007',100,'upi','cleared','REF-SHARED') RETURNING id`);
      expect(b).toHaveLength(1);
    } finally { await d.close(); }
  });

  it("DOCUMENTED: an unreferenced (cash) payment has no key and IS repeatable up to the outstanding balance", async () => {
    // Five rapid identical cash payments are five payments. Nothing in the
    // request distinguishes a double-click from two real cash receipts, and
    // inventing a rule ("no two cash payments of the same amount within a
    // minute") would refuse legitimate ones. Register: design decision —
    // a client-generated idempotency key, if cash duplicates are a real
    // operational risk.
    const d = await fresh();
    try {
      const results = [];
      for (let i = 0; i < 5; i++) results.push(await pay(d, 2000, null));
      expect(results.filter((r) => r.ok)).toHaveLength(5);
      expect(await paid(d)).toBe(10000);
      // and the sixth is refused by the ledger guard, not by anything about duplicates
      const sixth = await pay(d, 2000, null);
      expect(sixth.ok).toBe(false);
      expect(sixth.error).toMatch(/exceeds the outstanding balance/);
    } finally { await d.close(); }
  });
});
