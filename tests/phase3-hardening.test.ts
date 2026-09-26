import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  stagingDb, as, scalar,
  U, S, OFF, COLLEGE_A, COLLEGE_B, SEM_PAST, FEE_A, ROOM_A102,
} from "./staging/harness";

/**
 * Permanent regression suite for the Phase-3 hardening (migration 051).
 *
 * Every case pairs the original Phase-2 attack (must be DENIED now) with the
 * legitimate operation it must not have broken (must PASS). The action under
 * test always runs through `as()` (an authenticated, RLS-bound session);
 * `verify()` (owner, RLS-bypassed) only reads the postcondition.
 */
vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const CRS_DBMS = "00000009-0000-4000-8000-000000000002";
const SEC_CSE_A5 = "00000008-0000-4000-8000-000000000005";
const MARK_HIST = "0000000c-0000-4000-8000-000000000001";     // marks row in the closed semester
const ATT_HIST = "0000000b-0000-4000-8000-000000000002";      // attendance row in the closed semester

// A denied write either raised (ok:false) or affected no row (rows:0).
const denied = (r: { ok: boolean; rows: number; data: unknown[] }) =>
  !r.ok || r.rows === 0 || r.data.length === 0;

let db: PGlite;
beforeAll(async () => { db = await stagingDb(); });
afterAll(async () => { await db?.close(); });

describe("P1-1 cross-tenant security instructions", () => {
  it("College-B guard cannot read College-A instructions", async () => {
    const r = await as(db, U.guardB, `SELECT id FROM public.security_instructions WHERE college_id='${COLLEGE_A}'`);
    expect(r.data.length).toBe(0);
  });
  it("College-A guard still reads its own instructions", async () => {
    const r = await as(db, U.guardMain, `SELECT id FROM public.security_instructions WHERE college_id='${COLLEGE_A}'`);
    expect(r.data.length).toBeGreaterThan(0);
  });
});

describe("P1-2 finance integrity", () => {
  const payCleared = `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method) VALUES ('${COLLEGE_A}','${FEE_A}','${S.a}',3000,'cash');`;
  it("cannot delete a fee that has a payment", async () => {
    await db.exec(payCleared);
    const r = await as(db, U.finance, `DELETE FROM public.fees WHERE id='${FEE_A}'`);
    expect(denied(r)).toBe(true);
    expect(await scalar(db, `SELECT count(*)::int FROM public.fees WHERE id='${FEE_A}'`)).toBe(1);
    await db.exec(`DELETE FROM public.payments WHERE fee_id='${FEE_A}'; UPDATE public.fees SET paid_amount=0, status='pending' WHERE id='${FEE_A}';`);
  });
  it("cannot delete a cleared payment", async () => {
    await db.exec(payCleared);
    const r = await as(db, U.finance, `DELETE FROM public.payments WHERE fee_id='${FEE_A}'`);
    expect(denied(r)).toBe(true);
    await db.exec(`DELETE FROM public.payments WHERE fee_id='${FEE_A}'; UPDATE public.fees SET paid_amount=0, status='pending' WHERE id='${FEE_A}';`);
  });
  it("cannot set paid_amount by hand", async () => {
    const r = await as(db, U.finance, `UPDATE public.fees SET paid_amount=9999 WHERE id='${FEE_A}'`);
    expect(denied(r)).toBe(true);
  });
  it("records a valid payment and the ledger drives paid_amount (legit)", async () => {
    const r = await as(db, U.finance, `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method) VALUES ('${COLLEGE_A}','${FEE_A}','${S.a}',4000,'cash') RETURNING id`);
    expect(r.ok).toBe(true);
    expect(Number(await scalar(db, `SELECT paid_amount FROM public.fees WHERE id='${FEE_A}'`))).toBe(4000);
    await db.exec(`DELETE FROM public.payments WHERE fee_id='${FEE_A}'; UPDATE public.fees SET paid_amount=0, status='pending' WHERE id='${FEE_A}';`);
  });
});

describe("P2-3 closed semester is immutable for academic children", () => {
  it("teacher cannot insert marks in a closed semester", async () => {
    const r = await as(db, U.teacherA, `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks) VALUES ('${COLLEGE_A}','${OFF.historical}','${S.f}','midterm',100,50)`);
    expect(denied(r)).toBe(true);
  });
  it("teacher cannot edit historical marks in a closed semester", async () => {
    const r = await as(db, U.teacherA, `UPDATE public.marks SET obtained_marks=99 WHERE id='${MARK_HIST}'`);
    expect(denied(r)).toBe(true);
  });
  it("admin cannot delete historical attendance in a closed semester", async () => {
    const r = await as(db, U.admin, `DELETE FROM public.attendance WHERE id='${ATT_HIST}'`);
    expect(denied(r)).toBe(true);
  });
  it("admin cannot create an offering in a closed semester", async () => {
    const r = await as(db, U.admin, `INSERT INTO public.course_offerings (college_id, semester_id, course_id, section_id, instructor_id, status) VALUES ('${COLLEGE_A}','${SEM_PAST}','${CRS_DBMS}','${SEC_CSE_A5}','${U.teacherA}','active')`);
    expect(denied(r)).toBe(true);
  });
  it("teacher still writes marks in the active semester (legit)", async () => {
    const r = await as(db, U.teacherA, `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks) VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.a}','viva',100,70) RETURNING id`);
    expect(r.ok).toBe(true);
    await db.exec(`DELETE FROM public.marks WHERE offering_id='${OFF.dsA3}' AND student_id='${S.a}' AND exam_type='viva';`);
  });
});

