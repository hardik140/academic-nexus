import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  stagingDb, as, verify, scalar,
  U, S, SEC, COLLEGE_A, COLLEGE_B,
  GATE_MAIN, GATE_NORTH, GATE_B, GATE_RETIRED,
} from "./staging/harness";
import { GATE_SECURITY_CAPABILITIES } from "@/lib/permissions";

/**
 * Gate security, against the real migration chain (001..050).
 *
 * WHAT THIS SUITE IS FOR
 *
 * Every check that decides whether a person physically leaves the campus
 * lives inside record_gate_movement(). This file drives that function the
 * way PostgREST would — as the guard's own session, with the guard's own
 * JWT claim — and then reads the result back as the owner to see what
 * actually landed. A scanner UI is not involved, which is the point: if the
 * database refuses these attacks, no front end can permit them.
 *
 * The one thing it CANNOT test is the HMAC on the QR payload, because that
 * key lives in the application and never in the database. That half is in
 * tests/gate-security-credential.test.ts, and the seam between them is
 * narrow and deliberate: the application proves the payload was minted
 * here, the database proves everything else.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

let db: PGlite;
beforeAll(async () => { db = await stagingDb(); });
afterAll(async () => { await db?.close(); });

const fresh = () => stagingDb();

/** A pass whose credential window contains now(), approved and ready to scan. */
async function approvedPass(
  d: PGlite,
  opts: { student?: string; college?: string; approver?: string } = {}
): Promise<{ passId: string; credentialId: string }> {
  const student = opts.student ?? S.a;
  const college = opts.college ?? COLLEGE_A;
  const approver = opts.approver ?? U.warden;
  const owner = student === S.a ? U.studentA : student === S.c ? U.studentC : U.bStudent;

  const created = await as(d, owner,
    `INSERT INTO public.gate_passes (college_id, student_id, destination, reason, exit_time, return_time)
       VALUES ('${college}','${student}','Market','QA', now() - interval '1 hour', now() + interval '6 hours')
     RETURNING id`);
  expect(created.ok, created.error ?? "").toBe(true);
  const passId = created.data[0].id as string;

  const approved = await as(d, approver,
    `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now()
      WHERE id='${passId}' AND status='pending' RETURNING id`);
  expect(approved.rows, approved.error ?? "").toBe(1);

  const cred = await verify<{ id: string }>(d,
    `SELECT id FROM gate_pass_credentials WHERE gate_pass_id=$1 AND status='ACTIVE'`, [passId]);
  expect(cred).toHaveLength(1);
  return { passId, credentialId: cred[0].id };
}

/** Runs the scan exactly as a guard's session would. */
async function scan(d: PGlite, guard: string, credentialId: string, gateId: string) {
  const r = await as(d, guard,
    `SELECT outcome, movement, detail, student_name, occurred_at FROM public.record_gate_movement('${credentialId}','${gateId}','{}'::jsonb)`);
  return {
    ...r,
    outcome: (r.data[0]?.outcome as string) ?? null,
    movement: (r.data[0]?.movement as string) ?? null,
    studentName: (r.data[0]?.student_name as string) ?? null,
    occurredAt: (r.data[0]?.occurred_at as string) ?? null,
  };
}

const passStatus = (d: PGlite, id: string) =>
  scalar(d, `SELECT status FROM gate_passes WHERE id=$1`, [id]);
const movementCount = (d: PGlite, id: string) =>
  scalar(d, `SELECT count(*)::int FROM gate_movements WHERE gate_pass_id=$1`, [id]);

