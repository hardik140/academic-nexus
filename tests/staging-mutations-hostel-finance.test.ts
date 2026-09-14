import { describe, it, expect, vi } from "vitest";
import { as, scalar, verify, U, S, COLLEGE_A, PASS_C, FEE_A, FEE_B_COLLEGE, ROOM_B201 } from "./staging/harness";
import { mutated, mutatedFile } from "./staging/mutate";

/**
 * Mutation resistance for 047 §7g–§7j. See tests/staging/mutate.ts for the
 * rule every test here follows: weaken one control, rebuild, and assert the
 * attack now SUCCEEDS.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

describe("hostel mutations", () => {
  it("detects: warden scope removed from the gate_passes decision policy", async () => {
    // The policy this attacks MOVED in migration 050: 047's single
    // gate_passes_staff FOR ALL is replaced there by three narrower ones.
    // The block-ownership predicate is identical in all of them, so widening
    // every occurrence is what removes the scope — and widening only the
    // USING half would still be caught by the WITH CHECK half, which is why
    // this replaces globally rather than once.
    const d = await mutatedFile("050_gate_security.sql", "gate pass warden scope", (sql) =>
      sql
        .split("OR (public.get_my_role() = 'warden' AND public.wardens_student(student_id))")
        .join("OR public.get_my_role() = 'warden'")
    );
    try {
      const r = await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${PASS_C}' RETURNING id`);
      expect(r.rows, "mutation not detected — Warden A reached Block B").toBe(1);
    } finally { await d.close(); }
  });

  it("detects: wardens_block widened to ignore warden_id", async () => {
    const d = await mutated("wardens_block", (sql) =>
      sql.replace("WHERE b.id = p_block_id AND b.warden_id = auth.uid()", "WHERE b.id = p_block_id")
    );
    try {
      expect((await as(d, U.warden, `UPDATE public.hostel_rooms SET status='maintenance' WHERE id='${ROOM_B201}'`)).rows, "mutation not detected").toBe(1);
    } finally { await d.close(); }
  });

  it("detects: student may insert a non-pending pass", async () => {
    const d = await mutated("gate pass pending", (sql) =>
      sql.replace(
        "    AND status = 'pending'\n    AND approved_by IS NULL\n    AND approved_at IS NULL\n    AND actual_exit IS NULL\n    AND actual_return IS NULL\n  );",
        "  );"
      )
    );
    try {
      const r = await as(d, U.studentA,
        `INSERT INTO public.gate_passes (college_id, student_id, destination, exit_time, return_time, status, approved_by)
           VALUES ('${COLLEGE_A}','${S.a}','x',now(),now()+interval '1 day','approved','${U.warden}')`);
      expect(r.ok, "mutation not detected — student minted an approved pass").toBe(true);
    } finally { await d.close(); }
  });
});

describe("finance mutations", () => {
  const pay = (fee: string, student: string, amount: number, status = "cleared") =>
    `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status, processed_by)
       VALUES ('${COLLEGE_A}','${fee}','${student}',${amount},'cash','${status}',auth.uid())`;

  it("detects: status gate removed — a failed payment credits the fee", async () => {
    const d = await mutated("status gate", (sql) =>
      sql.replace("    IF NEW.status <> 'cleared' THEN\n      RETURN NEW;\n    END IF;\n\n    UPDATE public.fees", "    UPDATE public.fees")
    );
    try {
      await as(d, U.finance, pay(FEE_A, S.a, 1000, "failed"));
      expect(Number(await scalar(d, `SELECT paid_amount FROM fees WHERE id=$1`, [FEE_A])), "mutation not detected").toBe(1000);
    } finally { await d.close(); }
  });

  it("detects: overpayment guard removed", async () => {
    const d = await mutated("overpayment", (sql) =>
      sql.replace("    WHERE id = NEW.fee_id\n      AND paid_amount + NEW.amount <= amount;", "    WHERE id = NEW.fee_id;")
    );
    try {
      const r = await as(d, U.finance, pay(FEE_A, S.a, 50000));
      expect(r.ok, "mutation not detected").toBe(true);
      expect(Number(await scalar(d, `SELECT paid_amount FROM fees WHERE id=$1`, [FEE_A]))).toBe(50000);
    } finally { await d.close(); }
  });

  it("detects: positive-amount check removed", async () => {
    const d = await mutated("positive amount", (sql) =>
      sql.replace("  ADD CONSTRAINT payments_amount_positive CHECK (amount > 0);", "  ADD CONSTRAINT payments_amount_positive CHECK (true);")
    );
    try {
      expect((await as(d, U.finance, pay(FEE_A, S.a, -2000))).ok, "mutation not detected").toBe(true);
    } finally { await d.close(); }
  });

  it("detects: composite FK removed — a payment can name the wrong student", async () => {
    // Cross-college is NOT the right probe here. The trigger's UPDATE on fees
    // runs under the caller's RLS, so a College B fee is invisible to College
    // A finance and IF NOT FOUND refuses it regardless of the FK — two
    // independent defences overlap on that path. What the composite FK alone
    // guards is a same-college mismatch: fee A's student is A, the payment
    // says C.
    const d = await mutated("payments composite FK", (sql) =>
      sql.replace(
        /ALTER TABLE public\.payments\n  ADD CONSTRAINT payments_fee_context_fkey[\s\S]*?ON DELETE CASCADE;/,
        `ALTER TABLE public.payments
  ADD CONSTRAINT payments_fee_context_fkey FOREIGN KEY (fee_id) REFERENCES public.fees (id) ON DELETE CASCADE;`
      )
    );
    try {
      const r = await as(d, U.finance, pay(FEE_A, S.c, 100));
      expect(r.ok, "mutation not detected — wrong student accepted").toBe(true);
      // and the cross-college path is STILL closed by the second defence
      expect((await as(d, U.finance, pay(FEE_B_COLLEGE, S.bStudent, 100))).ok).toBe(false);
    } finally { await d.close(); }
  });

  it("detects: processed_by check removed", async () => {
    const d = await mutated("processed_by", (sql) =>
      sql.replace("    AND (processed_by IS NULL OR processed_by = auth.uid())\n  );", "  );")
    );
    try {
      const r = await as(d, U.finance,
        `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status, processed_by)
           VALUES ('${COLLEGE_A}','${FEE_A}','${S.a}',100,'cash','cleared','${U.director}')`);
      expect(r.ok, "mutation not detected").toBe(true);
    } finally { await d.close(); }
  });
});

describe("every SECURITY DEFINER function has a pinned search_path", () => {
  it("none are mutable", async () => {
    const d = await mutated("noop-guard", (sql) => sql + "\n-- probe");
    try {
      const rows = await verify<{ proname: string; cfg: string | null }>(d,
        `SELECT proname, array_to_string(proconfig, ',') AS cfg FROM pg_proc
          WHERE pronamespace='public'::regnamespace AND prosecdef ORDER BY proname`);
      const unpinned = rows.filter((r) => !/search_path=/.test(r.cfg ?? "")).map((r) => r.proname);
      expect(unpinned, "SECURITY DEFINER functions with mutable search_path").toEqual([]);
      expect(rows.length).toBeGreaterThanOrEqual(15);
    } finally { await d.close(); }
  });

  it("detects: the pin removed from get_my_role", async () => {
    const d = await mutated("unpin get_my_role", (sql) =>
      sql.replace("ALTER FUNCTION public.get_my_role()       SET search_path = public, pg_catalog;", "")
    );
    try {
      const [row] = await verify<{ cfg: string | null }>(d,
        `SELECT array_to_string(proconfig, ',') cfg FROM pg_proc WHERE proname='get_my_role' AND pronamespace='public'::regnamespace`);
      expect(row.cfg, "mutation not detected").toBeNull();
    } finally { await d.close(); }
  });
});