describe("P2-4 pending accounts have no tenant access", () => {
  const PEND = "0c0c0c0c-0000-4000-8000-00000000cccc";
  beforeAll(async () => {
    await db.exec(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${PEND}','pend@x.test','{"college_id":"${COLLEGE_A}"}');
                   UPDATE public.profiles SET college_id='${COLLEGE_A}' WHERE id='${PEND}';`);
  });
  it("a pending account reads no college profiles", async () => {
    const r = await as(db, PEND, `SELECT id FROM public.profiles WHERE college_id='${COLLEGE_A}' AND id<>'${PEND}'`);
    expect(r.data.length).toBe(0);
  });
  it("a pending account reads no offerings", async () => {
    const r = await as(db, PEND, `SELECT id FROM public.course_offerings WHERE college_id='${COLLEGE_A}'`);
    expect(r.data.length).toBe(0);
  });
  it("an active member still reads its own college (legit)", async () => {
    const r = await as(db, U.teacherA, `SELECT id FROM public.courses WHERE college_id='${COLLEGE_A}'`);
    expect(r.data.length).toBeGreaterThan(0);
  });
});

describe("P2-5 cross-tenant child inserts are rejected", () => {
  it("finance cannot create a fee for another college's student", async () => {
    const r = await as(db, U.finance, `INSERT INTO public.fees (college_id, student_id, type, amount, due_date, status, paid_amount) VALUES ('${COLLEGE_A}','${S.bStudent}','tuition',500,'2026-12-01','pending',0)`);
    expect(denied(r)).toBe(true);
  });
  it("finance creates a fee for its own student (legit)", async () => {
    const r = await as(db, U.finance, `INSERT INTO public.fees (college_id, student_id, type, amount, due_date, status, paid_amount) VALUES ('${COLLEGE_A}','${S.b}','tuition',500,'2026-12-01','pending',0) RETURNING id`);
    expect(r.ok).toBe(true);
    await db.exec(`DELETE FROM public.fees WHERE student_id='${S.b}' AND amount=500;`);
  });
  it("warden cannot allocate another college's student", async () => {
    const r = await as(db, U.warden, `INSERT INTO public.hostel_allocations (college_id, student_id, room_id, status) VALUES ('${COLLEGE_A}','${S.bStudent}','${ROOM_A102}','active')`);
    expect(denied(r)).toBe(true);
  });
  it("admin cannot file an invitation into another college", async () => {
    const r = await as(db, U.admin, `INSERT INTO public.invitations (college_id, email, role, invited_by) VALUES ('${COLLEGE_B}','x@x.test','director','${U.admin}')`);
    expect(denied(r)).toBe(true);
  });
});

describe("P2-6 database CHECK constraints", () => {
  const cases: [string, string][] = [
    ["marks obtained>max", `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks) VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.a}','final',100,150)`],
    ["marks negative", `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks) VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.a}','final',100,-5)`],
    ["fee negative amount", `INSERT INTO public.fees (college_id, student_id, type, amount, due_date, status, paid_amount) VALUES ('${COLLEGE_A}','${S.a}','x',-100,'2026-10-01','pending',0)`],
    ["fee paid>amount", `INSERT INTO public.fees (college_id, student_id, type, amount, due_date, status, paid_amount) VALUES ('${COLLEGE_A}','${S.a}','x',100,'2026-10-01','partial',500)`],
    ["gate pass return<exit", `INSERT INTO public.gate_passes (college_id, student_id, destination, reason, exit_time, return_time) VALUES ('${COLLEGE_A}','${S.a}','x','y',now()+interval '2 days',now()+interval '1 day')`],
    ["hostel occupancy>capacity", `UPDATE public.hostel_rooms SET occupancy=99 WHERE id='${ROOM_A102}'`],
  ];
  for (const [name, sql] of cases) {
    it(`rejects: ${name}`, async () => {
      // superuser path — proves the DB itself refuses, not just RLS.
      let ok = true;
      try { await db.exec(sql); } catch { ok = false; }
      expect(ok).toBe(false);
    });
  }
  it("accepts a valid mark (legit)", async () => {
    const r = await as(db, U.teacherA, `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks) VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.a}','lab',100,80) RETURNING id`);
    expect(r.ok).toBe(true);
    await db.exec(`DELETE FROM public.marks WHERE offering_id='${OFF.dsA3}' AND student_id='${S.a}' AND exam_type='lab';`);
  });
});

