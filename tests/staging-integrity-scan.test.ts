import { describe, it, expect, vi } from "vitest";

import { stagingDb, as, verify, scalar, U, S, OFF, COLLEGE_A, FEE_A, SEM_3, ROOM_A101, ROOM_A102 } from "./staging/harness";
import { scanIntegrity, integrityViolations, scanAdvisory } from "./staging/integrity";

/**
 * §36 — the integrity scanner: run on pristine data, run after a day of
 * legitimate operations across every module, and then proven load-bearing
 * by injecting each class of violation as the console (bypassing RLS) and
 * checking the scan names it.
 */

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const fresh = () => stagingDb();

describe("pristine dataset", () => {
  it("has zero violations across every check, and the scan covers every tenant key", async () => {
    const d = await fresh();
    try {
      const all = await scanIntegrity(d);
      expect(all.length).toBeGreaterThan(90); // ~35 invariants + ~60 single-column tenant keys
      expect(await integrityViolations(d)).toEqual([]);
    } finally { await d.close(); }
  });
});

describe("after a day of legitimate operations", () => {
  it("still has zero violations", async () => {
    const d = await fresh();
    try {
      // Academic: attendance and a mark by the instructor, a correction filed and approved by the HOD.
      expect((await as(d, U.teacherA, `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by) VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.a}','2026-09-11','absent',auth.uid()) RETURNING id`)).ok).toBe(true);
      expect((await as(d, U.teacherA, `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, obtained_marks, max_marks, entered_by) VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.a}','internal_1',18,20,auth.uid()) RETURNING id`)).ok).toBe(true);
      const att = await scalar(d, `SELECT id FROM attendance WHERE offering_id=$1 AND student_id=$2 AND date='2026-09-11'`, [OFF.dsA3, S.a]);
      const corr = await as(d, U.teacherA, `INSERT INTO public.attendance_correction_requests (college_id, attendance_id, offering_id, student_id, date, current_status, requested_status, reason, submitted_by) VALUES ('${COLLEGE_A}','${att}','${OFF.dsA3}','${S.a}','2026-09-11','absent','present','x',auth.uid()) RETURNING id`);
      expect(corr.ok, corr.error ?? "").toBe(true);
      expect((await as(d, U.hodCse, `UPDATE public.attendance_correction_requests SET status='approved', reviewed_by=auth.uid(), reviewed_at=now() WHERE id='${corr.data[0].id}' RETURNING id`)).rows).toBe(1);
      expect((await as(d, U.hodCse, `UPDATE public.attendance SET status='present' WHERE id='${att}' RETURNING id`)).rows).toBe(1);

      // Leave -> substitution.
      const leave = await as(d, U.teacherB, `INSERT INTO public.leave_requests (college_id, requested_by, leave_type, start_date, end_date, reason) VALUES ('${COLLEGE_A}', auth.uid(), 'casual', '2026-10-05', '2026-10-05', 'x') RETURNING id`);
      expect((await as(d, U.hodCse, `UPDATE public.leave_requests SET status='approved', approved_by=auth.uid(), approved_at=now() WHERE id='${leave.data[0].id}' RETURNING id`)).rows).toBe(1);
      const sub = await as(d, U.hodCse, `INSERT INTO public.substitution_assignments (college_id, leave_request_id, offering_id, original_teacher_id, date, status) VALUES ('${COLLEGE_A}','${leave.data[0].id}','${OFF.dsB3}','${U.teacherB}','2026-10-05','needed') RETURNING id`);
      expect(sub.ok, sub.error ?? "").toBe(true);
      expect((await as(d, U.hodCse, `UPDATE public.substitution_assignments SET status='assigned', substitute_teacher_id='${U.teacherC}', assigned_by=auth.uid() WHERE id='${sub.data[0].id}' RETURNING id`)).rows).toBe(1);

      // Finance: payment, partial refund, approval through the function.
      const pay = await as(d, U.finance, `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status, processed_by, transaction_ref) VALUES ('${COLLEGE_A}','${FEE_A}','${S.a}',4000,'upi','cleared',auth.uid(),'UPI-DAY-1') RETURNING id`);
      const refund = await as(d, U.studentA, `INSERT INTO public.refund_requests (college_id, student_id, payment_id, amount, reason) VALUES ('${COLLEGE_A}','${S.a}','${pay.data[0].id}',1500,'x') RETURNING id`);
      expect((await as(d, U.finance, `SELECT public.approve_refund('${refund.data[0].id}')`)).ok).toBe(true);

      // Hostel: a gate pass walked to returned; a room moved to maintenance and back.
      const pass = await as(d, U.studentA, `INSERT INTO public.gate_passes (college_id, student_id, destination, exit_time, return_time) VALUES ('${COLLEGE_A}','${S.a}','Home',now()+interval '1 hour',now()+interval '1 day') RETURNING id`);
      for (const step of [
        `status='approved', approved_by=auth.uid(), approved_at=now()`,
        `status='active', actual_exit=now()`,
        `status='returned', actual_return=now()`,
      ]) expect((await as(d, U.warden, `UPDATE public.gate_passes SET ${step} WHERE id='${pass.data[0].id}' RETURNING id`)).rows).toBe(1);
      expect((await as(d, U.warden, `UPDATE public.hostel_rooms SET status='maintenance' WHERE id='${ROOM_A102}' RETURNING id`)).rows).toBe(1);

      // Period: close the term, open the next year and term.
      expect((await as(d, U.admin, `UPDATE public.semesters SET status='closed' WHERE id='${SEM_3}' RETURNING id`)).rows).toBe(1);
      const ay = await as(d, U.admin, `INSERT INTO public.academic_years (college_id, name, start_date, end_date) VALUES ('${COLLEGE_A}','QA 2027-28','2027-06-01','2028-05-31') RETURNING id`);
      await as(d, U.admin, `UPDATE public.academic_years SET status='closed' WHERE id='00000005-0000-4000-8000-000000000001'`);
      expect((await as(d, U.admin, `UPDATE public.academic_years SET status='active' WHERE id='${ay.data[0].id}' RETURNING id`)).rows).toBe(1);
      const sem = await as(d, U.admin, `INSERT INTO public.semesters (college_id, academic_year_id, academic_year, name, sequence_no, start_date, end_date) VALUES ('${COLLEGE_A}','${ay.data[0].id}','QA 2027-28','Odd 2027',1,'2027-06-01','2027-11-30') RETURNING id`);
      expect((await as(d, U.admin, `UPDATE public.semesters SET status='active' WHERE id='${sem.data[0].id}' RETURNING id`)).rows).toBe(1);

      expect(await integrityViolations(d)).toEqual([]);
      // ADVISORY, not a violation: the closed term's offerings are still
      // 'active' — the finalisation decision on the register (D-FINAL).
      expect((await scanAdvisory(d)).map((a) => `${a.check} (${a.count})`)).toEqual(["active offering in a closed semester (5)"]);
    } finally { await d.close(); }
  });
});