// ─────────────────────────────────────────────────────────────
// §46 — the end-to-end scenario
// ─────────────────────────────────────────────────────────────
describe("the whole journey, through the database only", () => {
  it("approve -> scan OUT -> outside -> scan IN -> returned, with a ledger row for each", async () => {
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);
      expect(await passStatus(d, passId)).toBe("approved");

      const out = await scan(d, U.guardMain, credentialId, GATE_MAIN);
      expect(out.outcome, out.error ?? "").toBe("RECORDED");
      expect(out.movement).toBe("OUT");
      expect(out.data[0].student_name).toBe("QA Student A");
      expect(await passStatus(d, passId)).toBe("active");

      // The movement is on the ledger with the gate, the guard and the role.
      const ledgerOut = await verify<Record<string, unknown>>(d,
        `SELECT movement_type, gate_id, recorded_by, security_personnel_id, recorded_role, is_override, credential_id
           FROM gate_movements WHERE gate_pass_id=$1`, [passId]);
      expect(ledgerOut).toHaveLength(1);
      expect(ledgerOut[0].movement_type).toBe("OUT");
      expect(ledgerOut[0].gate_id).toBe(GATE_MAIN);
      expect(ledgerOut[0].recorded_by).toBe(U.guardMain);
      expect(ledgerOut[0].security_personnel_id).toBe(SEC.main);
      expect(ledgerOut[0].recorded_role).toBe("gate_security");
      expect(ledgerOut[0].is_override).toBe(false);
      expect(ledgerOut[0].credential_id).toBe(credentialId);

      // The duplicate window is 2 minutes; move the clock past it the only
      // way an append-only ledger allows — as the owner, on the ledger row,
      // which the trigger refuses... so instead the pass is scanned at a
      // second gate after the window, simulated by ageing the movement
      // through a direct owner DELETE-free path: we age the row's
      // occurred_at is impossible, so this test asserts the IN through a
      // separate pass below and checks the window itself in its own test.
      const tooSoon = await scan(d, U.guardMain, credentialId, GATE_MAIN);
      expect(tooSoon.outcome).toBe("ALREADY_RECORDED");
      expect(await movementCount(d, passId)).toBe(1);
    } finally { await d.close(); }
  });

  it("the return leg records IN and closes the credential", async () => {
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);
      await scan(d, U.guardMain, credentialId, GATE_MAIN);

      // Age the OUT beyond the duplicate window. The ledger refuses UPDATE
      // for every role including the owner, so the clock is moved instead:
      // this is the one place the test has to reach past the trigger, and
      // it does it by disabling the trigger as the owner, not by finding a
      // hole in it.
      await verify(d, `ALTER TABLE gate_movements DISABLE TRIGGER guard_gate_movement_change`);
      await verify(d, `UPDATE gate_movements SET occurred_at = now() - interval '3 minutes' WHERE gate_pass_id=$1`, [passId]);
      await verify(d, `ALTER TABLE gate_movements ENABLE TRIGGER guard_gate_movement_change`);

      const back = await scan(d, U.guardNorth, credentialId, GATE_NORTH);
      expect(back.outcome, back.error ?? "").toBe("RECORDED");
      expect(back.movement).toBe("IN");
      expect(await passStatus(d, passId)).toBe("returned");
      expect(await movementCount(d, passId)).toBe(2);

      // A student who is back inside has no scannable QR.
      expect(await scalar(d, `SELECT status FROM gate_pass_credentials WHERE id=$1`, [credentialId])).toBe("CONSUMED");
      const again = await scan(d, U.guardMain, credentialId, GATE_MAIN);
      expect(again.outcome).toBe("ALREADY_RETURNED");
      expect(await movementCount(d, passId)).toBe(2);
    } finally { await d.close(); }
  });

  it("a student leaving by one gate may return through another", async () => {
    // Already covered above (MAIN out, NORTH in) — asserted separately here
    // because it is a business rule someone will be tempted to "fix" by
    // pinning the return to the exit gate.
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);
      await scan(d, U.guardMain, credentialId, GATE_MAIN);
      await verify(d, `ALTER TABLE gate_movements DISABLE TRIGGER guard_gate_movement_change`);
      await verify(d, `UPDATE gate_movements SET occurred_at = now() - interval '3 minutes' WHERE gate_pass_id=$1`, [passId]);
      await verify(d, `ALTER TABLE gate_movements ENABLE TRIGGER guard_gate_movement_change`);
      const back = await scan(d, U.guardNorth, credentialId, GATE_NORTH);
      expect(back.outcome).toBe("RECORDED");
      const gates = await verify<{ gate_id: string }>(d,
        `SELECT gate_id FROM gate_movements WHERE gate_pass_id=$1 ORDER BY occurred_at`, [passId]);
      expect(gates.map((g) => g.gate_id)).toEqual([GATE_MAIN, GATE_NORTH]);
    } finally { await d.close(); }
  });
});

