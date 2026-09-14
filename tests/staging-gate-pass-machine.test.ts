import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { stagingDb, as, verify, U, S, PASS_A, COLLEGE_A } from "./staging/harness";

/**
 * Gate pass state machine, enforced by the database (047 §7m, narrowed by
 * 050 §16b).
 *
 * The application's actions already implement exactly this machine
 * (warden/gatepasses/actions.ts: pending -> approved|rejected, and — until
 * 050 — approved -> active on exit, active -> returned on return). What
 * they could not do was stop the same warden from reaching the table
 * directly through PostgREST and skipping, reopening, replaying or
 * rewriting a pass. A gate pass is the record of who is outside the hostel
 * and on whose authority; that record must not be editable into a
 * different history.
 *
 * WHAT CHANGED IN 050, AND WHY THESE TESTS READ DIFFERENTLY NOW
 *
 * 047 left one policy on gate_passes, FOR ALL, so every refusal above came
 * from the TRIGGER and arrived as a raised error. 050 splits that policy:
 * a warden may decide a pending pass and nothing else, and the two MOVEMENT
 * transitions are granted to no role at all — they happen only inside
 * record_gate_movement() / record_manual_gate_movement(), which write the
 * ledger row in the same transaction.
 *
 * So a movement attempted directly is now refused by RLS rather than by the
 * trigger, and RLS refuses an UPDATE the quiet way: zero rows, no error.
 * Every such assertion below therefore checks the ROW COUNT and then reads
 * the row back — checking `ok` alone would pass against a database that let
 * the write through.
 *
 * The trigger has not been weakened. It is still the only thing standing
 * behind service_role and the console, and the tests that go through
 * `verify` (owner, RLS bypassed) still prove that.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

let db: PGlite;
beforeAll(async () => { db = await stagingDb(); });
afterAll(async () => { await db?.close(); });

const fresh = () => stagingDb();
const pass = (d: PGlite, id: string) =>
  verify<Record<string, unknown>>(d, `SELECT status, approved_by, approved_at, actual_exit, actual_return, student_id, destination, exit_time FROM gate_passes WHERE id=$1`, [id]).then((r) => r[0]);

/** A pending pass for Student A, owned by the test that creates it. */
async function newPending(d: PGlite): Promise<string> {
  const r = await as(d, U.studentA,
    `INSERT INTO public.gate_passes (college_id, student_id, destination, reason, exit_time, return_time)
       VALUES ('${COLLEGE_A}','${S.a}','Home','x',now()+interval '1 day',now()+interval '2 days') RETURNING id`);
  expect(r.ok, r.error ?? "").toBe(true);
  return r.data[0].id as string;
}

describe("the decision is the warden's", () => {
  it("pending -> approved (by self), and the credential is issued by the transition itself", async () => {
    const d = await fresh();
    try {
      const id = await newPending(d);
      const approve = await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${id}' AND status='pending' RETURNING id`);
      expect(approve.rows, approve.error ?? "").toBe(1);
      const p = await pass(d, id);
      expect(p.status).toBe("approved");
      expect(p.approved_by).toBe(U.warden);

      // 050 §10: no Server Action issued this. The approval did.
      const creds = await verify<{ status: string; nonce: string }>(d,
        `SELECT status, nonce FROM gate_pass_credentials WHERE gate_pass_id=$1`, [id]);
      expect(creds).toHaveLength(1);
      expect(creds[0].status).toBe("ACTIVE");
      expect(creds[0].nonce).toMatch(/^[0-9a-f]{64}$/);
    } finally { await d.close(); }
  });

  it("a pass that was never approved has no credential", async () => {
    const d = await fresh();
    try {
      const id = await newPending(d);
      await as(d, U.warden, `UPDATE public.gate_passes SET status='rejected', approved_by=auth.uid(), approved_at=now() WHERE id='${id}'`);
      expect(await verify(d, `SELECT 1 FROM gate_pass_credentials WHERE gate_pass_id=$1`, [id])).toHaveLength(0);
    } finally { await d.close(); }
  });

  it("pending -> rejected is terminal", async () => {
    const d = await fresh();
    try {
      const id = await newPending(d);
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET status='rejected', approved_by=auth.uid(), approved_at=now() WHERE id='${id}' RETURNING id`)).rows).toBe(1);
      // Refused by RLS now (USING requires status='pending'), so: zero rows,
      // and the row is unchanged.
      const reopen = await as(d, U.warden, `UPDATE public.gate_passes SET status='approved' WHERE id='${id}' RETURNING id`);
      expect(reopen.rows, "a rejected pass was reopened").toBe(0);
      expect((await pass(d, id)).status).toBe("rejected");
    } finally { await d.close(); }
  });

  it("a warden may still correct a pending request, and may not touch it after deciding", async () => {
    const d = await fresh();
    try {
      const id = await newPending(d);
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET destination='Home (corrected)' WHERE id='${id}' RETURNING id`)).rows).toBe(1);
      await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${id}'`);
      for (const set of [`destination='Elsewhere'`, `exit_time=now()+interval '30 days'`, `return_time=now()+interval '31 days'`]) {
        const r = await as(d, U.warden, `UPDATE public.gate_passes SET ${set} WHERE id='${id}' RETURNING id`);
        expect(r.rows, `${set} accepted after approval`).toBe(0);
      }
      expect((await pass(d, id)).destination).toBe("Home (corrected)");
    } finally { await d.close(); }
  });

  it("the app's double-approval race resolves to exactly one approver at the database too", async () => {
    const d = await fresh();
    try {
      const id = await newPending(d);
      const first = await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${id}' AND status='pending' RETURNING id`);
      const second = await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${id}' AND status='pending' RETURNING id`);
      expect(first.rows).toBe(1);
      expect(second.rows).toBe(0);
    } finally { await d.close(); }
  });
});

