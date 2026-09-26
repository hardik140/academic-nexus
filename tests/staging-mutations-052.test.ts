import { describe, it, expect, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { mutatedFile } from "./staging/mutate";
import { as, scalar, U, COLLEGE_A, COLLEGE_B, SEM_3 } from "./staging/harness";

/**
 * Are migration 052's controls LOAD-BEARING?
 *
 * tests/phase3-reopen-audit.test.ts asserts that each attack on the reopen
 * path and the audit trail is denied. On its own that proves very little — a
 * green tick looks the same whether the control works, the attack was never
 * expressed correctly, or something unrelated refused the statement.
 *
 * So each case here rebuilds the real migration chain with exactly ONE
 * control removed from 052 and asserts the attack then SUCCEEDS. mutatedFile()
 * throws when its pattern stops matching, so a mutation that silently stopped
 * applying fails loudly instead of quietly asserting that a defect is absent.
 */
vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const M = "052_controlled_reopen_and_audit.sql";
const REASON = "Registrar correction: internal-1 marks transposed for two students";
const B_ADMIN = "0d0d0d0d-0000-4000-8000-00000000dddd";

const succeeded = (r: { ok: boolean; rows: number; data: unknown[] }) =>
  r.ok && (r.rows > 0 || r.data.length > 0);

/**
 * Put the database in the state every one of these attacks needs: a CLOSED
 * semester that still sits inside an ACTIVE academic year, which SEM_PAST
 * (year 2025-26, closed) deliberately is not.
 */
async function closeRunningTerm(db: PGlite) {
  const r = await as(db, U.admin,
    `UPDATE public.semesters SET status='closed' WHERE id='${SEM_3}' RETURNING id`);
  expect(r.ok, `setup failed — could not close the running term: ${r.error}`).toBe(true);
}

async function addCollegeBAdmin(db: PGlite) {
  await db.exec(
    `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${B_ADMIN}','badmin@x.test','{}');
     UPDATE public.profiles SET college_id='${COLLEGE_B}', role='admin', status='active' WHERE id='${B_ADMIN}';`
  );
}

const reopen = (db: PGlite, uid: string, reason = REASON) =>
  as(db, uid, `SELECT status FROM public.reopen_semester($1, $2)`, [SEM_3, reason]);

// ───────────────────────────────────────────────────────────────────────
// The RPC's own authorization — it is SECURITY DEFINER, so these checks are
// the entire access control on that path.
// ───────────────────────────────────────────────────────────────────────

describe("mutation: who may call reopen_semester()", () => {
  it("without the role gate, a teacher reopens a closed semester", async () => {
    const db = await mutatedFile(M, "reopen role gate", (sql) =>
      sql.replace(
        `  IF v_role IS NULL OR v_role NOT IN ('admin', 'super_admin') THEN
    RAISE EXCEPTION 'reopen_semester: your role may not reopen a closed semester'
      USING ERRCODE = '42501';
  END IF;`,
        "  -- role gate removed by mutation"
      )
    );
    try {
      await closeRunningTerm(db);
      const r = await reopen(db, U.teacherA);
      expect(succeeded(r), `a teacher was still refused: ${r.error}`).toBe(true);
      expect(await scalar(db, `SELECT status FROM public.semesters WHERE id='${SEM_3}'`)).toBe("reopened");
    } finally { await db.close(); }
  });

  it("without the tenant check, a College-B admin reopens a College-A semester", async () => {
    const db = await mutatedFile(M, "reopen tenant check", (sql) =>
      sql.replace(
        "  IF NOT FOUND OR v_sem.college_id IS DISTINCT FROM v_college THEN",
        "  IF NOT FOUND THEN"
      )
    );
    try {
      await addCollegeBAdmin(db);
      await closeRunningTerm(db);
      const r = await reopen(db, B_ADMIN);
      expect(succeeded(r), `the cross-tenant reopen was still refused: ${r.error}`).toBe(true);
      expect(await scalar(db,
        `SELECT status FROM public.semesters WHERE id='${SEM_3}' AND college_id='${COLLEGE_A}'`)).toBe("reopened");
    } finally { await db.close(); }
  });

  it("without the reason check, history is reopened with no stated cause", async () => {
    const db = await mutatedFile(M, "reopen reason check", (sql) =>
      sql.replace(
        `  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'reopen_semester: a reason of at least 10 characters is required'
      USING ERRCODE = 'check_violation';
  END IF;`,
        "  -- reason requirement removed by mutation"
      )
    );
    try {
      await closeRunningTerm(db);
      const r = await reopen(db, U.admin, "");
      expect(succeeded(r), `a blank reason was still refused: ${r.error}`).toBe(true);
      // And the audit record it leaves carries no reason — §6's "reason is
      // mandatory" is exactly what was lost.
      const reason = await scalar(db,
        `SELECT new_value->>'reason' FROM public.audit_logs
          WHERE table_name='semesters' AND record_id='${SEM_3}' AND action='semesters.reopened'`);
      expect(reason ?? null).toBeNull();
    } finally { await db.close(); }
  });

  it("without the closed-year check, a sealed year gains a writable term", async () => {
    const db = await mutatedFile(M, "reopen closed-year check", (sql) =>
      sql.replace(
        `  IF EXISTS (
    SELECT 1 FROM public.academic_years ay
    WHERE ay.id = v_sem.academic_year_id AND ay.status = 'closed'
  ) THEN
    RAISE EXCEPTION 'reopen_semester: the academic year is closed; a semester inside it cannot be reopened'
      USING ERRCODE = 'check_violation';
  END IF;`,
        "  -- closed-year check removed by mutation"
      )
    );
    try {
      // SEM_PAST sits in the closed 2025-26 year — the case this check exists for.
      const SEM_PAST = "00000006-0000-4000-8000-000000000009";
      const r = await as(db, U.admin,
        `SELECT status FROM public.reopen_semester($1, $2)`, [SEM_PAST, REASON]);
      expect(succeeded(r), `still refused: ${r.error}`).toBe(true);
      expect(await scalar(db, `SELECT status FROM public.semesters WHERE id='${SEM_PAST}'`)).toBe("reopened");
    } finally { await db.close(); }
  });
});

// ───────────────────────────────────────────────────────────────────────
// The correction window's boundaries
// ───────────────────────────────────────────────────────────────────────

describe("mutation: the reopened window stays narrow", () => {
  it("without the transition check, a reopened semester is promoted to the running term", async () => {
    const db = await mutatedFile(M, "reopened transition check", (sql) =>
      sql.replace(
        `    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IS DISTINCT FROM 'closed' THEN
      RAISE EXCEPTION 'semesters: a reopened semester may only be closed again, not moved to %', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;`,
        "    -- reopened transition check removed by mutation"
      )
    );
    try {
      await closeRunningTerm(db);
      expect(succeeded(await reopen(db, U.admin))).toBe(true);
      const r = await as(db, U.admin,
        `UPDATE public.semesters SET status='active' WHERE id='${SEM_3}' RETURNING id`);
      expect(succeeded(r), `still refused: ${r.error}`).toBe(true);
      expect(await scalar(db, `SELECT status FROM public.semesters WHERE id='${SEM_3}'`)).toBe("active");
    } finally { await db.close(); }
  });

  it("without the column freeze, a reopened semester's dates can be rewritten", async () => {
    const db = await mutatedFile(M, "reopened column freeze", (sql) =>
      sql.replace(
        `    IF to_jsonb(NEW) - 'status' - 'is_current' - 'updated_at'
       IS DISTINCT FROM
       to_jsonb(OLD) - 'status' - 'is_current' - 'updated_at' THEN
      RAISE EXCEPTION 'semesters: a reopened semester may change only status'
        USING ERRCODE = 'check_violation';
    END IF;`,
        "    -- reopened column freeze removed by mutation"
      )
    );
    try {
      await closeRunningTerm(db);
      expect(succeeded(await reopen(db, U.admin))).toBe(true);
      const r = await as(db, U.admin,
        `UPDATE public.semesters SET name='Rewritten', end_date='2027-01-31'
          WHERE id='${SEM_3}' RETURNING id`);
      expect(succeeded(r), `still refused: ${r.error}`).toBe(true);
      expect(await scalar(db, `SELECT name FROM public.semesters WHERE id='${SEM_3}'`)).toBe("Rewritten");
    } finally { await db.close(); }
  });

  it("TWO controls guard the closed row: RLS and the period trigger", async () => {
    // Removing the trigger's sanction test alone does NOT reopen the hole,
    // because semesters_update_manage's USING clause (047) already excludes a
    // closed row from any ordinary UPDATE. Both have to go, and this case
    // removes both to show the trigger is the one that matters once RLS is
    // widened — which is precisely the defence-in-depth §0 asks for.
    const db = await mutatedFile(M, "closed immutability + RLS", (sql) =>
      sql.replace(
        `    IF NOT v_sanctioned THEN
      RAISE EXCEPTION '%: a closed period is immutable', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;`,
        "    -- closed immutability removed by mutation"
      )
    );
    try {
      await closeRunningTerm(db);

      // With only the trigger gone, the seal still holds — RLS refuses.
      const rlsOnly = await as(db, U.admin,
        `UPDATE public.semesters SET status='reopened' WHERE id='${SEM_3}' RETURNING id`);
      expect(succeeded(rlsOnly),
        "RLS did not refuse — the second control is not where this test says it is").toBe(false);

      // Widen RLS as a future careless change might, and the hole opens.
      await db.exec(
        `DROP POLICY IF EXISTS "semesters_update_manage" ON public.semesters;
         CREATE POLICY "semesters_update_manage" ON public.semesters
           FOR UPDATE USING (college_id = public.get_my_college_id())
           WITH CHECK (college_id = public.get_my_college_id());`
      );
      const both = await as(db, U.admin,
        `UPDATE public.semesters SET status='reopened' WHERE id='${SEM_3}' RETURNING id`);
      expect(succeeded(both), `still refused with both controls gone: ${both.error}`).toBe(true);
    } finally { await db.close(); }
  });
});

// ───────────────────────────────────────────────────────────────────────
// The audit trail
// ───────────────────────────────────────────────────────────────────────

describe("mutation: the audit trail (§15)", () => {
  it("without the period audit trigger, a reopen leaves no record at all", async () => {
    const db = await mutatedFile(M, "period audit trigger", (sql) =>
      sql.replace(
        `DROP TRIGGER IF EXISTS audit_period_status ON public.semesters;
CREATE TRIGGER audit_period_status
  AFTER UPDATE ON public.semesters
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.audit_academic_period_status();`,
        "DROP TRIGGER IF EXISTS audit_period_status ON public.semesters;"
      )
    );
    try {
      await closeRunningTerm(db);
      expect(succeeded(await reopen(db, U.admin))).toBe(true);
      expect(await scalar(db, `SELECT status FROM public.semesters WHERE id='${SEM_3}'`)).toBe("reopened");

      // History was altered and nothing recorded that it was.
      expect(Number(await scalar(db,
        `SELECT count(*)::int FROM public.audit_logs
          WHERE table_name='semesters' AND record_id='${SEM_3}'`))).toBe(0);
    } finally { await db.close(); }
  });

  it("without the immutability trigger, a permissive policy makes the trail editable", async () => {
    const db = await mutatedFile(M, "audit immutability trigger", (sql) =>
      sql.replace(
        `DROP TRIGGER IF EXISTS guard_audit_immutable ON public.audit_logs;
CREATE TRIGGER guard_audit_immutable
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.guard_audit_immutable();`,
        "DROP TRIGGER IF EXISTS guard_audit_immutable ON public.audit_logs;"
      )
    );
    try {
      await closeRunningTerm(db);
      expect(succeeded(await reopen(db, U.admin))).toBe(true);

      // audit_logs has no UPDATE/DELETE policy, so RLS is the outer control
      // here too. Widen it the way a later change might, and with the trigger
      // gone the actor can rewrite the record of what they just did.
      await db.exec(
        `CREATE POLICY "audit_logs_tmp_permissive" ON public.audit_logs
           FOR ALL USING (true) WITH CHECK (true);`
      );
      const r = await as(db, U.admin,
        `UPDATE public.audit_logs SET action='nothing happened'
          WHERE table_name='semesters' AND record_id='${SEM_3}' RETURNING id`);
      expect(succeeded(r), `still refused: ${r.error}`).toBe(true);
      expect(Number(await scalar(db,
        `SELECT count(*)::int FROM public.audit_logs WHERE action='nothing happened'`))).toBeGreaterThan(0);
    } finally { await db.close(); }
  });

  it("without the profile audit trigger, a role grant leaves no record", async () => {
    const db = await mutatedFile(M, "profile audit trigger", (sql) =>
      // Renaming the trigger is NOT a mutation — an earlier draft did exactly
      // that and the renamed trigger went on firing, so the "attack" reported
      // a record that was still being written. The statement has to go.
      sql.replace(
        `DROP TRIGGER IF EXISTS audit_profile_privilege ON public.profiles;
CREATE TRIGGER audit_profile_privilege
  AFTER UPDATE ON public.profiles
  FOR EACH ROW
  WHEN (
    OLD.role          IS DISTINCT FROM NEW.role
 OR OLD.status        IS DISTINCT FROM NEW.status
 OR OLD.department_id IS DISTINCT FROM NEW.department_id
  )
  EXECUTE FUNCTION public.audit_profile_privilege();`,
        "DROP TRIGGER IF EXISTS audit_profile_privilege ON public.profiles;"
      )
    );
    try {
      const victim = "0f0f0f0f-0000-4000-8000-00000000ffff";
      await db.exec(
        `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${victim}','v@x.test','{}');
         UPDATE public.profiles SET college_id='${COLLEGE_A}', role='teacher', status='active' WHERE id='${victim}';`
      );
      const r = await as(db, U.admin,
        `UPDATE public.profiles SET role='student' WHERE id='${victim}' RETURNING id`);
      expect(succeeded(r), `the demotion itself was refused: ${r.error}`).toBe(true);
      expect(Number(await scalar(db,
        `SELECT count(*)::int FROM public.audit_logs WHERE table_name='profiles' AND record_id='${victim}'`)))
        .toBe(0);
    } finally { await db.close(); }
  });
});