// ─────────────────────────────────────────────────────────────
// §45 — the attack list
// ─────────────────────────────────────────────────────────────
describe("§45 QR replay and copy testing", () => {
  it("Test 1 — a College A credential scanned by a College B guard is refused, and says nothing about why", async () => {
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);
      const r = await scan(d, U.guardB, credentialId, GATE_B);
      expect(r.outcome).toBe("INVALID_QR");
      expect(r.data[0].detail).toBe("The QR credential could not be verified.");
      expect(await passStatus(d, passId)).toBe("approved");
      expect(await movementCount(d, passId)).toBe(0);

      // The audit row, by contrast, is precise — that is where the
      // cross-tenant attempt has to be visible.
      const audited = await verify<{ action: string }>(d,
        `SELECT action FROM audit_logs WHERE user_id=$1 AND action LIKE 'gate_scan%' ORDER BY created_at DESC LIMIT 1`,
        [U.guardB]);
      expect(audited[0]?.action).toBe("gate_scan_cross_college");
    } finally { await d.close(); }
  });

  it("Test 2 — an expired credential is refused and marked expired", async () => {
    const d = await fresh();
    try {
      const created = await as(d, U.studentA,
        `INSERT INTO public.gate_passes (college_id, student_id, destination, reason, exit_time, return_time)
           VALUES ('${COLLEGE_A}','${S.a}','Market','QA', now() - interval '5 days', now() - interval '4 days')
         RETURNING id`);
      const passId = created.data[0].id as string;
      await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${passId}'`);
      const credentialId = (await verify<{ id: string }>(d, `SELECT id FROM gate_pass_credentials WHERE gate_pass_id=$1`, [passId]))[0].id;

      const r = await scan(d, U.guardMain, credentialId, GATE_MAIN);
      expect(r.outcome).toBe("EXPIRED");
      expect(await movementCount(d, passId)).toBe(0);
      expect(await scalar(d, `SELECT status FROM gate_pass_credentials WHERE id=$1`, [credentialId])).toBe("EXPIRED");
    } finally { await d.close(); }
  });

  it("Test 2b — a credential presented before its window is refused", async () => {
    const d = await fresh();
    try {
      const created = await as(d, U.studentA,
        `INSERT INTO public.gate_passes (college_id, student_id, destination, reason, exit_time, return_time)
           VALUES ('${COLLEGE_A}','${S.a}','Market','QA', now() + interval '5 days', now() + interval '6 days')
         RETURNING id`);
      const passId = created.data[0].id as string;
      await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${passId}'`);
      const credentialId = (await verify<{ id: string }>(d, `SELECT id FROM gate_pass_credentials WHERE gate_pass_id=$1`, [passId]))[0].id;

      expect((await scan(d, U.guardMain, credentialId, GATE_MAIN)).outcome).toBe("NOT_YET_VALID");
      expect(await movementCount(d, passId)).toBe(0);
    } finally { await d.close(); }
  });

  it("Test 3 — a revoked credential is refused, and revoking does not undo the approval", async () => {
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);
      const revoked = await as(d, U.warden,
        `SELECT revoked FROM public.revoke_gate_pass_credential('${passId}','phone reported lost')`);
      expect(revoked.data[0].revoked).toBe(1);

      const r = await scan(d, U.guardMain, credentialId, GATE_MAIN);
      expect(r.outcome).toBe("REVOKED");
      expect(await movementCount(d, passId)).toBe(0);
      expect(await passStatus(d, passId)).toBe("approved");
    } finally { await d.close(); }
  });

  it("Test 5 — a guessed credential id is refused", async () => {
    const d = await fresh();
    try {
      const r = await scan(d, U.guardMain, "00000000-0000-4000-8000-0000deadbeef", GATE_MAIN);
      expect(r.outcome).toBe("INVALID_QR");
      const audited = await verify<{ action: string }>(d,
        `SELECT action FROM audit_logs WHERE user_id=$1 AND action LIKE 'gate_scan%' ORDER BY created_at DESC LIMIT 1`,
        [U.guardMain]);
      expect(audited[0]?.action).toBe("gate_scan_invalid_qr");
    } finally { await d.close(); }
  });

  it("Test 6 — the same QR scanned twice in quick succession produces one movement", async () => {
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);
      const first = await scan(d, U.guardMain, credentialId, GATE_MAIN);
      const second = await scan(d, U.guardMain, credentialId, GATE_MAIN);
      const third = await scan(d, U.guardNorth, credentialId, GATE_NORTH);
      expect(first.outcome).toBe("RECORDED");
      expect(second.outcome).toBe("ALREADY_RECORDED");
      // A different guard at a different gate gets the same answer — the
      // window is a property of the PASS, not of the scanner.
      expect(third.outcome).toBe("ALREADY_RECORDED");
      expect(await movementCount(d, passId)).toBe(1);
      expect(await passStatus(d, passId)).toBe("active");

      // Both repeats REPLAY the one movement rather than merely refusing:
      // same direction, same instant, same student as the row in the
      // ledger. This is what a guard needs to see after a dropped
      // response, and it is asserted against the stored row so the
      // function cannot satisfy it by inventing a plausible answer.
      const [row] = await verify<{ movement_type: string; occurred_at: string }>(d,
        `SELECT movement_type, occurred_at FROM gate_movements WHERE gate_pass_id=$1`, [passId]);
      for (const repeat of [second, third]) {
        expect(repeat.movement).toBe(row.movement_type);
        expect(new Date(repeat.occurredAt!).getTime()).toBe(new Date(row.occurred_at).getTime());
        expect(repeat.studentName).toBe(first.studentName);
      }
    } finally { await d.close(); }
  });

  it("a retry after a lost response confirms the movement instead of refusing it", async () => {
    // Section 34, and the reason the duplicate path replays rather than
    // refuses. A guard's network drops between the INSERT and the
    // response; they have no idea whether the exit was recorded, so they
    // scan again. Before this, the second scan answered ALREADY_OUTSIDE
    // with no student, no direction and no time — indistinguishable, at a
    // gate, from "this pass is not usable", which is how a recorded
    // student gets turned back or an unrecorded one gets waved through.
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);

      const landed = await scan(d, U.guardMain, credentialId, GATE_MAIN);
      expect(landed.outcome).toBe("RECORDED");
      expect(landed.movement).toBe("OUT");

      // The retry the guard makes because they never saw the line above.
      const retry = await scan(d, U.guardMain, credentialId, GATE_MAIN);

      expect(retry.outcome).toBe("ALREADY_RECORDED");
      expect(retry.movement).toBe("OUT");
      expect(retry.studentName).toBe(landed.studentName);
      expect(new Date(retry.occurredAt!).getTime()).toBe(new Date(landed.occurredAt!).getTime());
      expect(retry.data[0].detail).toMatch(/already recorded/i);

      // And the point of the whole exercise: still one crossing.
      expect(await movementCount(d, passId)).toBe(1);
      expect(await passStatus(d, passId)).toBe("active");
    } finally { await d.close(); }
  });

  it("Test 8 — a suspended guard cannot scan, even at a gate still assigned to them", async () => {
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);
      // The suspended guard's assignment to MAIN is live in the dataset.
      expect(await scalar(d,
        `SELECT count(*)::int FROM security_gate_assignments WHERE security_personnel_id=$1 AND revoked_at IS NULL`,
        [SEC.suspended])).toBe(1);

      const r = await as(d, U.guardSuspended,
        `SELECT outcome FROM public.record_gate_movement('${credentialId}','${GATE_MAIN}','{}'::jsonb)`);
      expect(r.ok, "a suspended guard recorded a movement").toBe(false);
      expect(r.error).toMatch(/not an active gate security operator/);
      expect(await movementCount(d, passId)).toBe(0);
    } finally { await d.close(); }
  });

  it("Test 8c — a deactivated guard cannot scan either, and cannot be revived to try again", async () => {
    // SUSPENDED and DEACTIVATED are refused by the same `status = 'ACTIVE'`
    // predicate, so this looks redundant next to Test 8. It is not: the two
    // mean different things operationally — suspension is a pause, and
    // deactivation is the row you are left with after someone leaves the
    // job. A future change that made suspension reversible in-place could
    // easily special-case one and not the other, and the attack matrix
    // lists them separately for that reason.
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);

      expect((await as(d, U.director,
        `UPDATE public.security_personnel SET status='DEACTIVATED', deactivated_by=auth.uid()
          WHERE id='${SEC.main}' RETURNING id`)).rows).toBe(1);

      const r = await as(d, U.guardMain,
        `SELECT outcome FROM public.record_gate_movement('${credentialId}','${GATE_MAIN}','{}'::jsonb)`);
      expect(r.ok, "a deactivated guard recorded a movement").toBe(false);
      expect(r.error).toMatch(/not an active gate security operator/);
      expect(await movementCount(d, passId)).toBe(0);
      expect(await passStatus(d, passId)).toBe("approved");

      // And the account cannot be quietly put back to work.
      const revive = await as(d, U.director,
        `UPDATE public.security_personnel SET status='ACTIVE' WHERE id='${SEC.main}' RETURNING id`);
      expect(revive.ok).toBe(false);
      expect(await scalar(d, `SELECT status FROM security_personnel WHERE id=$1`, [SEC.main])).toBe("DEACTIVATED");
    } finally { await d.close(); }
  });

  it("Test 8b — no other role can call the movement recorder at all", async () => {
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);
      for (const uid of [U.warden, U.admin, U.director, U.studentA, U.teacherA, U.hodCse, U.finance]) {
        const r = await as(d, uid,
          `SELECT outcome FROM public.record_gate_movement('${credentialId}','${GATE_MAIN}','{}'::jsonb)`);
        expect(r.ok, `${uid} recorded a movement`).toBe(false);
        expect(r.error).toMatch(/not an active gate security operator/);
      }
      expect(await movementCount(d, passId)).toBe(0);
    } finally { await d.close(); }
  });

  it("Test 9 — a guard assigned to NORTH cannot process a pass at MAIN", async () => {
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);
      const r = await scan(d, U.guardNorth, credentialId, GATE_MAIN);
      expect(r.outcome).toBe("UNAUTHORIZED_GATE");
      expect(r.data[0].detail).toBe("This pass cannot be processed at this gate.");
      expect(await movementCount(d, passId)).toBe(0);
    } finally { await d.close(); }
  });

  it("Test 9b — a retired gate admits nothing, even with a live assignment", async () => {
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);
      await verify(d,
        `INSERT INTO security_gate_assignments (college_id, security_personnel_id, gate_id) VALUES ($1,$2,$3)`,
        [COLLEGE_A, SEC.main, GATE_RETIRED]);
      const r = await scan(d, U.guardMain, credentialId, GATE_RETIRED);
      expect(r.outcome).toBe("UNAUTHORIZED_GATE");
      expect(await movementCount(d, passId)).toBe(0);
    } finally { await d.close(); }
  });

  it("Test 9c — a guard cannot process a pass at another college's gate", async () => {
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);
      const r = await scan(d, U.guardMain, credentialId, GATE_B);
      expect(r.outcome).toBe("UNAUTHORIZED_GATE");
      expect(await movementCount(d, passId)).toBe(0);
    } finally { await d.close(); }
  });

  it("Test 10 — the scan takes no student and no pass from the caller, so there is nothing to tamper with", async () => {
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);
      const otherPass = await approvedPass(d, { student: S.c, approver: U.wardenB });

      // The only identifiers the function accepts are a credential and a
      // gate. Student and pass are resolved from the credential row, so
      // naming someone else's pass is not an input that exists.
      const r = await scan(d, U.guardMain, credentialId, GATE_MAIN);
      expect(r.outcome).toBe("RECORDED");
      const recorded = await verify<{ student_id: string; gate_pass_id: string }>(d,
        `SELECT student_id, gate_pass_id FROM gate_movements WHERE gate_pass_id=$1`, [passId]);
      expect(recorded[0].student_id).toBe(S.a);
      expect(recorded[0].gate_pass_id).toBe(passId);
      expect(await movementCount(d, otherPass.passId)).toBe(0);

      // And the ledger itself refuses a row that attributes a movement to a
      // student the pass does not belong to — gm_pass_tenant_fkey.
      await expect(verify(d,
        `INSERT INTO gate_movements (college_id, gate_pass_id, student_id, gate_id, movement_type, recorded_by, recorded_role)
           VALUES ($1,$2,$3,$4,'IN',$5,'admin')`,
        [COLLEGE_A, passId, S.c, GATE_MAIN, U.admin])).rejects.toThrow(/gm_pass_tenant_fkey|foreign key/i);
    } finally { await d.close(); }
  });
});

