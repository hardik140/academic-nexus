import { describe, it, expect, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { mutatedFile, mutatedFiles } from "./staging/mutate";
import { as, scalar, U, S, OFF, COLLEGE_A, COLLEGE_B, FEE_A, ROOM_A102 } from "./staging/harness";

/**
 * Are migration 051's controls LOAD-BEARING?
 *
 * tests/phase3-hardening.test.ts asserts that each Phase-2 attack is now
 * denied. On its own that proves very little: a test can pass because the
 * control works, or because the attack was never expressed correctly, or
 * because some unrelated constraint happened to refuse the statement. Those
 * are indistinguishable from a green tick.
 *
 * So each case here rebuilds the real migration chain with exactly ONE
 * control removed from 051, and asserts the attack then SUCCEEDS. That is
 * the only evidence that the control — and not something else — is what
 * stops it, and that the paired test in phase3-hardening can actually detect
 * a regression.
 *
 * mutatedFile() throws if its pattern no longer matches, so a mutation that
 * silently stopped applying fails loudly rather than asserting a defect is
 * absent from a migration it was never introduced into.
 */
vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const P3 = "051_phase3_hardening.sql";

/** The whole point: after the mutation, the attack goes through. */
const succeeded = (r: { ok: boolean; rows: number; error: string | null }) => r.ok && r.rows > 0;

const PEND = "0c0c0c0c-0000-4000-8000-00000000cccc";
async function addPendingUser(db: PGlite) {
  await db.exec(
    `INSERT INTO auth.users (id, email, raw_user_meta_data)
       VALUES ('${PEND}','pend@x.test','{"college_id":"${COLLEGE_A}"}');
     UPDATE public.profiles SET college_id='${COLLEGE_A}' WHERE id='${PEND}';`
  );
}

describe("mutation: the tenant predicate on security instructions (P1-1)", () => {
  it("removed, a College-B guard reads College-A instructions again", async () => {
    const db = await mutatedFile(P3, "si tenant predicate", (sql) =>
      sql.replace(
        "    college_id = public.get_my_college_id()\n    AND public.security_has_permission('gate_security.instructions.view')",
        "    public.security_has_permission('gate_security.instructions.view')"
      )
    );
    try {
      const r = await as(db, U.guardB, `SELECT id FROM public.security_instructions WHERE college_id='${COLLEGE_A}'`);
      expect(r.data.length, "the cross-tenant leak did not reopen — this mutation no longer targets the control").toBeGreaterThan(0);
    } finally { await db.close(); }
  });
});

describe("mutation: the active-status gate on the tenant helpers (P2-4)", () => {
  // Since 053 the status gate is enforced twice: in 051's helpers and in
  // app_access_allowed(), which every table's restrictive tenant_access_gate
  // calls (054's definition is the one that survives). Removed from both, the
  // original attack reproduces.
  it("removed, a pending account resolves a tenant and reads college data", async () => {
    const db = await mutatedFiles("pending gate", {
      "051_phase3_hardening.sql": (sql) =>
        sql.replaceAll("WHERE id = auth.uid() AND status = 'active';", "WHERE id = auth.uid();"),
      "054_session_registry.sql": (sql) =>
        sql.replace(
          "    WHERE p.id = auth.uid()\n      AND p.status = 'active'\n      AND (p.role = 'super_admin' OR c.lifecycle_state = 'ACTIVE')\n  ) AND public.current_session_permitted();",
          "    WHERE p.id = auth.uid()\n      AND (p.role = 'super_admin' OR c.lifecycle_state = 'ACTIVE')\n  ) AND public.current_session_permitted();"
        ),
    });
    try {
      await addPendingUser(db);
      const r = await as(db, PEND, `SELECT id FROM public.course_offerings WHERE college_id='${COLLEGE_A}'`);
      expect(r.data.length, "a pending account still saw nothing — the gate is not what stops it").toBeGreaterThan(0);
    } finally { await db.close(); }
  });
});

describe("mutation: the finance ledger controls (P1-2)", () => {
  // THREE controls stand between a fee delete and the loss of its ledger:
  // the RESTRICT foreign key, guard_fee_delete, and — discovered by this
  // mutation refusing to reproduce with only the first two removed —
  // update_fee_on_payment's DELETE branch, which refuses to let a CLEARED
  // payment be deleted even when the delete arrives as a cascade from the
  // parent. All three have to come out before the history can be erased,
  // which is the strongest possible answer to P1-2 and is why this test
  // removes all three rather than one.
  it("with RESTRICT, the delete guard AND the cleared-payment guard gone, deleting a fee erases its payment history", async () => {
    const db = await mutatedFile(P3, "fee cascade", (sql) =>
      sql
        .replace(
          "REFERENCES public.fees(id, college_id, student_id) ON DELETE RESTRICT;",
          "REFERENCES public.fees(id, college_id, student_id) ON DELETE CASCADE;"
        )
        .replace(
          "CREATE TRIGGER guard_fee_delete\n  BEFORE DELETE ON public.fees\n  FOR EACH ROW EXECUTE FUNCTION public.guard_fee_delete();",
          "-- guard_fee_delete trigger removed by mutation"
        )
        .replace(
          "    IF OLD.status = 'cleared' AND auth.uid() IS NOT NULL THEN\n      RAISE EXCEPTION 'A cleared payment cannot be deleted; reverse it with a refund'\n        USING ERRCODE = 'check_violation';\n    END IF;",
          "    -- cleared-payment delete guard removed by mutation"
        )
    );
    try {
      await db.exec(
        `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method)
           VALUES ('${COLLEGE_A}','${FEE_A}','${S.a}',3000,'cash');`
      );
      expect(Number(await scalar(db, `SELECT count(*)::int FROM public.payments WHERE fee_id='${FEE_A}'`))).toBe(1);

      const r = await as(db, U.finance, `DELETE FROM public.fees WHERE id='${FEE_A}' RETURNING id`);
      expect(succeeded(r), `the delete was still refused: ${r.error}`).toBe(true);
      // The ledger went with the parent — exactly the accounting loss P1-2 closes.
      expect(Number(await scalar(db, `SELECT count(*)::int FROM public.payments WHERE fee_id='${FEE_A}'`))).toBe(0);
    } finally { await db.close(); }
  });

  it("with the ledger-column guard gone, paid_amount can be set by hand", async () => {
    const db = await mutatedFile(P3, "fee ledger columns", (sql) =>
      sql.replace(
        "CREATE TRIGGER guard_fee_ledger_columns\n  BEFORE UPDATE ON public.fees\n  FOR EACH ROW EXECUTE FUNCTION public.guard_fee_ledger_columns();",
        "-- guard_fee_ledger_columns trigger removed by mutation"
      )
    );
    try {
      const r = await as(db, U.finance, `UPDATE public.fees SET paid_amount=9999 WHERE id='${FEE_A}' RETURNING id`);
      expect(succeeded(r), `the hand edit was still refused: ${r.error}`).toBe(true);
      expect(Number(await scalar(db, `SELECT paid_amount FROM public.fees WHERE id='${FEE_A}'`))).toBe(9999);
    } finally { await db.close(); }
  });
});

describe("mutation: the closed-semester freeze (P2-3)", () => {
  it("detached from marks, a teacher writes into a closed semester again", async () => {
    const db = await mutatedFile(P3, "closed semester freeze", (sql) =>
      sql.replace(
        "ARRAY['attendance','marks','course_enrollments','timetable_slots','course_offerings']",
        "ARRAY['timetable_slots']"
      )
    );
    try {
      const r = await as(db, U.teacherA,
        `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks)
           VALUES ('${COLLEGE_A}','${OFF.historical}','${S.f}','midterm',100,50) RETURNING id`);
      expect(succeeded(r), `the closed semester still refused the write: ${r.error}`).toBe(true);
    } finally { await db.close(); }
  });
});

describe("mutation: the cross-tenant row guards (P2-5)", () => {
  it("without guard_row_student_tenant, finance bills another college's student", async () => {
    const db = await mutatedFile(P3, "fee student tenant", (sql) =>
      sql.replace(
        "CREATE TRIGGER guard_row_student_tenant BEFORE INSERT OR UPDATE ON public.fees\n  FOR EACH ROW EXECUTE FUNCTION public.guard_row_student_tenant();",
        "-- guard_row_student_tenant trigger removed by mutation"
      )
    );
    try {
      const r = await as(db, U.finance,
        `INSERT INTO public.fees (college_id, student_id, type, amount, due_date, status, paid_amount)
           VALUES ('${COLLEGE_A}','${S.bStudent}','tuition',500,'2026-12-01','pending',0) RETURNING id`);
      expect(succeeded(r), `still refused: ${r.error} — the trigger is not the control here`).toBe(true);
    } finally { await db.close(); }
  });

  it("without guard_allocation_tenant, a warden allocates another college's student", async () => {
    const db = await mutatedFile(P3, "allocation tenant", (sql) =>
      sql.replace(
        "CREATE TRIGGER guard_allocation_tenant BEFORE INSERT OR UPDATE ON public.hostel_allocations\n  FOR EACH ROW EXECUTE FUNCTION public.guard_allocation_tenant();",
        "-- guard_allocation_tenant trigger removed by mutation"
      )
    );
    try {
      // The College-B student already holds an active allocation in the seed,
      // and idx_hostel_alloc_one_active (a DIFFERENT control) would refuse the
      // insert before the tenant guard was ever consulted. Clear it first so
      // this mutation tests one control rather than two.
      await db.exec(`DELETE FROM public.hostel_allocations WHERE student_id='${S.bStudent}';`);
      const r = await as(db, U.warden,
        `INSERT INTO public.hostel_allocations (college_id, student_id, room_id, status)
           VALUES ('${COLLEGE_A}','${S.bStudent}','${ROOM_A102}','active') RETURNING id`);
      expect(succeeded(r), `still refused: ${r.error}`).toBe(true);
    } finally { await db.close(); }
  });

  it("without the invitation tenant/tier predicate, an admin files into another college", async () => {
    const db = await mutatedFile(P3, "invitation tenant", (sql) =>
      sql.replace(
        "    invited_by = auth.uid()\n    AND college_id = public.get_my_college_id()\n    AND public.can_invite_role(role)",
        "    invited_by = auth.uid()"
      )
    );
    try {
      const r = await as(db, U.admin,
        `INSERT INTO public.invitations (college_id, email, role, invited_by)
           VALUES ('${COLLEGE_B}','x@x.test','director','${U.admin}') RETURNING id`);
      expect(succeeded(r), `still refused: ${r.error}`).toBe(true);
    } finally { await db.close(); }
  });
});

describe("mutation: enrolment binding (P3-8)", () => {
  it("without guard_enrolled_student, a teacher marks a student who is not on the offering", async () => {
    const db = await mutatedFile(P3, "enrolment binding", (sql) =>
      // Drop only the marks half of the binding; attendance keeps its guard,
      // so exactly one control is removed.
      sql.replace(
        "DROP TRIGGER IF EXISTS guard_enrolled_student ON public.marks;\nCREATE TRIGGER guard_enrolled_student\n  BEFORE INSERT OR UPDATE ON public.marks\n  FOR EACH ROW EXECUTE FUNCTION public.guard_enrolled_student();",
        "DROP TRIGGER IF EXISTS guard_enrolled_student ON public.marks;"
      )
    );
    try {
      const r = await as(db, U.teacherA,
        `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks)
           VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.c}','final',100,50) RETURNING id`);
      expect(succeeded(r), `still refused: ${r.error}`).toBe(true);
    } finally { await db.close(); }
  });
});
