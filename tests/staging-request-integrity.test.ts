import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { stagingDb, as, verify, scalar, U, S, OFF, COLLEGE_A, COLLEGE_B, FEE_A, FEE_C, ALLOC_A, ALLOC_C, ROOM_A102, DATE } from "./staging/harness";

/**
 * 047 §7n — a request enters as a request.
 *
 * G1 (a student minting an approved gate pass) was one instance of a shape
 * that every requester-side INSERT policy in the schema shared: the policy
 * pinned WHO was asking and nothing else. This suite drives each of the
 * nine tables as the requester and checks, by reading back as the owner,
 * that a forged status, a forged reviewer, a foreign college, or a request
 * against someone else's record does not land — and that the honest
 * request still does.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

let db: PGlite;
beforeAll(async () => { db = await stagingDb(); });
afterAll(async () => { await db?.close(); });

const count = (d: PGlite, sql: string, params: unknown[] = []) => scalar(d, sql, params).then(Number);

describe("leave_requests", () => {
  const ins = (extra: string) => as(db, U.teacherA,
    `INSERT INTO public.leave_requests (college_id, requested_by, leave_type, start_date, end_date, reason${extra ? "," + extra.split("=")[0].trim() : ""})
       VALUES ('${COLLEGE_A}', auth.uid(), 'casual', '2026-10-01', '2026-10-02', 'x'${extra ? "," + extra.split("=")[1] : ""})`);

  it("an honest request lands pending", async () => {
    const r = await ins("");
    expect(r.ok, r.error ?? "").toBe(true);
  });

  it("cannot be filed already approved, nor with an approver, nor in another college", async () => {
    expect((await ins("status='approved'")).ok).toBe(false);
    expect((await ins(`approved_by='${U.hodCse}'`)).ok).toBe(false);
    const foreign = await as(db, U.teacherA,
      `INSERT INTO public.leave_requests (college_id, requested_by, leave_type, start_date, end_date, reason) VALUES ('${COLLEGE_B}', auth.uid(), 'casual', '2026-10-01', '2026-10-02', 'x')`);
    expect(foreign.ok).toBe(false);
    expect(await count(db, `SELECT count(*)::int FROM leave_requests WHERE requested_by=$1 AND reason='x' AND (status<>'pending' OR approved_by IS NOT NULL OR college_id<>$2)`, [U.teacherA, COLLEGE_A])).toBe(0);
  });
});

describe("refund_requests", () => {
  let ownPayment: string;
  let othersPayment: string;
  beforeAll(async () => {
    // Finance records a cleared payment for Student A and one for Student C.
    const pay = (fee: string, student: string) => as(db, U.finance,
      `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status, processed_by)
         VALUES ('${COLLEGE_A}','${fee}','${student}',500,'cash','cleared',auth.uid()) RETURNING id`);
    ownPayment = (await pay(FEE_A, S.a)).data[0].id as string;
    othersPayment = (await pay(FEE_C, S.c)).data[0].id as string;
  });

  const req = (payment: string, extra = "") => as(db, U.studentA,
    `INSERT INTO public.refund_requests (college_id, student_id, payment_id, amount, reason${extra ? "," + extra.split("=")[0].trim() : ""})
       VALUES ('${COLLEGE_A}','${S.a}','${payment}',100,'x'${extra ? "," + extra.split("=")[1] : ""}) RETURNING id`);

  it("a student can request a refund of their own payment", async () => {
    const r = await req(ownPayment);
    expect(r.ok, r.error ?? "").toBe(true);
  });

  it("cannot request a refund of ANOTHER student's payment", async () => {
    const r = await req(othersPayment);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/refund_requests_payment_student_fkey/);
    expect(await count(db, `SELECT count(*)::int FROM refund_requests WHERE payment_id=$1`, [othersPayment])).toBe(0);
  });

  it("cannot be filed pre-approved or pre-reviewed", async () => {
    expect((await req(ownPayment, "status='approved'")).ok).toBe(false);
    expect((await req(ownPayment, `reviewed_by='${U.finance}'`)).ok).toBe(false);
    expect(await count(db, `SELECT count(*)::int FROM refund_requests WHERE student_id=$1 AND status<>'pending'`, [S.a])).toBe(0);
  });
});

describe("financial_disputes", () => {
  it("a dispute names the student's own fee, and starts submitted", async () => {
    const own = await as(db, U.studentA, `INSERT INTO public.financial_disputes (college_id, student_id, fee_id, description) VALUES ('${COLLEGE_A}','${S.a}','${FEE_A}','x') RETURNING id`);
    expect(own.ok, own.error ?? "").toBe(true);
    const foreign = await as(db, U.studentA, `INSERT INTO public.financial_disputes (college_id, student_id, fee_id, description) VALUES ('${COLLEGE_A}','${S.a}','${FEE_C}','x')`);
    expect(foreign.error).toMatch(/financial_disputes_fee_student_fkey/);
    const resolved = await as(db, U.studentA, `INSERT INTO public.financial_disputes (college_id, student_id, fee_id, description, status, resolved_by) VALUES ('${COLLEGE_A}','${S.a}','${FEE_A}','x','resolved','${U.finance}')`);
    expect(resolved.ok).toBe(false);
    expect(await count(db, `SELECT count(*)::int FROM financial_disputes WHERE student_id=$1 AND (status<>'submitted' OR fee_id=$2)`, [S.a, FEE_C])).toBe(0);
  });
});

describe("room_transfer_requests", () => {
  it("names the student's own allocation, starts pending, and carries no new allocation", async () => {
    const own = await as(db, U.studentA, `INSERT INTO public.room_transfer_requests (college_id, student_id, current_allocation_id, new_room_id, reason) VALUES ('${COLLEGE_A}','${S.a}','${ALLOC_A}','${ROOM_A102}','x') RETURNING id`);
    expect(own.ok, own.error ?? "").toBe(true);
    const foreign = await as(db, U.studentA, `INSERT INTO public.room_transfer_requests (college_id, student_id, current_allocation_id, new_room_id, reason) VALUES ('${COLLEGE_A}','${S.a}','${ALLOC_C}','${ROOM_A102}','x')`);
    expect(foreign.error).toMatch(/room_transfer_requests_current_allocation_student_fkey/);
    const approved = await as(db, U.studentA, `INSERT INTO public.room_transfer_requests (college_id, student_id, current_allocation_id, new_room_id, reason, status, new_allocation_id) VALUES ('${COLLEGE_A}','${S.a}','${ALLOC_A}','${ROOM_A102}','x','approved','${ALLOC_A}')`);
    expect(approved.ok).toBe(false);
    expect(await count(db, `SELECT count(*)::int FROM room_transfer_requests WHERE student_id=$1 AND (status<>'pending' OR new_allocation_id IS NOT NULL OR current_allocation_id=$2)`, [S.a, ALLOC_C])).toBe(0);
  });
});

describe("placement_applications", () => {
  let driveA: string;
  let driveB: string;
  beforeAll(async () => {
    const mk = async (college: string, creator: string) => {
      const c = await verify<{ id: string }>(db, `INSERT INTO companies (college_id, name, created_by) VALUES ($1,'QA Co ${college.slice(-1)}',$2) RETURNING id`, [college, creator]);
      const d = await verify<{ id: string }>(db, `INSERT INTO placement_drives (college_id, company_id, job_role, application_deadline, created_by) VALUES ($1,$2,'SDE',now()+interval '30 days',$3) RETURNING id`, [college, c[0].id, creator]);
      return d[0].id;
    };
    driveA = await mk(COLLEGE_A, U.admin);
    driveB = await mk(COLLEGE_B, U.bHod);
  });

  it("applies as 'applied', to a drive in the student's own college", async () => {
    const selected = await as(db, U.studentA, `INSERT INTO public.placement_applications (college_id, drive_id, student_id, status) VALUES ('${COLLEGE_A}','${driveA}','${S.a}','selected')`);
    expect(selected.ok).toBe(false);
    const foreign = await as(db, U.studentA, `INSERT INTO public.placement_applications (college_id, drive_id, student_id) VALUES ('${COLLEGE_A}','${driveB}','${S.a}')`);
    expect(foreign.error).toMatch(/placement_applications_drive_tenant_fkey/);
    const ok = await as(db, U.studentA, `INSERT INTO public.placement_applications (college_id, drive_id, student_id) VALUES ('${COLLEGE_A}','${driveA}','${S.a}') RETURNING status`);
    expect(ok.ok, ok.error ?? "").toBe(true);
    expect(ok.data[0].status).toBe("applied");
    expect(await count(db, `SELECT count(*)::int FROM placement_applications WHERE student_id=$1 AND status<>'applied'`, [S.a])).toBe(0);
  });
});

describe("complaints, decisions, attendance corrections", () => {
  it("a complaint opens 'open' and unassigned", async () => {
    const r = await as(db, U.studentA, `INSERT INTO public.complaints (college_id, submitted_by, category, title, description, status, assigned_to) VALUES ('${COLLEGE_A}', auth.uid(), 'hostel', 'x', 'x', 'resolved', '${U.warden}')`);
    expect(r.ok).toBe(false);
    const ok = await as(db, U.studentA, `INSERT INTO public.complaints (college_id, submitted_by, category, title, description) VALUES ('${COLLEGE_A}', auth.uid(), 'hostel', 'x', 'x') RETURNING status`);
    expect(ok.ok, ok.error ?? "").toBe(true);
    expect(ok.data[0].status).toBe("open");
  });

  it("a decision is submitted pending and undecided", async () => {
    const r = await as(db, U.hodCse, `INSERT INTO public.decisions (college_id, requested_by, category, title, description, urgency, status, decided_by) VALUES ('${COLLEGE_A}', auth.uid(), 'other', 'x', 'x', 'medium', 'approved', '${U.director}')`);
    expect(r.ok).toBe(false);
    const ok = await as(db, U.hodCse, `INSERT INTO public.decisions (college_id, requested_by, category, title, description, urgency) VALUES ('${COLLEGE_A}', auth.uid(), 'other', 'x', 'x', 'medium') RETURNING status`);
    expect(ok.ok, ok.error ?? "").toBe(true);
    expect(ok.data[0].status).toBe("pending");
  });

  it("an attendance correction is filed pending and unreviewed", async () => {
    const att = await verify<{ id: string }>(db, `SELECT id FROM attendance WHERE offering_id=$1 AND student_id=$2 AND date=$3`, [OFF.dsA3, S.a, DATE]);
    if (!att.length) return; // dataset has no row here; covered by staging-security-f1-f2
    const r = await as(db, U.teacherA,
      `INSERT INTO public.attendance_correction_requests (college_id, attendance_id, offering_id, student_id, date, current_status, requested_status, reason, submitted_by, status, reviewed_by)
         VALUES ('${COLLEGE_A}','${att[0].id}','${OFF.dsA3}','${S.a}','${DATE}','absent','present','x',auth.uid(),'approved','${U.hodCse}')`);
    expect(r.ok).toBe(false);
    expect(await count(db, `SELECT count(*)::int FROM attendance_correction_requests WHERE submitted_by=$1 AND status<>'pending'`, [U.teacherA])).toBe(0);
  });
});

describe("audit_logs", () => {
  it("cannot be written in another user's name", async () => {
    const forged = await as(db, U.studentA, `INSERT INTO public.audit_logs (college_id, user_id, action, table_name, record_id) VALUES ('${COLLEGE_A}','${U.admin}','Deleted every fee','fees','x')`);
    expect(forged.ok).toBe(false);
    expect(forged.error).toMatch(/row-level security/);
    expect(await count(db, `SELECT count(*)::int FROM audit_logs WHERE action='Deleted every fee'`)).toBe(0);
  });

  it("can be written in one's own name, and never changed or removed afterwards", async () => {
    const own = await as(db, U.admin, `INSERT INTO public.audit_logs (college_id, user_id, action, table_name, record_id) VALUES ('${COLLEGE_A}', auth.uid(), 'QA action','x','x') RETURNING id`);
    expect(own.ok, own.error ?? "").toBe(true);
    const id = own.data[0].id as string;
    expect((await as(db, U.admin, `UPDATE public.audit_logs SET action='rewritten' WHERE id='${id}'`)).rows).toBe(0);
    expect((await as(db, U.admin, `DELETE FROM public.audit_logs WHERE id='${id}'`)).rows).toBe(0);
    expect(await scalar(db, `SELECT action FROM audit_logs WHERE id=$1`, [id])).toBe("QA action");
  });
});
