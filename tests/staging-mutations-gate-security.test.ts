import { describe, it, expect, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { mutatedFile } from "./staging/mutate";
import { as, verify, scalar, U, S, SEC, COLLEGE_A, GATE_MAIN, GATE_NORTH, GATE_B } from "./staging/harness";

/**
 * Testing the tests.
 *
 * Every assertion in tests/staging-gate-security.test.ts is of the form
 * "this attack is refused". That shape passes just as happily against a
 * database where the attack was impossible for some unrelated reason — a
 * typo in the fixture, a missing seed row, a column that does not exist.
 * The only way to know a control is load-bearing is to take it out and
 * watch the attack succeed.
 *
 * So each case here rebuilds the WHOLE chain with one line of migration 050
 * weakened, and asserts the corresponding attack now lands. If a mutation's
 * pattern stops matching (because the migration was rewritten), mutatedFile
 * throws rather than quietly running the correct SQL — otherwise this file
 * would degrade into asserting that a defect is absent from a migration it
 * was never introduced into.
 *
 * A note on the `$` trap: String.replace treats `$` in the REPLACEMENT as a
 * capture reference, which silently mangles `AS $$` in a plpgsql body. Every
 * replacement below is therefore the FUNCTION form, `() => "..."`, where no
 * such interpretation happens.
 */

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const FILE = "050_gate_security.sql";

/** The same fixture the real suite uses: an approved, in-window pass. */
async function approvedPass(d: PGlite): Promise<{ passId: string; credentialId: string }> {
  const created = await as(d, U.studentA,
    `INSERT INTO public.gate_passes (college_id, student_id, destination, reason, exit_time, return_time)
       VALUES ('${COLLEGE_A}','${S.a}','Market','QA', now() - interval '1 hour', now() + interval '6 hours')
     RETURNING id`);
  const passId = created.data[0].id as string;
  await as(d, U.warden,
    `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${passId}'`);
  const cred = await verify<{ id: string }>(d,
    `SELECT id FROM gate_pass_credentials WHERE gate_pass_id=$1 AND status='ACTIVE'`, [passId]);
  return { passId, credentialId: cred[0].id };
}

async function scan(d: PGlite, guard: string, credentialId: string, gateId: string) {
  const r = await as(d, guard,
    `SELECT outcome FROM public.record_gate_movement('${credentialId}','${gateId}','{}'::jsonb)`);
  return { ...r, outcome: (r.data[0]?.outcome as string) ?? null };
}

describe("mutation: the gate assignment check", () => {
  it("removed, a guard assigned to NORTH can process a pass at MAIN", async () => {
    const d = await mutatedFile(FILE, "drop the gate-assignment EXISTS clause", (sql) =>
      sql.replace(
        `  IF v_gate.id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.security_gate_assignments a
       WHERE a.gate_id = p_gate_id
         AND a.security_personnel_id = v_sp_id
         AND a.revoked_at IS NULL
     ) THEN`,
        () => `  IF v_gate.id IS NULL THEN`
      )
    );
    try {
      const { passId, credentialId } = await approvedPass(d);
      // The real suite asserts UNAUTHORIZED_GATE here.
      const r = await scan(d, U.guardNorth, credentialId, GATE_MAIN);
      expect(r.outcome, "the mutation did not reach the check").toBe("RECORDED");
      expect(await scalar(d, `SELECT count(*)::int FROM gate_movements WHERE gate_pass_id=$1`, [passId])).toBe(1);
    } finally { await d.close(); }
  });
});

describe("mutation: the tenant check on the credential", () => {
  it("removed, the cross-college scan stops being a clean refusal and falls onto the foreign key", async () => {
    // This mutation found something the other nine did not, so it is worth
    // being precise about what it proves.
    //
    // With the college comparison gone, the scan no longer answers
    // INVALID_QR — it proceeds all the way to writing the ledger row and is
    // refused there by gm_pass_tenant_fkey, which binds
    // (gate_pass_id, college_id, student_id) as one key. So the check IS
    // load-bearing (the outcome changes), and it is not the only thing
    // holding: a College A student cannot be recorded leaving through a
    // College B gate even with the application check deleted.
    //
    // The difference still matters in production. The intact check returns
    // a scannable answer and an audit row naming the attempt; the mutant
    // raises a constraint violation at the guard, which is a worse guard
    // experience and a worse security record for the same refusal.
    const d = await mutatedFile(FILE, "drop the cross-college refusal", (sql) =>
      sql.replace(`  IF v_cred.college_id <> v_college THEN`, () => `  IF false THEN`)
    );
    try {
      const { passId, credentialId } = await approvedPass(d);
      const r = await as(d, U.guardB,
        `SELECT outcome FROM public.record_gate_movement('${credentialId}','${GATE_B}','{}'::jsonb)`);

      // Intact, this returns INVALID_QR with ok = true. Mutated, it raises.
      expect(r.ok, "the mutation did not change the outcome at all").toBe(false);
      expect(r.error).toMatch(/gm_pass_tenant_fkey|foreign key/i);

      // And the breach did not land: no movement, pass untouched.
      expect(await scalar(d, `SELECT count(*)::int FROM gate_movements WHERE gate_pass_id=$1`, [passId])).toBe(0);
      expect(await scalar(d, `SELECT status FROM gate_passes WHERE id=$1`, [passId])).toBe("approved");
    } finally { await d.close(); }
  });

  it("removed TOGETHER WITH the composite key, the breach lands — so the key is the one holding", async () => {
    const d = await mutatedFile(FILE, "drop the cross-college refusal and the subject key", (sql) =>
      sql
        .replace(`  IF v_cred.college_id <> v_college THEN`, () => `  IF false THEN`)
        .replace(
          `ALTER TABLE public.gate_movements
  ADD CONSTRAINT gm_pass_tenant_fkey FOREIGN KEY (gate_pass_id, college_id, student_id)
  REFERENCES public.gate_passes(id, college_id, student_id) ON DELETE CASCADE;`,
          // A whole statement, not a fragment: leaving a bare `ALTER TABLE`
          // with its body commented out is a syntax error, and a mutation
          // that fails to compile proves nothing about the control.
          () => `SELECT 1; -- gm_pass_tenant_fkey removed by mutation`
        )
    );
    try {
      const { passId, credentialId } = await approvedPass(d);
      const r = await as(d, U.guardB,
        `SELECT outcome FROM public.record_gate_movement('${credentialId}','${GATE_B}','{}'::jsonb)`);
      expect(r.data[0]?.outcome, "the mutation did not reach both controls").toBe("RECORDED");

      // A College A student, recorded as having left through a College B
      // gate, filed under College B. The tenancy breach in its most literal
      // form — and it takes removing BOTH controls to produce it.
      const row = await verify<{ college_id: string; gate_id: string }>(d,
        `SELECT college_id, gate_id FROM gate_movements WHERE gate_pass_id=$1`, [passId]);
      expect(row[0].gate_id).toBe(GATE_B);
      expect(row[0].college_id).not.toBe(COLLEGE_A);
    } finally { await d.close(); }
  });
});

describe("mutation: the guard's ACTIVE requirement", () => {
  it("removed, a suspended guard can record movements again", async () => {
    const d = await mutatedFile(FILE, "accept any personnel status", (sql) =>
      sql.replace(
        `  WHERE sp.profile_id = v_actor
    AND sp.status = 'ACTIVE'
    AND p.status = 'active'
    AND p.role = 'gate_security';`,
        () => `  WHERE sp.profile_id = v_actor
    AND p.status = 'active'
    AND p.role = 'gate_security';`
      )
    );
    try {
      const { passId, credentialId } = await approvedPass(d);
      const r = await scan(d, U.guardSuspended, credentialId, GATE_MAIN);
      expect(r.outcome, "the mutation did not reach the status check").toBe("RECORDED");
      expect(await scalar(d, `SELECT count(*)::int FROM gate_movements WHERE gate_pass_id=$1`, [passId])).toBe(1);
    } finally { await d.close(); }
  });
});

describe("mutation: the duplicate-scan window", () => {
  it("shortened to nothing, a double tap records an exit and an immediate return", async () => {
    const d = await mutatedFile(FILE, "zero the duplicate interval", (sql) =>
      sql.replace(`c_min_interval CONSTANT INTERVAL := INTERVAL '2 minutes';`, () =>
        `c_min_interval CONSTANT INTERVAL := INTERVAL '0 seconds';`)
    );
    try {
      const { passId, credentialId } = await approvedPass(d);
      expect((await scan(d, U.guardMain, credentialId, GATE_MAIN)).outcome).toBe("RECORDED");
      const second = await scan(d, U.guardMain, credentialId, GATE_MAIN);
      // The student is standing at the gate and the system now believes
      // they went out and came back — exactly what §26 is about.
      expect(second.outcome, "the mutation did not reach the window").toBe("RECORDED");
      expect(await scalar(d, `SELECT status FROM gate_passes WHERE id=$1`, [passId])).toBe("returned");
      expect(await scalar(d, `SELECT count(*)::int FROM gate_movements WHERE gate_pass_id=$1`, [passId])).toBe(2);
    } finally { await d.close(); }
  });
});

describe("mutation: the ledger's append-only trigger", () => {
  it("removed, a recorded movement can be edited into a different history", async () => {
    const d = await mutatedFile(FILE, "drop the ledger UPDATE/DELETE guard", (sql) =>
      sql.replace(
        `DROP TRIGGER IF EXISTS guard_gate_movement_change ON public.gate_movements;
CREATE TRIGGER guard_gate_movement_change
  BEFORE UPDATE OR DELETE ON public.gate_movements
  FOR EACH ROW EXECUTE FUNCTION public.guard_gate_movement();`,
        () => `DROP TRIGGER IF EXISTS guard_gate_movement_change ON public.gate_movements;`
      )
    );
    try {
      const { passId, credentialId } = await approvedPass(d);
      await scan(d, U.guardMain, credentialId, GATE_MAIN);
      // The real suite asserts this throws.
      await verify(d, `UPDATE gate_movements SET occurred_at='2020-01-01T03:00:00Z' WHERE gate_pass_id=$1`, [passId]);
      const when = await scalar(d, `SELECT occurred_at FROM gate_movements WHERE gate_pass_id=$1`, [passId]);
      expect(new Date(String(when)).getFullYear(), "the mutation did not reach the trigger").toBe(2020);
      await verify(d, `DELETE FROM gate_movements WHERE gate_pass_id=$1`, [passId]);
      expect(await scalar(d, `SELECT count(*)::int FROM gate_movements WHERE gate_pass_id=$1`, [passId])).toBe(0);
    } finally { await d.close(); }
  });

  it("with only the INSERT trigger gone, a client-supplied timestamp reaches the ledger", async () => {
    const d = await mutatedFile(FILE, "drop the ledger INSERT stamp", (sql) =>
      sql.replace(
        `DROP TRIGGER IF EXISTS guard_gate_movement_insert ON public.gate_movements;
CREATE TRIGGER guard_gate_movement_insert
  BEFORE INSERT ON public.gate_movements
  FOR EACH ROW EXECUTE FUNCTION public.guard_gate_movement();`,
        () => `DROP TRIGGER IF EXISTS guard_gate_movement_insert ON public.gate_movements;`
      )
    );
    try {
      const { passId } = await approvedPass(d);
      await verify(d,
        `INSERT INTO gate_movements (college_id, gate_pass_id, student_id, gate_id, movement_type, recorded_by, recorded_role, occurred_at)
           VALUES ($1,$2,$3,$4,'OUT',$5,'admin','2020-01-01T03:00:00Z')`,
        [COLLEGE_A, passId, S.a, GATE_MAIN, U.admin]);
      const when = await scalar(d, `SELECT occurred_at FROM gate_movements WHERE gate_pass_id=$1`, [passId]);
      expect(new Date(String(when)).getFullYear(), "the mutation did not reach the stamp").toBe(2020);
    } finally { await d.close(); }
  });
});

describe("mutation: the narrowed gate_passes policy", () => {
  it("restored to FOR ALL, a warden can once again write a movement with a time of their choosing", async () => {
    // This is the defect 050 §16b exists to close, reintroduced.
    const d = await mutatedFile(FILE, "restore gate_passes_staff FOR ALL", (sql) =>
      sql.replace(
        `DROP POLICY IF EXISTS "gate_passes_staff" ON public.gate_passes;`,
        () => `DROP POLICY IF EXISTS "gate_passes_staff" ON public.gate_passes;
CREATE POLICY "gate_passes_staff" ON public.gate_passes FOR ALL
  USING (college_id = public.get_my_college_id() AND (public.get_my_role() = 'admin'
    OR (public.get_my_role() = 'warden' AND public.wardens_student(student_id))))
  WITH CHECK (college_id = public.get_my_college_id() AND (public.get_my_role() = 'admin'
    OR (public.get_my_role() = 'warden' AND public.wardens_student(student_id))));`
      )
    );
    try {
      const { passId } = await approvedPass(d);
      const forged = await as(d, U.warden,
        `UPDATE public.gate_passes SET status='active', actual_exit='2020-01-01T03:00:00Z' WHERE id='${passId}' RETURNING id`);
      expect(forged.rows, "the mutation did not restore the policy").toBe(1);
      expect(await scalar(d, `SELECT status FROM gate_passes WHERE id=$1`, [passId])).toBe("active");
      // The student is recorded as outside with no ledger row at all: no
      // gate, no guard, no credential, and a timestamp from 2020.
      expect(await scalar(d, `SELECT count(*)::int FROM gate_movements WHERE gate_pass_id=$1`, [passId])).toBe(0);
    } finally { await d.close(); }
  });
});

describe("mutation: the credential window", () => {
  it("with the expiry check gone, a five-day-old pass still opens a gate", async () => {
    const d = await mutatedFile(FILE, "drop the expires_at check", (sql) =>
      sql.replace(`  IF now() > v_cred.expires_at THEN`, () => `  IF false THEN`)
    );
    try {
      const created = await as(d, U.studentA,
        `INSERT INTO public.gate_passes (college_id, student_id, destination, reason, exit_time, return_time)
           VALUES ('${COLLEGE_A}','${S.a}','Market','QA', now() - interval '5 days', now() - interval '4 days')
         RETURNING id`);
      const passId = created.data[0].id as string;
      await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${passId}'`);
      const credentialId = (await verify<{ id: string }>(d, `SELECT id FROM gate_pass_credentials WHERE gate_pass_id=$1`, [passId]))[0].id;

      const r = await scan(d, U.guardMain, credentialId, GATE_MAIN);
      expect(r.outcome, "the mutation did not reach the expiry check").toBe("RECORDED");
    } finally { await d.close(); }
  });
});

describe("mutation: the nonce column privilege", () => {
  it("granted, every signed-in role can read the material the QR is signed over", async () => {
    const d = await mutatedFile(FILE, "grant the nonce column", (sql) =>
      sql.replace(
        `GRANT SELECT (
  id, college_id, gate_pass_id, student_id, version, status,
  valid_from, expires_at, issued_at, revoked_by, revoked_at, revocation_reason
) ON TABLE public.gate_pass_credentials TO authenticated;`,
        () => `GRANT SELECT ON TABLE public.gate_pass_credentials TO authenticated;`
      )
    );
    try {
      await approvedPass(d);
      // The real suite asserts "permission denied" for all five roles.
      const r = await as(d, U.warden, `SELECT nonce FROM public.gate_pass_credentials`);
      expect(r.ok, "the mutation did not reach the grant").toBe(true);
      expect(String(r.data[0]?.nonce ?? "")).toMatch(/^[0-9a-f]{64}$/);
    } finally { await d.close(); }
  });
});

describe("mutation: the movement's identity binding", () => {
  it("weakened to two columns, a movement can be attributed to the wrong student", async () => {
    const d = await mutatedFile(FILE, "drop student_id from the pass foreign key", (sql) =>
      sql
        .replace(
          `    ADD CONSTRAINT gate_passes_subject_key UNIQUE (id, college_id, student_id);`,
          () => `    ADD CONSTRAINT gate_passes_subject_key UNIQUE (id, college_id);`
        )
        .replace(
          `  ADD CONSTRAINT gm_pass_tenant_fkey FOREIGN KEY (gate_pass_id, college_id, student_id)
  REFERENCES public.gate_passes(id, college_id, student_id) ON DELETE CASCADE;`,
          () => `  ADD CONSTRAINT gm_pass_tenant_fkey FOREIGN KEY (gate_pass_id, college_id)
  REFERENCES public.gate_passes(id, college_id) ON DELETE CASCADE;`
        )
        .replace(
          `  ADD CONSTRAINT gpc_pass_tenant_fkey FOREIGN KEY (gate_pass_id, college_id, student_id)
  REFERENCES public.gate_passes(id, college_id, student_id) ON DELETE CASCADE;`,
          () => `  ADD CONSTRAINT gpc_pass_tenant_fkey FOREIGN KEY (gate_pass_id, college_id)
  REFERENCES public.gate_passes(id, college_id) ON DELETE CASCADE;`
        )
    );
    try {
      const { passId } = await approvedPass(d);
      // The real suite asserts this is refused by gm_pass_tenant_fkey.
      await verify(d,
        `INSERT INTO gate_movements (college_id, gate_pass_id, student_id, gate_id, movement_type, recorded_by, recorded_role)
           VALUES ($1,$2,$3,$4,'IN',$5,'admin')`,
        [COLLEGE_A, passId, S.c, GATE_MAIN, U.admin]);
      const row = await verify<{ student_id: string }>(d,
        `SELECT student_id FROM gate_movements WHERE gate_pass_id=$1`, [passId]);
      expect(row[0].student_id, "the mutation did not reach the key").toBe(S.c);
    } finally { await d.close(); }
  });
});