describe("P3-7 anon cannot read the permissions catalog", () => {
  it("anon read is empty/denied", async () => {
    await db.exec("SET ROLE anon;");
    let n = -1;
    try { n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.permissions`)).rows[0].n; }
    catch { n = 0; }
    finally { await db.exec("RESET ROLE;"); }
    expect(n).toBe(0);
  });
  it("authenticated still reads it (legit)", async () => {
    const r = await as(db, U.teacherA, `SELECT id FROM public.permissions`);
    expect(r.data.length).toBeGreaterThan(0);
  });
});

describe("P3-8 enrolment binding for attendance & marks", () => {
  it("teacher cannot mark a non-enrolled same-college student", async () => {
    const r = await as(db, U.teacherA, `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks) VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.c}','final',100,50)`);
    expect(denied(r)).toBe(true);
  });
  it("teacher marks an enrolled student (legit)", async () => {
    const r = await as(db, U.teacherA, `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks) VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.a}','project',100,60) RETURNING id`);
    expect(r.ok).toBe(true);
    await db.exec(`DELETE FROM public.marks WHERE offering_id='${OFF.dsA3}' AND student_id='${S.a}' AND exam_type='project';`);
  });
});

describe("P3-9 role editing obeys the invitation tier", () => {
  it("admin cannot promote a teacher to finance", async () => {
    const r = await as(db, U.admin, `UPDATE public.profiles SET role='finance' WHERE id='${U.teacherA}'`);
    expect(denied(r)).toBe(true);
    expect(await scalar(db, `SELECT role FROM public.profiles WHERE id='${U.teacherA}'`)).toBe("teacher");
  });
  it("admin may appoint a director (legit per tier)", async () => {
    const r = await as(db, U.admin, `UPDATE public.profiles SET role='director' WHERE id='${U.teacherA}' RETURNING id`);
    expect(r.ok).toBe(true);
    await db.exec(`UPDATE public.profiles SET role='teacher' WHERE id='${U.teacherA}';`);
  });
});

describe("P1-2 payment status is a one-way state machine", () => {
  const insertPay = (status: string) =>
    db.query<{ id: string }>(
      `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status) VALUES ('${COLLEGE_A}','${FEE_A}','${S.a}',2000,'cash','${status}') RETURNING id`
    ).then((r) => r.rows[0].id);
  const reset = () => db.exec(`DELETE FROM public.payments WHERE fee_id='${FEE_A}'; UPDATE public.fees SET paid_amount=0, status='pending' WHERE id='${FEE_A}';`);

  it("a refunded payment cannot be turned back into cleared", async () => {
    const id = await insertPay("refunded");
    const r = await as(db, U.finance, `UPDATE public.payments SET status='cleared' WHERE id='${id}'`);
    expect(denied(r)).toBe(true);
    await reset();
  });
  it("a failed payment cannot be turned into cleared", async () => {
    const id = await insertPay("failed");
    const r = await as(db, U.finance, `UPDATE public.payments SET status='cleared' WHERE id='${id}'`);
    expect(denied(r)).toBe(true);
    expect(Number(await scalar(db, `SELECT paid_amount FROM public.fees WHERE id='${FEE_A}'`))).toBe(0);
    await reset();
  });
  it("a pending payment that clears credits the fee (legit)", async () => {
    const id = await insertPay("pending");
    const r = await as(db, U.finance, `UPDATE public.payments SET status='cleared' WHERE id='${id}' RETURNING id`);
    expect(r.ok, r.error ?? "").toBe(true);
    expect(Number(await scalar(db, `SELECT paid_amount FROM public.fees WHERE id='${FEE_A}'`))).toBe(2000);
    await reset();
  });
});

describe("P3-9 regression: the super_admin row stays super_admin-only", () => {
  it("a college admin cannot suspend the super_admin", async () => {
    const r = await as(db, U.admin, `UPDATE public.profiles SET status='suspended' WHERE id='${U.superAdmin}'`);
    expect(denied(r)).toBe(true);
    expect(await scalar(db, `SELECT status FROM public.profiles WHERE id='${U.superAdmin}'`)).toBe("active");
  });
});

describe("regression: existing strong controls remain closed", () => {
  it("HOD-MECH still cannot write marks on a CSE offering", async () => {
    const r = await as(db, U.hodMech, `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks) VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.a}','final',100,50)`);
    expect(denied(r)).toBe(true);
  });
  it("a student still cannot change its own role", async () => {
    const r = await as(db, U.studentA, `UPDATE public.profiles SET role='admin' WHERE id='${U.studentA}'`);
    expect(denied(r)).toBe(true);
  });
  it("College-B HOD still cannot read College-A offerings", async () => {
    const r = await as(db, U.bHod, `SELECT id FROM public.course_offerings WHERE college_id='${COLLEGE_A}'`);
    expect(r.data.length).toBe(0);
  });
});