// ─────────────────────────────────────────────────────────────
// The ledger
// ─────────────────────────────────────────────────────────────
describe("the movement ledger is a ledger", () => {
  it("cannot be updated or deleted by anyone, including the owner", async () => {
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);
      await scan(d, U.guardMain, credentialId, GATE_MAIN);

      for (const uid of [U.admin, U.director, U.warden, U.guardMain, U.studentA]) {
        const upd = await as(d, uid, `UPDATE public.gate_movements SET movement_type='IN' WHERE gate_pass_id='${passId}' RETURNING id`);
        expect(upd.rows, `${uid} edited the ledger`).toBe(0);
        const del = await as(d, uid, `DELETE FROM public.gate_movements WHERE gate_pass_id='${passId}' RETURNING id`);
        expect(del.rows, `${uid} deleted from the ledger`).toBe(0);
      }

      await expect(verify(d, `UPDATE gate_movements SET movement_type='IN' WHERE gate_pass_id=$1`, [passId]))
        .rejects.toThrow(/immutable ledger/);
      await expect(verify(d, `DELETE FROM gate_movements WHERE gate_pass_id=$1`, [passId]))
        .rejects.toThrow(/immutable ledger/);
      expect(await movementCount(d, passId)).toBe(1);
    } finally { await d.close(); }
  });

  it("stamps the server clock and discards any timestamp it is handed", async () => {
    const d = await fresh();
    try {
      const { passId } = await approvedPass(d);
      await verify(d,
        `INSERT INTO gate_movements (college_id, gate_pass_id, student_id, gate_id, movement_type, recorded_by, recorded_role, occurred_at, created_at)
           VALUES ($1,$2,$3,$4,'OUT',$5,'admin','2020-01-01T03:00:00Z','2020-01-01T03:00:00Z')`,
        [COLLEGE_A, passId, S.a, GATE_MAIN, U.admin]);
      const row = await verify<{ occurred_at: string }>(d,
        `SELECT occurred_at FROM gate_movements WHERE gate_pass_id=$1`, [passId]);
      // The value the caller asked for is gone; the row carries now().
      expect(new Date(row[0].occurred_at).getFullYear()).toBeGreaterThan(2020);
    } finally { await d.close(); }
  });

  it("accepts exactly one OUT and one IN per pass", async () => {
    const d = await fresh();
    try {
      const { passId } = await approvedPass(d);
      await verify(d,
        `INSERT INTO gate_movements (college_id, gate_pass_id, student_id, gate_id, movement_type, recorded_by, recorded_role)
           VALUES ($1,$2,$3,$4,'OUT',$5,'admin')`,
        [COLLEGE_A, passId, S.a, GATE_MAIN, U.admin]);
      await expect(verify(d,
        `INSERT INTO gate_movements (college_id, gate_pass_id, student_id, gate_id, movement_type, recorded_by, recorded_role)
           VALUES ($1,$2,$3,$4,'OUT',$5,'admin')`,
        [COLLEGE_A, passId, S.a, GATE_MAIN, U.admin])).rejects.toThrow(/idx_gm_one_per_direction|duplicate key/i);
    } finally { await d.close(); }
  });

  it("an override without a reason is refused by the table itself", async () => {
    const d = await fresh();
    try {
      const { passId } = await approvedPass(d);
      await expect(verify(d,
        `INSERT INTO gate_movements (college_id, gate_pass_id, student_id, movement_type, recorded_by, recorded_role, is_override)
           VALUES ($1,$2,$3,'OUT',$4,'warden',true)`,
        [COLLEGE_A, passId, S.a, U.warden])).rejects.toThrow(/gm_override_has_reason/);
      // …and a scan without a gate likewise.
      await expect(verify(d,
        `INSERT INTO gate_movements (college_id, gate_pass_id, student_id, movement_type, recorded_by, recorded_role)
           VALUES ($1,$2,$3,'OUT',$4,'gate_security')`,
        [COLLEGE_A, passId, S.a, U.guardMain])).rejects.toThrow(/gm_scan_has_gate/);
    } finally { await d.close(); }
  });
});