describe("the scanner is load-bearing", () => {
  const inject = async (label: string, sql: string, expectCheck: RegExp) => {
    const d = await fresh();
    try {
      await verify(d, sql);
      const v = await integrityViolations(d);
      expect(v.some((x) => expectCheck.test(x)), `${label}: ${JSON.stringify(v)}`).toBe(true);
    } finally { await d.close(); }
  };

  it("names a fee whose balance no longer matches its ledger", () =>
    inject("ledger", `UPDATE fees SET paid_amount = paid_amount + 1 WHERE id='${FEE_A}'`, /disagrees with its payments/));

  it("names a department head who is not an HOD", () =>
    inject("hod role", `UPDATE departments SET hod_id='${U.teacherA}' WHERE id='00000002-0000-4000-8000-000000000001'`, /head whose profile role is not/));

  it("names a room whose occupancy counter drifted", () =>
    inject("occupancy", `UPDATE hostel_rooms SET occupancy = occupancy + 1 WHERE id='${ROOM_A101}'`, /occupancy disagrees/));

  it("names a cross-college reference the schema does not yet key", () =>
    // hostel_blocks.warden_id -> profiles carries no tenant key (follow-up
    // list); the scan is what catches it until it does.
    inject("tenant", `UPDATE hostel_blocks SET warden_id='${U.bHod}' WHERE id='00000010-0000-4000-8000-000000000001'`, /cross-college reference: hostel_blocks\.warden_id/));

  it("names attendance for an unenrolled student", () =>
    inject("enrolment", `INSERT INTO attendance (college_id, offering_id, student_id, date, status, marked_by) VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.c}','2026-09-12','present','${U.teacherA}')`, /not enrolled/));

  it("names a substitution where the substitute is the absentee", () =>
    inject("substitute", `INSERT INTO substitution_assignments (college_id, leave_request_id, offering_id, original_teacher_id, substitute_teacher_id, date, status) VALUES ('${COLLEGE_A}','0000000f-0000-4000-8000-000000000001','${OFF.dsA3}','${U.teacherA}','${U.teacherA}','2026-10-10','assigned')`, /substitute is the absent teacher/));

  it("stays silent when the injected change is legitimate", async () => {
    const d = await fresh();
    try {
      await verify(d, `UPDATE hostel_rooms SET status='maintenance' WHERE id='${ROOM_A102}'`);
      expect(await integrityViolations(d)).toEqual([]);
    } finally { await d.close(); }
  });
});

