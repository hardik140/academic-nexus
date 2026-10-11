import { describe, it, expect, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { mutatedFiles } from "./staging/mutate";
import { as, scalar, U, S, OFF, COLLEGE_A, DEPT_ECE } from "./staging/harness";

/**
 * Migration 055's controls are load-bearing: each is removed from the
 * migration text in turn, the whole chain is rebuilt on disposable
 * PostgreSQL, and the attack the control exists to stop is shown to
 * SUCCEED. The un-mutated outcomes (refused) are asserted in
 * tests/staging-academic-foundation.test.ts.
 *
 * A mutation whose pattern no longer matches throws (mutatedFiles), so a
 * rename can never turn one of these into a test of nothing.
 */

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const M55 = "055_academic_foundation.sql";
const SEC_CSE_A = "00000008-0000-4000-8000-000000000001";
const SEC_CSE_B = "00000008-0000-4000-8000-000000000002";
const REASON = "Agreed in the department meeting";

async function withDb(build: Promise<PGlite>, run: (d: PGlite) => Promise<void>) {
  const d = await build;
  try { await run(d); } finally { await d.close(); }
}
const mutate55 = (label: string, from: string, to: string) =>
  mutatedFiles(label, { [M55]: (sql) => sql.split(from).join(to) });

describe("055 controls are load-bearing", () => {
  it("NULL-safe In-Charge check removed: a teacher who leads no section passes the invitation preflight", async () => {
    await withDb(mutate55("incharge null check",
      "v_incharge := coalesce(public.current_class_incharge(p_section_id, v_sem.id) = auth.uid(), false);",
      "v_incharge := public.current_class_incharge(p_section_id, v_sem.id) = auth.uid();"), async (d) => {
      const r = await as(d, U.teacherB, `SELECT public.student_invitation_preflight($1, 'QA-MUT-1', 3)`, [SEC_CSE_B]);
      expect(r.ok, r.error ?? "").toBe(true);
    });
  });

  it("HOD department check removed from the placement check: another department's HOD places students in CSE", async () => {
    await withDb(mutate55("placement heads check",
      "v_heads := coalesce(v_role = 'hod' AND EXISTS (SELECT 1 FROM public.departments WHERE id = v_sec.department_id AND hod_id = auth.uid()), false);",
      "v_heads := coalesce(v_role = 'hod', false);"), async (d) => {
      const r = await as(d, U.hodEce, `SELECT public.student_invitation_preflight($1, 'QA-MUT-2', 3)`, [SEC_CSE_A]);
      expect(r.ok, r.error ?? "").toBe(true);
    });
  });

  it("can_manage_department's HOD predicate removed: another department's HOD appoints a CSE Class In-Charge", async () => {
    await withDb(mutate55("manage department predicate",
      "(public.my_operational_role() = 'hod' AND d.hod_id = auth.uid())",
      "(public.my_operational_role() = 'hod')"), async (d) => {
      const r = await as(d, U.hodEce, `SELECT public.assign_class_incharge($1, $2, $3)`, [SEC_CSE_A, U.teacherA, REASON]);
      expect(r.ok, r.error ?? "").toBe(true);
    });
  });

  it("instructor eligibility removed (decision 4): a director names themselves instructor and records attendance", async () => {
    await withDb(mutate55("instructor eligibility",
      "    IF NOT public.instructor_eligible(NEW.instructor_id, NEW.course_id) THEN",
      "    IF false AND NOT public.instructor_eligible(NEW.instructor_id, NEW.course_id) THEN"), async (d) => {
      const r = await as(d, U.director, `UPDATE public.course_offerings SET instructor_id = auth.uid() WHERE id = $1`, [OFF.dsA3]);
      expect(r.rows, r.error ?? "").toBe(1);
    });
  });

  it("closed-term instructor lock removed (defect 5): the HOD rewrites a past term's teacher", async () => {
    await withDb(mutate55("closed term instructor",
      "IF NEW.instructor_id IS DISTINCT FROM OLD.instructor_id AND v_status IN ('closed', 'reopened') THEN",
      "IF false THEN"), async (d) => {
      const r = await as(d, U.hodCse, `UPDATE public.course_offerings SET instructor_id = $1 WHERE id = $2`, [U.teacherB, OFF.historical]);
      expect(r.rows, r.error ?? "").toBe(1);
    });
  });

  it("completed-offering freeze removed (defect 4): the instructor keeps writing attendance after the term ended", async () => {
    await withDb(mutate55("completed freeze",
      "  IF v_status = 'completed' AND v_term IS DISTINCT FROM 'reopened' THEN",
      "  IF false THEN"), async (d) => {
      expect((await as(d, U.hodCse, `UPDATE public.course_offerings SET status = 'completed' WHERE id = $1`, [OFF.dsA3])).rows).toBe(1);
      const r = await as(d, U.teacherA, `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
        VALUES ($1, $2, $3, '2026-09-10', 'present', $4)`, [COLLEGE_A, OFF.dsA3, S.a, U.teacherA]);
      expect(r.ok, r.error ?? "").toBe(true);
    });
  });

  it("enrolment narrowing removed: the HOD enrols a student directly, bypassing every workflow", async () => {
    await withDb(mutate55("enrolment narrowing",
      `DROP POLICY IF EXISTS "course_enrollments_manage_staff" ON public.course_enrollments;\n`,
      "-- 047's staff policy kept by mutation\n"), async (d) => {
      const r = await as(d, U.hodCse, `INSERT INTO public.course_enrollments (college_id, student_id, offering_id) VALUES ($1, $2, $3)`,
        [COLLEGE_A, S.d, OFF.dsA3]);
      expect(r.ok, r.error ?? "").toBe(true);
    });
  });

  it("one-enrolment-per-course trigger removed: a student is enrolled in the same course twice in one term", async () => {
    await withDb(mutate55("enrolment uniqueness",
      "CREATE TRIGGER guard_enrollment_unique_course BEFORE INSERT OR UPDATE OF status, offering_id ON public.course_enrollments\n  FOR EACH ROW EXECUTE FUNCTION public.guard_enrollment_unique_course();",
      "-- guard_enrollment_unique_course removed by mutation"), async (d) => {
      const r = await as(d, U.admin, `INSERT INTO public.course_enrollments (college_id, student_id, offering_id) VALUES ($1, $2, $3)`,
        [COLLEGE_A, S.a, OFF.dsB3]);
      expect(r.ok, r.error ?? "").toBe(true);
    });
  });

  it("timetable read narrowing removed (defect 2): a student reads the whole college's timetable", async () => {
    await withDb(mutate55("timetable read",
      `DROP POLICY IF EXISTS "timetable_read" ON public.timetable_slots;\n`,
      "-- 006's timetable_read kept by mutation\n"), async (d) => {
      const r = await as(d, U.studentA, `SELECT DISTINCT offering_id FROM public.timetable_slots`);
      expect(r.data.map((x) => x.offering_id)).toContain(OFF.dsB3);
    });
  });

  it("invitee update policy kept (defect 3): the invitee rewrites their own invitation", async () => {
    await withDb(mutate55("invitee update",
      `DROP POLICY IF EXISTS "invitations_update_by_invitee" ON public.invitations;\n`,
      "-- 019's invitee update policy kept by mutation\n"), async (d) => {
      const invitee = "00000099-0000-4000-8000-0000000000f1";
      await d.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, 'mut@qa.test', jsonb_build_object('college_id', $2::text))`, [invitee, COLLEGE_A]);
      const inv = await d.query<{ id: string }>(`INSERT INTO public.invitations (college_id, email, role, invited_by, user_id) VALUES ($1, 'mut@qa.test', 'student', $2, $3) RETURNING id`,
        [COLLEGE_A, U.hodCse, invitee]);
      // While PENDING, 053's write gate already refuses the invitee anything but
      // their own profile. Once ACTIVE, 019's policy let them rewrite their
      // invitation record for good — which 055 removes.
      await d.query(`UPDATE public.profiles SET role = 'student', status = 'active' WHERE id = $1`, [invitee]);
      const r = await as(d, invitee, `UPDATE public.invitations SET department_id = $1, role = 'teacher' WHERE id = $2`, [DEPT_ECE, inv.rows[0].id]);
      expect(r.rows, r.error ?? "").toBe(1);
    });
  });

  it("history guard removed: a student's past section is rewritten", async () => {
    await withDb(mutate55("history guard",
      "CREATE TRIGGER guard_academic_history BEFORE UPDATE OR DELETE ON public.student_section_assignments\n  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_history('ended_at', 'ended_at', 'ended_semester_id', 'end_source', 'end_reason', 'ended_by');",
      "-- history guard removed by mutation"), async (d) => {
      expect((await as(d, U.hodCse, `SELECT public.assign_student_section($1, $2, $3)`, [S.a, SEC_CSE_A, REASON])).ok).toBe(true);
      await d.query(`UPDATE public.student_section_assignments SET section_id = $1 WHERE student_id = $2`, [SEC_CSE_B, S.a]);
      expect(await scalar(d, `SELECT section_id FROM public.student_section_assignments WHERE student_id = $1`, [S.a])).toBe(SEC_CSE_B);
    });
  });

  it("section clash removed from the timetable guard: one section is booked into two classes at once", async () => {
    await withDb(mutate55("section clash",
      "WHERE o.semester_id = v_off.semester_id AND o.section_id = v_off.section_id AND o.status <> 'cancelled'",
      "WHERE false AND o.semester_id = v_off.semester_id AND o.section_id = v_off.section_id AND o.status <> 'cancelled'"), async (d) => {
      // CSE-A already has OS on Wednesday 09:00-10:00 (fixture).
      const r = await as(d, U.hodCse, `SELECT public.create_timetable_slot($1, 3, '09:30'::time, '10:30'::time, 'QA-R555')`, [OFF.dbmsA3]);
      expect(r.ok, r.error ?? "").toBe(true);
    });
  });
});