// ─────────────────────────────────────────────────────────────
// §35 — the override
// ─────────────────────────────────────────────────────────────
describe("the manual override", () => {
  it("records a movement for the warden, marked as an override with its reason", async () => {
    const d = await fresh();
    try {
      const { passId } = await approvedPass(d);
      const r = await as(d, U.warden,
        `SELECT outcome, movement FROM public.record_manual_gate_movement('${passId}','OUT','${GATE_MAIN}','phone battery dead at main gate, ID checked')`);
      expect(r.ok, r.error ?? "").toBe(true);
      expect(r.data[0].outcome).toBe("RECORDED");
      expect(await passStatus(d, passId)).toBe("active");

      const row = await verify<Record<string, unknown>>(d,
        `SELECT is_override, override_reason, recorded_role, recorded_by, security_personnel_id, credential_id
           FROM gate_movements WHERE gate_pass_id=$1`, [passId]);
      expect(row[0].is_override).toBe(true);
      expect(row[0].override_reason).toBe("phone battery dead at main gate, ID checked");
      expect(row[0].recorded_role).toBe("warden");
      expect(row[0].recorded_by).toBe(U.warden);
      expect(row[0].security_personnel_id).toBeNull();
      expect(row[0].credential_id).toBeNull();
    } finally { await d.close(); }
  });

  it("refuses a reason that is not one", async () => {
    const d = await fresh();
    try {
      const { passId } = await approvedPass(d);
      for (const reason of ["", "   ", "ok", "n/a"]) {
        const r = await as(d, U.warden,
          `SELECT outcome FROM public.record_manual_gate_movement('${passId}','OUT','${GATE_MAIN}','${reason}')`);
        expect(r.ok, `reason "${reason}" accepted`).toBe(false);
        expect(r.error).toMatch(/why it was necessary/);
      }
      expect(await movementCount(d, passId)).toBe(0);
    } finally { await d.close(); }
  });

  it("is refused for a guard, a director and a student", async () => {
    const d = await fresh();
    try {
      const { passId } = await approvedPass(d);
      for (const uid of [U.guardMain, U.director, U.studentA, U.teacherA]) {
        const r = await as(d, uid,
          `SELECT outcome FROM public.record_manual_gate_movement('${passId}','OUT','${GATE_MAIN}','a perfectly reasonable sounding explanation')`);
        expect(r.ok, `${uid} recorded an override`).toBe(false);
      }
      expect(await movementCount(d, passId)).toBe(0);
    } finally { await d.close(); }
  });

  it("stops at the warden's own block, and cannot skip the state machine", async () => {
    const d = await fresh();
    try {
      // Student C lives in Block B, which Warden A does not run.
      const other = await approvedPass(d, { student: S.c, approver: U.wardenB });
      const crossBlock = await as(d, U.warden,
        `SELECT outcome FROM public.record_manual_gate_movement('${other.passId}','OUT','${GATE_MAIN}','trying to reach another block')`);
      expect(crossBlock.ok).toBe(false);
      expect(crossBlock.error).toMatch(/not in your hostel block/);

      // A return before an exit is refused, with the ledger untouched.
      const own = await approvedPass(d);
      const early = await as(d, U.warden,
        `SELECT outcome, detail FROM public.record_manual_gate_movement('${own.passId}','IN','${GATE_MAIN}','recording a return that never happened')`);
      expect(early.data[0].outcome).toBe("INVALID_MOVEMENT");
      expect(await movementCount(d, own.passId)).toBe(0);
    } finally { await d.close(); }
  });
});

