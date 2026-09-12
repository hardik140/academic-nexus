import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { stagingDb, as, verify, U, S, PASS_A, COLLEGE_A } from "./staging/harness";

/**
 * Gate pass state machine, enforced by the database (047 §7m).
 *
 * The application's actions already implement exactly this machine
 * (warden/gatepasses/actions.ts: pending -> approved|rejected,
 * approved -> active on exit, active -> returned on return, each a
 * compare-and-swap). What they could not do was stop the same warden from
 * reaching the table directly through PostgREST and skipping, reopening,
 * replaying or rewriting a pass. A gate pass is the record of who is
 * outside the hostel and on whose authority; that record must not be
 * editable into a different history.
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

describe("the legal path works for the warden", () => {
  it("pending -> approved (by self) -> active (with exit) -> returned (with return)", async () => {
    const d = await fresh();
    try {
      const id = await newPending(d);
      const approve = await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${id}' AND status='pending' RETURNING id`);
      expect(approve.rows, approve.error ?? "").toBe(1);
      const exit = await as(d, U.warden, `UPDATE public.gate_passes SET status='active', actual_exit=now() WHERE id='${id}' AND status='approved' RETURNING id`);
      expect(exit.rows, exit.error ?? "").toBe(1);
      const back = await as(d, U.warden, `UPDATE public.gate_passes SET status='returned', actual_return=now() WHERE id='${id}' AND status='active' RETURNING id`);
      expect(back.rows, back.error ?? "").toBe(1);
      const p = await pass(d, id);
      expect(p.status).toBe("returned");
      expect(p.approved_by).toBe(U.warden);
      expect(p.actual_exit).not.toBeNull();
      expect(p.actual_return).not.toBeNull();
    } finally { await d.close(); }
  });

  it("pending -> rejected is terminal", async () => {
    const d = await fresh();
    try {
      const id = await newPending(d);
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET status='rejected', approved_by=auth.uid(), approved_at=now() WHERE id='${id}' RETURNING id`)).rows).toBe(1);
      const r = await as(d, U.warden, `UPDATE public.gate_passes SET status='approved' WHERE id='${id}'`);
      expect(r.ok).toBe(false);
      expect((await pass(d, id)).status).toBe("rejected");
    } finally { await d.close(); }
  });
});

describe("direct manipulation is refused", () => {
  it("status skipping: pending -> active, pending -> returned, approved -> returned", async () => {
    const id = await newPending(db);
    for (const to of ["active", "returned"]) {
      const r = await as(db, U.warden, `UPDATE public.gate_passes SET status='${to}', actual_exit=now(), actual_return=now() WHERE id='${id}'`);
      expect(r.ok, `pending -> ${to} accepted`).toBe(false);
      expect(r.error).toMatch(/may not move from pending to/);
    }
    await as(db, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${id}'`);
    const r = await as(db, U.warden, `UPDATE public.gate_passes SET status='returned', actual_return=now() WHERE id='${id}'`);
    expect(r.ok, "return without exit accepted").toBe(false);
    expect((await pass(db, id)).status).toBe("approved");
  });

  it("reopening: approved -> pending, returned -> active (replay), rejected -> approved", async () => {
    const d = await fresh();
    try {
      const id = await newPending(d);
      await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${id}'`);
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET status='pending', approved_by=NULL, approved_at=NULL WHERE id='${id}'`)).ok).toBe(false);
      await as(d, U.warden, `UPDATE public.gate_passes SET status='active', actual_exit=now() WHERE id='${id}'`);
      await as(d, U.warden, `UPDATE public.gate_passes SET status='returned', actual_return=now() WHERE id='${id}'`);
      const replay = await as(d, U.warden, `UPDATE public.gate_passes SET status='active', actual_return=NULL WHERE id='${id}'`);
      expect(replay.ok, "returned -> active accepted").toBe(false);
      expect((await pass(d, id)).status).toBe("returned");
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

  it("the request as approved is the request that was approved: destination and times freeze after pending", async () => {
    const d = await fresh();
    try {
      const id = await newPending(d);
      // still pending: the warden may correct a typo for the student
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET destination='Home (corrected)' WHERE id='${id}' RETURNING id`)).rows).toBe(1);
      await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${id}'`);
      for (const set of [`destination='Elsewhere'`, `exit_time=now()+interval '30 days'`, `return_time=now()+interval '31 days'`]) {
        const r = await as(d, U.warden, `UPDATE public.gate_passes SET ${set} WHERE id='${id}'`);
        expect(r.ok, `${set} accepted after approval`).toBe(false);
      }
      expect((await pass(d, id)).destination).toBe("Home (corrected)");
    } finally { await d.close(); }
  });

  it("exit and return stamps belong to their transitions only", async () => {
    const d = await fresh();
    try {
      const id = await newPending(d);
      await as(d, U.warden, `UPDATE public.gate_passes SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${id}'`);
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET status='active' WHERE id='${id}'`)).ok, "active without actual_exit").toBe(false);
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET actual_exit=now() WHERE id='${id}'`)).ok, "actual_exit stamped while approved").toBe(false);
      await as(d, U.warden, `UPDATE public.gate_passes SET status='active', actual_exit=now() WHERE id='${id}'`);
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET status='returned' WHERE id='${id}'`)).ok, "returned without actual_return").toBe(false);
      expect((await as(d, U.warden, `UPDATE public.gate_passes SET actual_exit=now()-interval '5 days' WHERE id='${id}'`)).ok, "actual_exit rewritten while active").toBe(false);
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

  it("the app's double-approval race resolves to exactly one approver at the database too", async () => {
    // Both wardens are in scope? No — only Warden A heads Block A. The DB
    // race that matters is two sessions of the SAME warden: the second
    // statement's status predicate matches nothing.
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