describe("the movement is nobody's to write directly", () => {
  it("a warden cannot move an approved pass to active, or an active one to returned", async () => {
    const d = await fresh();
    try {
      const id = await newPending(d);
      await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${id}'`);

      const exit = await as(d, U.warden, `UPDATE public.gate_passes SET status='active', actual_exit=now() WHERE id='${id}' AND status='approved' RETURNING id`);
      expect(exit.rows, "a warden wrote an exit directly").toBe(0);
      expect((await pass(d, id)).status).toBe("approved");
      expect((await pass(d, id)).actual_exit).toBeNull();

      // And with a time of their own choosing — the §28 attack.
      const forged = await as(d, U.warden, `UPDATE public.gate_passes SET status='active', actual_exit='2020-01-01T03:00:00Z' WHERE id='${id}' RETURNING id`);
      expect(forged.rows, "a warden backdated an exit").toBe(0);
      expect(await verify(d, `SELECT 1 FROM gate_movements WHERE gate_pass_id=$1`, [id])).toHaveLength(0);
    } finally { await d.close(); }
  });

  it("neither can an admin", async () => {
    const d = await fresh();
    try {
      const id = await newPending(d);
      await as(d, U.admin, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${id}'`);
      const r = await as(d, U.admin, `UPDATE public.gate_passes SET status='active', actual_exit=now() WHERE id='${id}' RETURNING id`);
      expect(r.rows, "an admin wrote an exit directly").toBe(0);
      expect((await pass(d, id)).status).toBe("approved");
    } finally { await d.close(); }
  });

  it("nor can a gate security operator, who has no policy on gate_passes at all", async () => {
    const d = await fresh();
    try {
      const id = await newPending(d);
      await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${id}'`);
      expect((await as(d, U.guardMain, `SELECT id FROM public.gate_passes WHERE id='${id}'`)).data).toHaveLength(0);
      expect((await as(d, U.guardMain, `UPDATE public.gate_passes SET status='active', actual_exit=now() WHERE id='${id}' RETURNING id`)).rows).toBe(0);
    } finally { await d.close(); }
  });

  it("the trigger still holds behind RLS, for the console and service_role", async () => {
    const d = await fresh();
    try {
      const id = await newPending(d);
      await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${id}'`);
      // Owner session: RLS does not apply, so what refuses here is 047 §7m.
      await expect(verify(d, `UPDATE gate_passes SET status='returned', actual_return=now() WHERE id=$1`, [id]))
        .rejects.toThrow(/may not move from approved to returned/);
      await expect(verify(d, `UPDATE gate_passes SET status='active' WHERE id=$1`, [id]))
        .rejects.toThrow(/exit stamps actual_exit and nothing else/);
    } finally { await d.close(); }
  });
});

describe("direct manipulation is refused", () => {
  it("status skipping: pending -> active and pending -> returned", async () => {
    const id = await newPending(db);
    for (const to of ["active", "returned"]) {
      const r = await as(db, U.warden, `UPDATE public.gate_passes SET status='${to}', actual_exit=now(), actual_return=now() WHERE id='${id}' RETURNING id`);
      expect(r.rows, `pending -> ${to} accepted`).toBe(0);
    }
    expect((await pass(db, id)).status).toBe("pending");
    // Behind RLS the trigger names the same refusal.
    await expect(verify(db, `UPDATE gate_passes SET status='returned', actual_return=now() WHERE id=$1`, [id]))
      .rejects.toThrow(/may not move from pending to/);
  });

  it("reopening: approved -> pending is refused", async () => {
    const d = await fresh();
    try {
      const id = await newPending(d);
      await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${id}'`);
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET status='pending', approved_by=NULL, approved_at=NULL WHERE id='${id}' RETURNING id`)).rows).toBe(0);
      expect((await pass(d, id)).status).toBe("approved");
      await expect(verify(d, `UPDATE gate_passes SET status='pending', approved_by=NULL, approved_at=NULL WHERE id=$1`, [id]))
        .rejects.toThrow(/may not move from approved to pending/);
    } finally { await d.close(); }
  });

  it("forged approver: approved_by must be the acting user", async () => {
    const id = await newPending(db);
    const r = await as(db, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by='${U.wardenB}', approved_at=now() WHERE id='${id}'`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/approved_by must be the approver/);
    const noStamp = await as(db, U.warden, `UPDATE public.gate_passes SET status='approved' WHERE id='${id}'`);
    expect(noStamp.ok, "approval without approver accepted").toBe(false);
    expect((await pass(db, id)).status).toBe("pending");
  });

  it("wrong student: student_id and college_id are immutable", async () => {
    const id = await newPending(db);
    const r = await as(db, U.warden, `UPDATE public.gate_passes SET student_id='${S.b}' WHERE id='${id}'`);
    expect(r.ok).toBe(false);
    expect((await pass(db, id)).student_id).toBe(S.a);
    await expect(verify(db, `UPDATE gate_passes SET college_id='00000001-0000-4000-8000-000000000002' WHERE id=$1`, [id])).rejects.toThrow(/immutable/);
  });

  it("exit and return stamps belong to their transitions only", async () => {
    const d = await fresh();
    try {
      const id = await newPending(d);
      await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${id}'`);
      // Stamping a movement time without a transition: RLS lets the row
      // through (status stays 'approved'… no — USING requires 'pending'),
      // so this is refused before the trigger is consulted. Both layers are
      // asserted: zero rows through RLS, and the trigger's own message when
      // RLS is out of the way.
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET actual_exit=now() WHERE id='${id}' RETURNING id`)).rows).toBe(0);
      await expect(verify(d, `UPDATE gate_passes SET actual_exit=now() WHERE id=$1`, [id]))
        .rejects.toThrow(/stamps only change with their transition/);
      expect((await pass(d, id)).actual_exit).toBeNull();
    } finally { await d.close(); }
  });

  it("history cannot be deleted: only a pending pass can be removed", async () => {
    const d = await fresh();
    try {
      const decided = await newPending(d);
      await as(d, U.warden, `UPDATE public.gate_passes SET status='rejected', approved_by=auth.uid(), approved_at=now() WHERE id='${decided}'`);
      const del = await as(d, U.warden, `DELETE FROM public.gate_passes WHERE id='${decided}'`);
      expect(del.ok).toBe(false);
      expect(del.error).toMatch(/cannot be deleted/);
      expect((await pass(d, decided)).status).toBe("rejected");
      // and the console is held to the same rule
      await expect(verify(d, `DELETE FROM gate_passes WHERE id=$1`, [decided])).rejects.toThrow(/cannot be deleted/);

      // PASS_A is the dataset's pending pass: removable, by design
      expect((await as(d, U.warden, `DELETE FROM public.gate_passes WHERE id='${PASS_A}' RETURNING id`)).rows).toBe(1);
    } finally { await d.close(); }
  });

  it("the student still cannot touch a pass after filing it", async () => {
    const id = await newPending(db);
    for (const sql of [
      `UPDATE public.gate_passes SET status='approved', approved_by='${U.warden}', approved_at=now() WHERE id='${id}'`,
      `UPDATE public.gate_passes SET destination='Elsewhere' WHERE id='${id}'`,
      `DELETE FROM public.gate_passes WHERE id='${id}'`,
    ]) {
      expect((await as(db, U.studentA, sql)).rows, sql).toBe(0);
    }
    expect((await pass(db, id)).status).toBe("pending");
  });

  it("nobody may INSERT a pass on a student's behalf", async () => {
    // 050 §16b drops the staff INSERT path: a gate pass is a request, and a
    // request is the student's to make.
    for (const uid of [U.warden, U.admin]) {
      const r = await as(db, uid,
        `INSERT INTO public.gate_passes (college_id, student_id, destination, reason, exit_time, return_time, status)
           VALUES ('${COLLEGE_A}','${S.a}','Forged','x',now(),now()+interval '1 day','approved') RETURNING id`);
      expect(r.ok, `${uid} inserted a gate pass`).toBe(false);
    }
  });
});
