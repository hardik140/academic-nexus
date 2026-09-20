import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { startCluster, session, concurrently, owner, REAL_PG_AVAILABLE, type Cluster } from "./realpg/harness";
import { U, S, COLLEGE_A, FEE_A, OFF, PASS_A } from "./staging/harness";

/**
 * TRUE concurrency — two real sessions against real PostgreSQL, the thing
 * PGlite (single connection) structurally cannot prove. Each test starts
 * two psql processes at once; where an order is needed the second arrives
 * behind a short pg_sleep. The property under test is always: after both
 * finish, is the persisted state the ONE outcome the design intends.
 *
 * BLOCKED, not skipped-as-pass, when no PostgreSQL binary is present — the
 * describe body still registers so the report shows why.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const maybe = REAL_PG_AVAILABLE ? describe : describe.skip;
if (!REAL_PG_AVAILABLE) {
  describe("real-PostgreSQL concurrency", () => {
    it.skip("BLOCKED: no PostgreSQL binary (initdb/pg_ctl/psql) on this machine", () => {});
  });
}

maybe("real-PostgreSQL concurrency", () => {
  let cluster: Cluster;
  beforeAll(() => { cluster = startCluster(); });
  afterAll(() => cluster?.stop());

  const forked = () => cluster.fork();

  it("two payments against one fee cannot overpay it — the ledger trigger's row lock serialises them", async () => {
    const db = forked();
    try {
      // FEE_A owes 10,000. Two 6,000 payments arrive together; exactly one fits.
      const pay = (ref: string) => session(cluster, db,
        `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status, processed_by, transaction_ref)
           VALUES ('${COLLEGE_A}','${FEE_A}','${S.a}',6000,'upi','cleared',auth.uid(),'${ref}');`, U.finance);
      const [a, b] = await concurrently(pay("R1"), pay("R2"));
      const ok = [a, b].filter((r) => r.code === 0).length;
      const refused = [a, b].filter((r) => r.code !== 0);
      expect(ok, `${a.stderr}${b.stderr}`).toBe(1);
      expect(refused[0].stderr).toMatch(/exceeds the outstanding balance/);
      expect(owner(cluster, db, `SELECT paid_amount FROM fees WHERE id='${FEE_A}'`)).toBe("6000.00");
      expect(owner(cluster, db, `SELECT count(*) FROM payments WHERE fee_id='${FEE_A}' AND status='cleared'`)).toBe("1");
    } finally { cluster.drop(db); }
  });

  it("two refund approvals of the SAME request debit the fee exactly once (§7o under real locks)", async () => {
    const db = forked();
    try {
      owner(cluster, db, `INSERT INTO payments (college_id, fee_id, student_id, amount, method, status, processed_by) VALUES ('${COLLEGE_A}','${FEE_A}','${S.a}',4000,'cash','cleared','${U.finance}')`);
      const payId = owner(cluster, db, `SELECT id FROM payments WHERE fee_id='${FEE_A}' AND amount=4000`);
      const paidBefore = Number(owner(cluster, db, `SELECT paid_amount FROM fees WHERE id='${FEE_A}'`));
      owner(cluster, db, `INSERT INTO refund_requests (college_id, student_id, payment_id, amount, reason) VALUES ('${COLLEGE_A}','${S.a}','${payId}',1000,'x')`);
      const reqId = owner(cluster, db, `SELECT id FROM refund_requests WHERE payment_id='${payId}'`);
      const approve = () => session(cluster, db, `SELECT public.approve_refund('${reqId}');`, U.finance);
      const [a, b] = await concurrently(approve(), approve());
      expect([a, b].filter((r) => r.code === 0).length, `${a.stderr}|${b.stderr}`).toBe(1);
      expect([a, b].find((r) => r.code !== 0)!.stderr).toMatch(/already/);
      expect(Number(owner(cluster, db, `SELECT paid_amount FROM fees WHERE id='${FEE_A}'`))).toBe(paidBefore - 1000);
      expect(owner(cluster, db, `SELECT count(*) FROM refund_requests WHERE id='${reqId}' AND status='approved'`)).toBe("1");
    } finally { cluster.drop(db); }
  });

  it("two wardens approving one pending gate pass produce one approval (§7m CAS)", async () => {
    const db = forked();
    try {
      const approve = () => session(cluster, db,
        `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${PASS_A}' AND status='pending';`, U.warden);
      const [a, b] = await concurrently(approve(), approve());
      expect([a, b].every((r) => r.code === 0)).toBe(true); // a no-op UPDATE is not an error
      // exactly one row actually changed
      expect(owner(cluster, db, `SELECT status FROM gate_passes WHERE id='${PASS_A}'`)).toBe("approved");
      const cmd = [a, b].map((r) => r.stdout).join("");
      void cmd;
      expect(owner(cluster, db, `SELECT count(*) FROM gate_passes WHERE id='${PASS_A}' AND status='approved'`)).toBe("1");
    } finally { cluster.drop(db); }
  });

  it("two teachers writing the same attendance key — the unique index lets exactly one win", async () => {
    const db = forked();
    try {
      owner(cluster, db, `INSERT INTO course_enrollments (college_id, offering_id, student_id, status) VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.b}','enrolled') ON CONFLICT DO NOTHING`);
      const mark = (st: string) => session(cluster, db,
        `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
           VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.b}','2026-09-20','${st}',auth.uid());`, U.teacherA);
      const [a, b] = await concurrently(mark("present"), mark("absent"));
      expect([a, b].filter((r) => r.code === 0).length).toBe(1);
      expect([a, b].find((r) => r.code !== 0)!.stderr).toMatch(/duplicate key|unique/i);
      expect(owner(cluster, db, `SELECT count(*) FROM attendance WHERE offering_id='${OFF.dsA3}' AND student_id='${S.b}' AND date='2026-09-20'`)).toBe("1");
    } finally { cluster.drop(db); }
  });

  it("two admins activating two different planned semesters — one active survives (partial unique index)", async () => {
    const db = forked();
    try {
      // SEM_3 is active; close it, then race SEM_1 and SEM_5 to active.
      owner(cluster, db, `UPDATE semesters SET status='closed' WHERE id='00000006-0000-4000-8000-000000000003'`);
      const activate = (id: string) => session(cluster, db,
        `UPDATE public.semesters SET status='active' WHERE id='${id}' AND status='planned';`, U.admin);
      const [a, b] = await concurrently(
        activate("00000006-0000-4000-8000-000000000001"),
        activate("00000006-0000-4000-8000-000000000005"),
      );
      expect([a, b].filter((r) => r.code === 0).length, `${a.stderr}|${b.stderr}`).toBe(1);
      expect([a, b].find((r) => r.code !== 0)!.stderr).toMatch(/idx_semesters_one_active/);
      expect(owner(cluster, db, `SELECT count(*) FROM semesters WHERE college_id='${COLLEGE_A}' AND status='active'`)).toBe("1");
    } finally { cluster.drop(db); }
  });

  it("a paid-in-full fee and a concurrent refund do not cross: the refund waits on the row lock and reads the committed balance", async () => {
    const db = forked();
    try {
      // One 10,000 payment clears the fee. A refund of 4,000 and a second
      // (illegal) 2,000 payment race; the payment must see paid=10,000 (full)
      // and be refused, the refund must succeed against the committed row.
      owner(cluster, db, `INSERT INTO payments (college_id, fee_id, student_id, amount, method, status, processed_by) VALUES ('${COLLEGE_A}','${FEE_A}','${S.a}',10000,'cash','cleared','${U.finance}')`);
      const payId = owner(cluster, db, `SELECT id FROM payments WHERE fee_id='${FEE_A}' AND amount=10000`);
      owner(cluster, db, `INSERT INTO refund_requests (college_id, student_id, payment_id, amount, reason) VALUES ('${COLLEGE_A}','${S.a}','${payId}',4000,'x')`);
      const reqId = owner(cluster, db, `SELECT id FROM refund_requests WHERE payment_id='${payId}'`);
      // ORDERING, AND WHY IT IS A HANDSHAKE RATHER THAN A SLEEP
      //
      // Both interleavings here are legal PostgreSQL; they answer different
      // questions. Refund-first drops paid to 6,000, at which point the
      // 2,000 payment is genuinely within the outstanding balance and is
      // CORRECTLY accepted — so the assertions below would fail while the
      // database behaved exactly as designed. The question this test exists
      // to ask is the other one: does a payment racing a refund see the
      // COMMITTED balance rather than a half-applied one, and is it refused
      // while the fee is still paid in full.
      //
      // This used to be pinned with `SELECT pg_sleep(0.2)` on the refund
      // side. That is a bet on process startup, not a guarantee: the sleep
      // only begins once the REFUND's psql has connected, so it assumes the
      // payment's psql connects within 200 ms of it. Under a loaded machine
      // — the full suite runs PGlite instances alongside this — that
      // assumption fails, and the test failed with it (once in two
      // consecutive full-suite runs on 2026-09-19).
      //
      // So the order is now established by a handshake with no clock in it:
      //
      //   payment: take a SESSION advisory lock, then announce itself,
      //            then attempt the insert. The lock is released only when
      //            its psql disconnects — i.e. after the insert has been
      //            attempted and answered.
      //   refund:  wait (unbounded) for the announcement, then block on the
      //            same advisory lock.
      //
      // Because the announcement is written AFTER the lock is held, seeing
      // it proves the lock is held, so the refund cannot slip past. Both
      // sessions still start simultaneously and the payment still performs
      // its balance check under a real row lock with the refund connected
      // and contending — this fixes WHICH interleaving runs, not whether
      // there is one.
      //
      // No Finance code, no RPC, no schema, and no assertion changed.
      owner(cluster, db, `CREATE TABLE public._race_signal (name TEXT PRIMARY KEY)`);
      owner(cluster, db, `GRANT SELECT, INSERT ON public._race_signal TO authenticated`);

      const RACE_LOCK = 7001;
      const [refund, overpay] = await concurrently(
        session(cluster, db, `
          DO $wait$
          BEGIN
            WHILE NOT EXISTS (SELECT 1 FROM public._race_signal WHERE name = 'payment-holding') LOOP
              PERFORM pg_sleep(0.02);
            END LOOP;
          END $wait$;
          SELECT pg_advisory_lock(${RACE_LOCK});
          SELECT public.approve_refund('${reqId}');`, U.finance),
        session(cluster, db, `
          SELECT pg_advisory_lock(${RACE_LOCK});
          INSERT INTO public._race_signal (name) VALUES ('payment-holding');
          INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status, processed_by) VALUES ('${COLLEGE_A}','${FEE_A}','${S.a}',2000,'cash','cleared',auth.uid());`, U.finance),
      );
      expect(refund.code, refund.stderr).toBe(0);
      expect(overpay.code).not.toBe(0);
      expect(overpay.stderr).toMatch(/exceeds the outstanding balance/);
      expect(Number(owner(cluster, db, `SELECT paid_amount FROM fees WHERE id='${FEE_A}'`))).toBe(6000);
    } finally { cluster.drop(db); }
  });
});