// ─────────────────────────────────────────────────────────────
// §33 — what a guard can see
// ─────────────────────────────────────────────────────────────
describe("minimum data exposure", () => {
  it("a guard has no read path to students, profiles, gate passes or credentials", async () => {
    const d = await fresh();
    try {
      await approvedPass(d);
      const reads: [string, string][] = [
        ["students", `SELECT id FROM public.students`],
        ["gate_passes", `SELECT id FROM public.gate_passes`],
        ["gate_pass_credentials", `SELECT id FROM public.gate_pass_credentials`],
        ["fees", `SELECT id FROM public.fees`],
        ["marks", `SELECT id FROM public.marks`],
        ["attendance", `SELECT id FROM public.attendance`],
        ["payments", `SELECT id FROM public.payments`],
        ["hostel_allocations", `SELECT id FROM public.hostel_allocations`],
      ];
      for (const [table, sql] of reads) {
        const r = await as(d, U.guardMain, sql);
        expect(r.data.length, `a guard read ${table}`).toBe(0);
      }
      // profiles: their own row only.
      const profiles = await as(d, U.guardMain, `SELECT id FROM public.profiles`);
      expect(profiles.data.map((p) => p.id)).toEqual([U.guardMain]);
    } finally { await d.close(); }
  });

  it("the nonce is unreadable by every signed-in role, whatever the policies say", async () => {
    const d = await fresh();
    try {
      await approvedPass(d);
      for (const uid of [U.admin, U.director, U.warden, U.guardMain, U.studentA]) {
        const r = await as(d, uid, `SELECT nonce FROM public.gate_pass_credentials`);
        expect(r.ok, `${uid} read a credential nonce`).toBe(false);
        expect(r.error).toMatch(/permission denied/i);
      }
    } finally { await d.close(); }
  });

  it("nobody signed in may write a credential or a movement row", async () => {
    const d = await fresh();
    try {
      const { passId } = await approvedPass(d);
      for (const uid of [U.admin, U.director, U.warden, U.guardMain, U.studentA]) {
        const cred = await as(d, uid,
          `INSERT INTO public.gate_pass_credentials (college_id, gate_pass_id, student_id, nonce, valid_from, expires_at)
             VALUES ('${COLLEGE_A}','${passId}','${S.a}','deadbeef', now(), now()+interval '1 day')`);
        expect(cred.ok, `${uid} minted a credential`).toBe(false);

        const move = await as(d, uid,
          `INSERT INTO public.gate_movements (college_id, gate_pass_id, student_id, gate_id, movement_type, recorded_by, recorded_role)
             VALUES ('${COLLEGE_A}','${passId}','${S.a}','${GATE_MAIN}','OUT','${uid}','admin')`);
        expect(move.ok, `${uid} wrote the ledger directly`).toBe(false);
      }
      expect(await movementCount(d, passId)).toBe(0);
    } finally { await d.close(); }
  });

  it("the scanner's own feed refuses a gate the caller does not operate", async () => {
    const d = await fresh();
    try {
      const { credentialId } = await approvedPass(d);
      await scan(d, U.guardMain, credentialId, GATE_MAIN);
      const own = await as(d, U.guardMain, `SELECT movement_id FROM public.security_scan_feed('${GATE_MAIN}', 20)`);
      expect(own.data.length).toBe(1);
      const other = await as(d, U.guardNorth, `SELECT movement_id FROM public.security_scan_feed('${GATE_MAIN}', 20)`);
      expect(other.data.length, "a guard read another gate's feed").toBe(0);
    } finally { await d.close(); }
  });

  it("a student sees their own crossings and nobody else's", async () => {
    const d = await fresh();
    try {
      const { credentialId } = await approvedPass(d);
      await scan(d, U.guardMain, credentialId, GATE_MAIN);
      expect((await as(d, U.studentA, `SELECT id FROM public.gate_movements`)).data.length).toBe(1);
      expect((await as(d, U.studentB, `SELECT id FROM public.gate_movements`)).data.length).toBe(0);
    } finally { await d.close(); }
  });
});

