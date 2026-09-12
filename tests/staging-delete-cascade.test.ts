import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { stagingDb, as, verify, scalar, U, S, OFF, DEPT_CSE, COURSE_DS, COLLEGE_A } from "./staging/harness";

/**
 * §32 — delete / archive cascade audit.
 *
 * Migration 045 made department and course deletion RESTRICT wherever
 * academic history hangs off them. This suite maps what a DELETE reaches
 * from every entity an admin can delete through RLS, and pins that a
 * record with history cannot be removed — by the admin through the API or
 * by the console — while a record without history still can.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

let db: PGlite;
beforeAll(async () => { db = await stagingDb(); });
afterAll(async () => { await db?.close(); });

const fresh = () => stagingDb();

describe("what a delete reaches", () => {
  it("maps every ON DELETE CASCADE that lands on a table holding academic, financial or hostel history", async () => {
    const rows = await verify<{ child: string; col: string; parent: string }>(db, `
      SELECT ch.relname child, a.attname col, pa.relname parent
      FROM pg_constraint con
      JOIN pg_class ch ON ch.oid=con.conrelid JOIN pg_class pa ON pa.oid=con.confrelid
      JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype='f' AND con.confdeltype='c' AND ch.relnamespace='public'::regnamespace
        AND pa.relname <> 'colleges'
        AND ch.relname IN ('attendance','marks','course_enrollments','payments','fees','refund_requests',
                           'gate_passes','hostel_allocations','attendance_correction_requests',
                           'substitution_assignments','placement_applications','scholarships','financial_disputes',
                           'leave_requests','audit_logs')
      ORDER BY 1,2`);
    // Pinned so a future migration that adds a cascade into history is a
    // visible diff, not a silent widening. Tenant-scoped cascades from
    // `colleges` are excluded on purpose (045: deleting a tenant removes it).
    expect(rows.map((r) => `${r.child}.${r.col} -> ${r.parent}`)).toEqual([
      "attendance_correction_requests.attendance_id -> attendance",
      "attendance_correction_requests.student_id -> students",
      "financial_disputes.student_id -> students",
      "gate_passes.student_id -> students",
      "hostel_allocations.student_id -> students",
      // DOCUMENTED (register): deleting a FEE cascades through payments (003's
      // key, mirrored by 7i's composite) and on into refund_requests — the
      // ledger for that fee goes with it. finance holds DELETE on fees. Whether
      // fees/payments should ever be deletable rather than cancelled is a
      // product decision; it is pinned here so it cannot widen unnoticed.
      "payments.fee_id -> fees",
      "placement_applications.drive_id -> placement_drives",
      "placement_applications.drive_id -> placement_drives",
      "placement_applications.student_id -> students",
      "refund_requests.payment_id -> payments",
      "refund_requests.payment_id -> payments",
      "refund_requests.student_id -> students",
      "scholarships.student_id -> students",
      "substitution_assignments.leave_request_id -> leave_requests",
    ]);
  });
});

describe("a record with history cannot be deleted", () => {
  it("a department with courses, a course with offerings, an offering with attendance — all RESTRICT", async () => {
    for (const [sql, who] of [
      [`DELETE FROM public.departments WHERE id='${DEPT_CSE}'`, U.admin],
      [`DELETE FROM public.courses WHERE id='${COURSE_DS}'`, U.admin],
      [`DELETE FROM public.course_offerings WHERE id='${OFF.dsA3}'`, U.admin],
    ] as const) {
      const r = await as(db, who, sql);
      expect(r.ok, sql).toBe(false);
      expect(r.error, sql).toMatch(/violates foreign key|update or delete on table/);
    }
    expect(await scalar(db, `SELECT count(*)::int FROM course_offerings WHERE id=$1`, [OFF.dsA3])).toBe(1);
  });

  it("a student with attendance cannot be deleted through their profile — the cascade stops at the first RESTRICT", async () => {
    const d = await fresh();
    try {
      // Student F is the one with attendance rows in the dataset.
      expect(await scalar(d, `SELECT count(*)::int FROM attendance WHERE student_id=$1`, [S.f]).then(Number)).toBeGreaterThan(0);
      const r = await as(d, U.admin, `DELETE FROM public.profiles WHERE id='${U.studentF}'`);
      expect(r.ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM profiles WHERE id=$1`, [U.studentF])).toBe(1);
      expect(await scalar(d, `SELECT count(*)::int FROM students WHERE id=$1`, [S.f])).toBe(1);
      await expect(verify(d, `DELETE FROM students WHERE id=$1`, [S.f])).rejects.toThrow(/violates (RESTRICT setting of )?foreign key/);
    } finally { await d.close(); }
  });

  it("a student with only a decided gate pass cannot be deleted either — §7m's delete guard fires through the cascade", async () => {
    const d = await fresh();
    try {
      // A student with no academic or financial history, but one rejected pass.
      const p = await verify<{ id: string }>(d, `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (gen_random_uuid(), 'ghost@qa.test', jsonb_build_object('full_name','QA Ghost','college_id',$1::text)) RETURNING id`, [COLLEGE_A]);
      await verify(d, `UPDATE profiles SET role='student', status='active' WHERE id=$1`, [p[0].id]);
      const s = await verify<{ id: string }>(d, `INSERT INTO students (college_id, user_id, department_id, enrollment_number, batch_year, semester) VALUES ($1,$2,$3,'QA-GHOST',2026,1) RETURNING id`, [COLLEGE_A, p[0].id, DEPT_CSE]);
      await verify(d, `INSERT INTO gate_passes (college_id, student_id, destination, exit_time, return_time, status, approved_by, approved_at) VALUES ($1,$2,'x',now(),now(),'rejected',$3,now())`, [COLLEGE_A, s[0].id, U.warden]);
      await expect(verify(d, `DELETE FROM students WHERE id=$1`, [s[0].id])).rejects.toThrow(/cannot be deleted/);
      expect(await scalar(d, `SELECT count(*)::int FROM students WHERE id=$1`, [s[0].id])).toBe(1);
    } finally { await d.close(); }
  });

  it("a student with NO history can be removed, and nothing else goes with them", async () => {
    const d = await fresh();
    try {
      const p = await verify<{ id: string }>(d, `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (gen_random_uuid(), 'blank@qa.test', jsonb_build_object('full_name','QA Blank','college_id',$1::text)) RETURNING id`, [COLLEGE_A]);
      await verify(d, `UPDATE profiles SET role='student', status='active' WHERE id=$1`, [p[0].id]);
      const s = await verify<{ id: string }>(d, `INSERT INTO students (college_id, user_id, department_id, enrollment_number, batch_year, semester) VALUES ($1,$2,$3,'QA-BLANK',2026,1) RETURNING id`, [COLLEGE_A, p[0].id, DEPT_CSE]);
      const before = await verify<{ t: string; n: number }>(d, `SELECT 'attendance' t, count(*)::int n FROM attendance UNION ALL SELECT 'payments', count(*)::int FROM payments UNION ALL SELECT 'gate_passes', count(*)::int FROM gate_passes ORDER BY 1`);
      const r = await as(d, U.admin, `DELETE FROM public.profiles WHERE id='${p[0].id}' RETURNING id`);
      expect(r.rows, r.error ?? "").toBe(1);
      expect(await scalar(d, `SELECT count(*)::int FROM students WHERE id=$1`, [s[0].id])).toBe(0);
      expect(await verify(d, `SELECT 'attendance' t, count(*)::int n FROM attendance UNION ALL SELECT 'payments', count(*)::int FROM payments UNION ALL SELECT 'gate_passes', count(*)::int FROM gate_passes ORDER BY 1`)).toEqual(before);
    } finally { await d.close(); }
  });

  it("DOCUMENTED: a payment can still be deleted by finance, and the ledger reverses it (§7i) — whether ledger rows should ever be deletable is a register item", async () => {
    const d = await fresh();
    try {
      const pay = await as(d, U.finance, `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status, processed_by) VALUES ('${COLLEGE_A}','00000014-0000-4000-8000-000000000001','${S.a}',1000,'cash','cleared',auth.uid()) RETURNING id`);
      const after = await scalar(d, `SELECT paid_amount::numeric FROM fees WHERE id='00000014-0000-4000-8000-000000000001'`).then(Number);
      expect((await as(d, U.finance, `DELETE FROM public.payments WHERE id='${pay.data[0].id}' RETURNING id`)).rows).toBe(1);
      expect(await scalar(d, `SELECT paid_amount::numeric FROM fees WHERE id='00000014-0000-4000-8000-000000000001'`).then(Number)).toBe(after - 1000);
    } finally { await d.close(); }
  });
});