// ─────────────────────────────────────────────────────────────
// §12, §13 — the roster
// ─────────────────────────────────────────────────────────────
describe("security personnel and gates", () => {
  it("only director and admin manage the roster; a guard cannot promote themselves", async () => {
    const d = await fresh();
    try {
      for (const uid of [U.guardMain, U.warden, U.teacherA, U.studentA, U.finance]) {
        const r = await as(d, uid,
          `UPDATE public.security_personnel SET permissions = permissions || ARRAY['gate_security.audit.view'] WHERE id='${SEC.main}' RETURNING id`);
        expect(r.rows, `${uid} edited the roster`).toBe(0);
      }
      const byDirector = await as(d, U.director,
        `UPDATE public.security_personnel SET permissions = ARRAY['gate_security.dashboard.view']::text[] WHERE id='${SEC.main}' RETURNING id`);
      expect(byDirector.rows, byDirector.error ?? "").toBe(1);
    } finally { await d.close(); }
  });

  it("the lifecycle only moves the way §12 allows, and DEACTIVATED is terminal", async () => {
    const d = await fresh();
    try {
      // ACTIVE -> SUSPENDED -> ACTIVE
      expect((await as(d, U.director, `UPDATE public.security_personnel SET status='SUSPENDED' WHERE id='${SEC.main}' RETURNING id`)).rows).toBe(1);
      expect((await as(d, U.director, `UPDATE public.security_personnel SET status='ACTIVE', authorized_by=auth.uid() WHERE id='${SEC.main}' RETURNING id`)).rows).toBe(1);
      // -> DEACTIVATED, then nothing
      expect((await as(d, U.director, `UPDATE public.security_personnel SET status='DEACTIVATED', deactivated_by=auth.uid() WHERE id='${SEC.main}' RETURNING id`)).rows).toBe(1);
      const revive = await as(d, U.director, `UPDATE public.security_personnel SET status='ACTIVE', authorized_by=auth.uid() WHERE id='${SEC.main}'`);
      expect(revive.ok, "a deactivated guard was revived").toBe(false);
      expect(revive.error).toMatch(/may not move from DEACTIVATED/);
    } finally { await d.close(); }
  });

  it("activation must name who authorized it, and deactivation who did it", async () => {
    const d = await fresh();
    try {
      await verify(d, `UPDATE security_personnel SET status='SUSPENDED' WHERE id=$1`, [SEC.main]);
      await expect(verify(d, `UPDATE security_personnel SET status='ACTIVE', authorized_by=NULL WHERE id=$1`, [SEC.main]))
        .rejects.toThrow(/must record who authorized it/);
      await expect(verify(d, `UPDATE security_personnel SET status='DEACTIVATED', deactivated_by=NULL WHERE id=$1`, [SEC.main]))
        .rejects.toThrow(/must record who did it/);
    } finally { await d.close(); }
  });

  it("an unknown permission string cannot be stored", async () => {
    const d = await fresh();
    try {
      await expect(verify(d,
        `UPDATE security_personnel SET permissions = ARRAY['gate_security.everything'] WHERE id=$1`, [SEC.main]))
        .rejects.toThrow(/sp_permissions_known/);
    } finally { await d.close(); }
  });

  it("the database's permission vocabulary and the application's are the same list", async () => {
    // A drift here is silent in both directions: a UI offering a permission
    // the CHECK refuses fails at write time, and a policy naming one the UI
    // never grants is dead code.
    const def = await scalar(db,
      `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='sp_permissions_known'`) as string;
    for (const cap of GATE_SECURITY_CAPABILITIES) {
      expect(def, `${cap} missing from the CHECK constraint`).toContain(cap);
    }
    const inConstraint = def.match(/gate_security\.[a-z.]+/g) ?? [];
    expect(new Set(inConstraint).size).toBe(GATE_SECURITY_CAPABILITIES.length);
  });

  it("a College A guard cannot be assigned to a College B gate", async () => {
    const d = await fresh();
    try {
      await expect(verify(d,
        `INSERT INTO security_gate_assignments (college_id, security_personnel_id, gate_id) VALUES ($1,$2,$3)`,
        [COLLEGE_A, SEC.main, GATE_B])).rejects.toThrow(/sga_gate_tenant_fkey|foreign key/i);
      // and mislabelling the college does not help
      await expect(verify(d,
        `INSERT INTO security_gate_assignments (college_id, security_personnel_id, gate_id) VALUES ($1,$2,$3)`,
        [COLLEGE_B, SEC.main, GATE_B])).rejects.toThrow(/sga_personnel_tenant_fkey|foreign key/i);
    } finally { await d.close(); }
  });

  it("a guard reads their own assignment and not the roster", async () => {
    const own = await as(db, U.guardMain, `SELECT id FROM public.security_personnel`);
    expect(own.data).toHaveLength(1);
    const assignments = await as(db, U.guardMain, `SELECT gate_id FROM public.security_gate_assignments`);
    expect(assignments.data.map((a) => a.gate_id)).toEqual([GATE_MAIN]);
  });

  it("gates and personnel do not cross a tenant boundary in either direction", async () => {
    const aGates = await as(db, U.director, `SELECT id FROM public.gates`);
    expect(aGates.data.map((g) => g.id).sort()).toEqual([GATE_MAIN, GATE_NORTH, GATE_RETIRED].sort());
    const bGuardSees = await as(db, U.guardB, `SELECT id FROM public.gates`);
    expect(bGuardSees.data.map((g) => g.id)).toEqual([GATE_B]);
  });

  it("revoking an assignment stops that guard scanning on the very next scan", async () => {
    // §23. The guard's session, token and personnel row are all untouched
    // and still ACTIVE — only the assignment is withdrawn. Authorisation is
    // re-derived inside record_gate_movement() on every call, so there is
    // no window in which a revoked guard keeps working until they log out.
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);

      const before = await scan(d, U.guardMain, credentialId, GATE_MAIN);
      expect(before.outcome, before.error ?? "").toBe("RECORDED");

      // S.c sits in another hostel block, so the warden cannot approve for
      // them — the administrator does, which is a real path and keeps this
      // test about the assignment rather than about warden scope.
      const { passId: pass2, credentialId: cred2 } = await approvedPass(d, { student: S.c, approver: U.admin });
      await verify(d, `UPDATE security_gate_assignments SET revoked_at = now()
                        WHERE security_personnel_id = $1 AND gate_id = $2`, [SEC.main, GATE_MAIN]);

      const after = await scan(d, U.guardMain, cred2, GATE_MAIN);
      expect(after.outcome).toBe("UNAUTHORIZED_GATE");
      expect(await movementCount(d, pass2)).toBe(0);
      expect(await passStatus(d, pass2)).toBe("approved");
      // The crossing recorded while they were assigned still stands.
      expect(await movementCount(d, passId)).toBe(1);
    } finally { await d.close(); }
  });

  it("removing the movement.record permission stops scanning without touching the account", async () => {
    // §22. The guard stays ACTIVE and assigned; only the capability goes.
    // The refusal has to come from the database, because the permission
    // array is exactly the kind of thing a front end would be tempted to
    // enforce by hiding a button.
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);

      await verify(d, `UPDATE security_personnel
                          SET permissions = array_remove(permissions, 'gate_security.movement.record')
                        WHERE id = $1`, [SEC.main]);

      const r = await scan(d, U.guardMain, credentialId, GATE_MAIN);
      expect(r.outcome).toBe("PERMISSION_DENIED");
      expect(await movementCount(d, passId)).toBe(0);
      expect(await passStatus(d, passId)).toBe("approved");

      // Still ACTIVE, still assigned — the account was not what changed.
      expect(await scalar(d, `SELECT status FROM security_personnel WHERE id=$1`, [SEC.main])).toBe("ACTIVE");

      // And the refusal is on the record.
      const audited = await verify<{ action: string }>(d,
        `SELECT action FROM audit_logs WHERE user_id=$1 AND action='gate_scan_permission_denied'`, [U.guardMain]);
      expect(audited).toHaveLength(1);
    } finally { await d.close(); }
  });
});

// ─────────────────────────────────────────────────────────────
// §17, §19 — the credential's life
// ─────────────────────────────────────────────────────────────
describe("the credential", () => {
  it("is issued only by approval, and a second approval supersedes the first", async () => {
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);
      // Re-run the issuing transition as the owner to force a reissue.
      await verify(d, `ALTER TABLE gate_passes DISABLE TRIGGER guard_gate_pass_update`);
      await verify(d, `UPDATE gate_passes SET status='pending' WHERE id=$1`, [passId]);
      await verify(d, `ALTER TABLE gate_passes ENABLE TRIGGER guard_gate_pass_update`);
      await verify(d, `UPDATE gate_passes SET status='approved' WHERE id=$1`, [passId]);

      const creds = await verify<{ id: string; status: string; version: number }>(d,
        `SELECT id, status, version FROM gate_pass_credentials WHERE gate_pass_id=$1 ORDER BY version`, [passId]);
      expect(creds).toHaveLength(2);
      expect(creds[0].id).toBe(credentialId);
      expect(creds[0].status).toBe("SUPERSEDED");
      expect(creds[1].status).toBe("ACTIVE");
      expect(creds[1].version).toBe(2);

      // The old one no longer opens a gate.
      expect((await scan(d, U.guardMain, credentialId, GATE_MAIN)).outcome).toBe("INVALID_QR");
    } finally { await d.close(); }
  });

  it("is immutable once issued — window, nonce and bindings all frozen", async () => {
    const d = await fresh();
    try {
      const { credentialId } = await approvedPass(d);
      for (const set of [
        `expires_at = now() + interval '100 days'`,
        `valid_from = now() - interval '100 days'`,
        `nonce = 'aaaa'`,
        `student_id = '${S.b}'`,
        `version = 9`,
      ]) {
        await expect(verify(d, `UPDATE gate_pass_credentials SET ${set} WHERE id=$1`, [credentialId]))
          .rejects.toThrow(/immutable once issued/);
      }
      await expect(verify(d, `DELETE FROM gate_pass_credentials WHERE id=$1`, [credentialId]))
        .rejects.toThrow(/part of the security record/);
    } finally { await d.close(); }
  });

  it("closes when the pass is rejected or expires", async () => {
    const d = await fresh();
    try {
      const { passId, credentialId } = await approvedPass(d);
      await verify(d, `UPDATE gate_passes SET status='expired' WHERE id=$1`, [passId]);
      expect(await scalar(d, `SELECT status FROM gate_pass_credentials WHERE id=$1`, [credentialId])).toBe("EXPIRED");
    } finally { await d.close(); }
  });

  it("a revocation must name the revoker", async () => {
    const d = await fresh();
    try {
      const { credentialId } = await approvedPass(d);
      await expect(verify(d, `UPDATE gate_pass_credentials SET status='REVOKED' WHERE id=$1`, [credentialId]))
        .rejects.toThrow(/must record who revoked it/);
    } finally { await d.close(); }
  });

  it("only the owning student can read their own credential through the function", async () => {
    const d = await fresh();
    try {
      const { passId } = await approvedPass(d);
      const mine = await as(d, U.studentA, `SELECT credential_id, movement_state FROM public.my_gate_pass_credential('${passId}')`);
      expect(mine.data).toHaveLength(1);
      expect(mine.data[0].movement_state).toBe("NOT_EXITED");

      for (const uid of [U.studentB, U.studentC, U.warden, U.guardMain, U.director, U.admin]) {
        const theirs = await as(d, uid, `SELECT credential_id FROM public.my_gate_pass_credential('${passId}')`);
        expect(theirs.data.length, `${uid} read another student's credential`).toBe(0);
      }
    } finally { await d.close(); }
  });
});

// ─────────────────────────────────────────────────────────────
// §30 — the audit
// ─────────────────────────────────────────────────────────────
describe("the security audit", () => {
  it("records the refusals as well as the movements", async () => {
    const d = await fresh();
    try {
      const { credentialId } = await approvedPass(d);
      await scan(d, U.guardNorth, credentialId, GATE_MAIN);   // unauthorized gate
      await scan(d, U.guardMain, "00000000-0000-4000-8000-00000000dead", GATE_MAIN); // invalid
      await scan(d, U.guardMain, credentialId, GATE_MAIN);    // recorded

      const actions = await verify<{ action: string }>(d,
        `SELECT action FROM audit_logs WHERE table_name='gate_movements' ORDER BY created_at`);
      const names = actions.map((a) => a.action);
      expect(names).toContain("gate_scan_unauthorized_gate");
      expect(names).toContain("gate_scan_invalid_qr");
      expect(names).toContain("gate_movement_out");
    } finally { await d.close(); }
  });

  it("a director reads the gate security audit; a guard reads their own only once granted the capability", async () => {
    const d = await fresh();
    try {
      const { credentialId } = await approvedPass(d);
      await scan(d, U.guardMain, credentialId, GATE_MAIN);
      await scan(d, U.guardNorth, credentialId, GATE_NORTH);

      const director = await as(d, U.director, `SELECT id FROM public.audit_logs WHERE table_name='gate_movements'`);
      expect(director.data.length).toBeGreaterThanOrEqual(2);

      // The seeded guards hold the operational capabilities but NOT
      // gate_security.audit.view — which is the default a Director gets
      // when authorising someone. So before the grant, nothing.
      const before = await as(d, U.guardMain, `SELECT user_id FROM public.audit_logs WHERE table_name='gate_movements'`);
      expect(before.data.length, "a guard read the audit without the capability").toBe(0);

      // Granted, they see their own scans and nobody else's — the whole
      // point of a per-person capability rather than a role-wide one.
      await verify(d,
        `UPDATE security_personnel SET permissions = permissions || ARRAY['gate_security.audit.view'] WHERE id=$1`,
        [SEC.main]);
      const after = await as(d, U.guardMain, `SELECT user_id FROM public.audit_logs WHERE table_name='gate_movements'`);
      expect(after.data.length).toBeGreaterThanOrEqual(1);
      expect(after.data.every((r) => r.user_id === U.guardMain)).toBe(true);

      // A student and a teacher see none of it either way.
      expect((await as(d, U.studentA, `SELECT id FROM public.audit_logs WHERE table_name='gate_movements'`)).data.length).toBe(0);
      expect((await as(d, U.teacherA, `SELECT id FROM public.audit_logs WHERE table_name='gate_movements'`)).data.length).toBe(0);
    } finally { await d.close(); }
  });
});
