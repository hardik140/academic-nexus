import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { stagingDb, as, verify, scalar, U, OFF, COLLEGE_A, COLLEGE_B, SEM_3, SEM_5, SEM_PAST, DATE } from "./staging/harness";

/**
 * Academic period lifecycle (047 §7k) and tenant consistency across the
 * academic structure (047 §7l), proven against the real migration chain.
 *
 * Every refusal is verified by reading the row back as the owner — an
 * UPDATE or DELETE that RLS filters out reports success with zero rows, so
 * `ok === true` alone proves nothing (the C3 rule).
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const SEM_1 = "00000006-0000-4000-8000-000000000001";
const SEM_B = "00000006-0000-4000-8000-00000000000b";
const AY_2026 = "00000005-0000-4000-8000-000000000001"; // active
const AY_2025 = "00000005-0000-4000-8000-000000000002"; // closed
const AY_B = "00000005-0000-4000-8000-000000000003";
const SECTION_B = "00000008-0000-4000-8000-000000000006";
const PROG_B = "00000007-0000-4000-8000-000000000004";
const DEPT_B = "00000002-0000-4000-8000-000000000004";
const COURSE_B = "00000009-0000-4000-8000-000000000006";
const S_B = "00000004-0000-4000-8000-000000000007";

let db: PGlite;
beforeAll(async () => { db = await stagingDb(); });
afterAll(async () => { await db?.close(); });

const fresh = () => stagingDb();

const semester = (d: PGlite, id: string) =>
  verify<{ status: string; is_current: boolean; name: string; academic_year_id: string; college_id: string }>(
    d, `SELECT status, is_current, name, academic_year_id, college_id FROM semesters WHERE id=$1`, [id]
  ).then((r) => r[0]);

const newYear = (d: PGlite, uid: string, name = "QA 2027-28") =>
  as(d, uid, `INSERT INTO public.academic_years (college_id, name, start_date, end_date)
              VALUES ('${COLLEGE_A}','${name}','2027-06-01','2028-05-31') RETURNING id, status`);

const newSemester = (d: PGlite, uid: string, yearId: string, extra = "") =>
  as(d, uid, `INSERT INTO public.semesters (college_id, academic_year_id, academic_year, name, sequence_no, start_date, end_date${extra ? ", status" : ""})
              VALUES ('${COLLEGE_A}','${yearId}','x','QA New Term',1,'2027-06-01','2027-11-30'${extra ? `, '${extra}'` : ""}) RETURNING id, status, is_current`);

// ══════════════════════════════════════════════════════════════
// Creation
// ══════════════════════════════════════════════════════════════

describe("creating periods", () => {
  it("admin creates an academic year, and it enters as planned", async () => {
    const r = await newYear(db, U.admin);
    expect(r.ok, r.error ?? "").toBe(true);
    expect(r.data[0].status).toBe("planned");
    expect(await scalar(db, `SELECT status FROM academic_years WHERE id=$1`, [r.data[0].id])).toBe("planned");
  });

  it("admin cannot insert a year that is already active", async () => {
    const r = await as(db, U.admin,
      `INSERT INTO public.academic_years (college_id, name, start_date, end_date, status) VALUES ('${COLLEGE_A}','QA Sneak','2028-06-01','2029-05-31','active')`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/row-level security/);
    expect(await scalar(db, `SELECT count(*)::int FROM academic_years WHERE name='QA Sneak'`)).toBe(0);
  });

  it("admin creates a semester inside an active year; it enters planned with is_current mirrored false", async () => {
    const r = await newSemester(db, U.admin, AY_2026);
    expect(r.ok, r.error ?? "").toBe(true);
    expect(r.data[0].status).toBe("planned");
    expect(r.data[0].is_current).toBe(false);
  });

  it("director may create too — the same grant as academic_years and programmes", async () => {
    const y = await newYear(db, U.director, "QA Director Year");
    expect(y.ok, y.error ?? "").toBe(true);
    const s = await newSemester(db, U.director, y.data[0].id as string);
    expect(s.ok, s.error ?? "").toBe(true);
  });

  it("a semester cannot be inserted as active, nor without a year", async () => {
    const active = await newSemester(db, U.admin, AY_2026, "active");
    expect(active.ok).toBe(false);
    expect(active.error).toMatch(/row-level security/);

    const orphan = await as(db, U.admin,
      `INSERT INTO public.semesters (college_id, academic_year, name, start_date, end_date) VALUES ('${COLLEGE_A}','x','QA Orphan','2027-01-01','2027-05-01')`);
    expect(orphan.ok).toBe(false);
    expect(await scalar(db, `SELECT count(*)::int FROM semesters WHERE name='QA Orphan'`)).toBe(0);
  });

  it.each([
    ["student", U.studentA], ["teacher", U.teacherA], ["hod", U.hodCse],
    ["finance", U.finance], ["warden", U.warden], ["super_admin", U.superAdmin],
  ])("%s cannot create, transition or delete a semester", async (_role, uid) => {
    const ins = await newSemester(db, uid, AY_2026);
    expect(ins.ok).toBe(false);
    const upd = await as(db, uid, `UPDATE public.semesters SET status='active' WHERE id='${SEM_1}'`);
    expect(upd.rows).toBe(0);
    const del = await as(db, uid, `DELETE FROM public.semesters WHERE id='${SEM_1}'`);
    expect(del.rows).toBe(0);
    expect((await semester(db, SEM_1)).status).toBe("planned");
  });

  it("college A's admin cannot create in, transition, or delete college B's periods", async () => {
    const ins = await as(db, U.admin,
      `INSERT INTO public.semesters (college_id, academic_year_id, academic_year, name, start_date, end_date) VALUES ('${COLLEGE_B}','${AY_B}','x','QA Intruder','2027-01-01','2027-05-01')`);
    expect(ins.ok).toBe(false);
    expect(await scalar(db, `SELECT count(*)::int FROM semesters WHERE name='QA Intruder'`)).toBe(0);
    const upd = await as(db, U.admin, `UPDATE public.semesters SET status='closed' WHERE id='${SEM_B}'`);
    expect(upd.rows).toBe(0);
    expect((await semester(db, SEM_B)).status).toBe("active");
    const del = await as(db, U.admin, `DELETE FROM public.semesters WHERE id='${SEM_B}'`);
    expect(del.rows).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Transitions
// ══════════════════════════════════════════════════════════════

describe("transitions", () => {
  it("a second active semester is refused by the index; the first is untouched", async () => {
    const d = await fresh();
    try {
      const r = await as(d, U.admin, `UPDATE public.semesters SET status='active' WHERE id='${SEM_1}'`);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/idx_semesters_one_active/);
      expect((await semester(d, SEM_1)).status).toBe("planned");
      expect((await semester(d, SEM_3)).status).toBe("active");
    } finally { await d.close(); }
  });

  it("close the active term, then activate the next — is_current follows status both ways", async () => {
    const d = await fresh();
    try {
      const close = await as(d, U.admin, `UPDATE public.semesters SET status='closed' WHERE id='${SEM_3}' AND status='active' RETURNING id`);
      expect(close.rows).toBe(1);
      let s3 = await semester(d, SEM_3);
      expect(s3.status).toBe("closed");
      expect(s3.is_current).toBe(false);

      const open = await as(d, U.admin, `UPDATE public.semesters SET status='active' WHERE id='${SEM_1}' AND status='planned' RETURNING id`);
      expect(open.rows).toBe(1);
      const s1 = await semester(d, SEM_1);
      expect(s1.status).toBe("active");
      expect(s1.is_current).toBe(true);

      s3 = await semester(d, SEM_3);
      expect(s3.status).toBe("closed");
    } finally { await d.close(); }
  });

  it("a semester cannot be activated while its academic year is only planned", async () => {
    const d = await fresh();
    try {
      const y = await newYear(d, U.admin);
      const s = await newSemester(d, U.admin, y.data[0].id as string);
      // free the one-active slot so the only thing standing is the year rule
      await verify(d, `UPDATE semesters SET status='closed' WHERE id=$1`, [SEM_3]);
      const r = await as(d, U.admin, `UPDATE public.semesters SET status='active' WHERE id='${s.data[0].id}'`);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/academic year must be active/);
      expect((await semester(d, s.data[0].id as string)).status).toBe("planned");

      // activate the year, and the same statement now succeeds
      const ay = await as(d, U.admin, `UPDATE public.academic_years SET status='closed' WHERE id='${AY_2026}' RETURNING id`);
      expect(ay.rows).toBe(1);
      expect((await as(d, U.admin, `UPDATE public.academic_years SET status='active' WHERE id='${y.data[0].id}' RETURNING id`)).rows).toBe(1);
      expect((await as(d, U.admin, `UPDATE public.semesters SET status='active' WHERE id='${s.data[0].id}' RETURNING id`)).rows).toBe(1);
      expect((await semester(d, s.data[0].id as string)).status).toBe("active");
    } finally { await d.close(); }
  });

  it("planned -> closed is not a transition", async () => {
    const r = await as(db, U.admin, `UPDATE public.semesters SET status='closed' WHERE id='${SEM_5}'`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/may not move from planned to closed/);
    expect((await semester(db, SEM_5)).status).toBe("planned");
  });

  it("a closed semester cannot be reopened, renamed or re-parented — by admin (silent) or by the console (loud)", async () => {
    const before = await semester(db, SEM_PAST);
    for (const set of [`status='active'`, `status='planned'`, `name='Rewritten'`, `academic_year_id='${AY_2026}'`]) {
      const r = await as(db, U.admin, `UPDATE public.semesters SET ${set} WHERE id='${SEM_PAST}'`);
      expect(r.rows, set).toBe(0);
    }
    for (const set of [`status='active'`, `name='Rewritten'`]) {
      await expect(verify(db, `UPDATE semesters SET ${set} WHERE id=$1`, [SEM_PAST]), set).rejects.toThrow(/closed period is immutable/);
    }
    expect(await semester(db, SEM_PAST)).toEqual(before);
  });

  it("college_id is immutable; academic_year_id is immutable once active", async () => {
    const move = await as(db, U.admin, `UPDATE public.semesters SET college_id='${COLLEGE_B}' WHERE id='${SEM_1}'`);
    expect(move.ok).toBe(false);
    expect((await semester(db, SEM_1)).college_id).toBe(COLLEGE_A);
    await expect(verify(db, `UPDATE semesters SET college_id=$2 WHERE id=$1`, [SEM_1, COLLEGE_B])).rejects.toThrow(/college_id is immutable/);

    const reparent = await as(db, U.admin, `UPDATE public.semesters SET academic_year_id='${AY_2025}' WHERE id='${SEM_3}'`);
    expect(reparent.ok).toBe(false);
    expect(reparent.error).toMatch(/academic_year_id is immutable/);
    expect((await semester(db, SEM_3)).academic_year_id).toBe(AY_2026);
  });

  it("an academic year cannot close while a semester in it is still active", async () => {
    const d = await fresh();
    try {
      const r = await as(d, U.admin, `UPDATE public.academic_years SET status='closed' WHERE id='${AY_2026}'`);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/close the active semester/);
      expect(await scalar(d, `SELECT status FROM academic_years WHERE id=$1`, [AY_2026])).toBe("active");

      await as(d, U.admin, `UPDATE public.semesters SET status='closed' WHERE id='${SEM_3}'`);
      expect((await as(d, U.admin, `UPDATE public.academic_years SET status='closed' WHERE id='${AY_2026}' RETURNING id`)).rows).toBe(1);
      expect(await scalar(d, `SELECT status FROM academic_years WHERE id=$1`, [AY_2026])).toBe("closed");
    } finally { await d.close(); }
  });

  it("a closed academic year is immutable and cannot be deleted", async () => {
    const r = await as(db, U.admin, `UPDATE public.academic_years SET status='active' WHERE id='${AY_2025}'`);
    expect(r.rows).toBe(0);
    const del = await as(db, U.admin, `DELETE FROM public.academic_years WHERE id='${AY_2025}'`);
    expect(del.rows).toBe(0);
    expect(await scalar(db, `SELECT status FROM academic_years WHERE id=$1`, [AY_2025])).toBe("closed");
  });
});

// ══════════════════════════════════════════════════════════════
// Deletion and history
// ══════════════════════════════════════════════════════════════

describe("deletion and history", () => {
  it("a planned semester with nothing hanging off it can be deleted", async () => {
    const d = await fresh();
    try {
      const s = await newSemester(d, U.admin, AY_2026);
      const r = await as(d, U.admin, `DELETE FROM public.semesters WHERE id='${s.data[0].id}' RETURNING id`);
      expect(r.rows).toBe(1);
      expect(await scalar(d, `SELECT count(*)::int FROM semesters WHERE id=$1`, [s.data[0].id])).toBe(0);
    } finally { await d.close(); }
  });

  it("an active or closed semester cannot be deleted; a referenced planned one is held by the FK", async () => {
    for (const id of [SEM_3, SEM_PAST]) {
      const r = await as(db, U.admin, `DELETE FROM public.semesters WHERE id='${id}'`);
      expect(r.rows).toBe(0);
    }
    // SEM_5 is planned but carries offerings: RLS lets the DELETE through
    // and 046's ON DELETE RESTRICT refuses it.
    const r = await as(db, U.admin, `DELETE FROM public.semesters WHERE id='${SEM_5}'`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/violates foreign key|update or delete on table "semesters"/);
    expect(await scalar(db, `SELECT count(*)::int FROM semesters WHERE id IN ($1,$2,$3)`, [SEM_3, SEM_PAST, SEM_5])).toBe(3);
  });

  it("closing a term changes nothing underneath it: offerings, enrollments, attendance and marks are byte-identical", async () => {
    const d = await fresh();
    try {
      const snapshot = () => verify<{ t: string; n: number; h: string }>(d, `
        SELECT 'offerings' t, count(*)::int n, md5(string_agg(o::text, '|' ORDER BY o.id)) h FROM course_offerings o WHERE semester_id=$1
        UNION ALL SELECT 'enrollments', count(*)::int, md5(string_agg(e::text, '|' ORDER BY e.id)) FROM course_enrollments e JOIN course_offerings o ON o.id=e.offering_id WHERE o.semester_id=$1
        UNION ALL SELECT 'attendance', count(*)::int, md5(string_agg(a::text, '|' ORDER BY a.id)) FROM attendance a JOIN course_offerings o ON o.id=a.offering_id WHERE o.semester_id=$1
        UNION ALL SELECT 'marks', count(*)::int, md5(string_agg(m::text, '|' ORDER BY m.id)) FROM marks m JOIN course_offerings o ON o.id=m.offering_id WHERE o.semester_id=$1
        ORDER BY 1`, [SEM_3]);
      const before = await snapshot();
      expect(before.find((r) => r.t === "offerings")!.n).toBeGreaterThan(0);
      expect((await as(d, U.admin, `UPDATE public.semesters SET status='closed' WHERE id='${SEM_3}' RETURNING id`)).rows).toBe(1);
      expect(await snapshot()).toEqual(before);
    } finally { await d.close(); }
  });

  it("closing a semester freezes academic writes under it (051 P2-3)", async () => {
    // Migration 051 made a closed semester immutable for its academic
    // children: guard_closed_semester() refuses attendance/marks/enrolment/
    // offering writes once the term is closed, in the database, so a direct
    // PostgREST call cannot escape it.
    const d = await fresh();
    try {
      await verify(d, `UPDATE semesters SET status='closed' WHERE id=$1`, [SEM_3]);
      const r = await as(d, U.teacherA,
        `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
           VALUES ('${COLLEGE_A}','${OFF.dsA3}','00000004-0000-4000-8000-000000000001','${DATE}','present',auth.uid()) RETURNING id`);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/semester is closed/);
    } finally { await d.close(); }
  });
});

// ══════════════════════════════════════════════════════════════
// Tenant consistency (§7l)
// ══════════════════════════════════════════════════════════════

describe("tenant consistency across the academic structure", () => {
  it("a semester in college A cannot hang off college B's academic year", async () => {
    const r = await newSemester(db, U.admin, AY_B);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/semesters_academic_year_tenant_fkey/);
  });

  it("a section, programme or course in college A cannot reference college B's parent", async () => {
    const section = await as(db, U.admin, `INSERT INTO public.sections (college_id, programme_id, batch_year, name) VALUES ('${COLLEGE_A}','${PROG_B}',2026,'QA-X')`);
    expect(section.error).toMatch(/sections_programme_tenant_fkey/);
    const programme = await as(db, U.admin, `INSERT INTO public.programmes (college_id, department_id, name, code) VALUES ('${COLLEGE_A}','${DEPT_B}','QA-X','QA-X')`);
    expect(programme.error).toMatch(/programmes_department_tenant_fkey/);
    const course = await as(db, U.admin, `INSERT INTO public.courses (college_id, department_id, name, code, credits, semester, type) VALUES ('${COLLEGE_A}','${DEPT_B}','QA-X','QA-XX',3,1,'core')`);
    expect(course.error).toMatch(/courses_department_tenant_fkey/);
    expect(await scalar(db, `SELECT count(*)::int FROM sections WHERE name='QA-X'`)).toBe(0);
    expect(await scalar(db, `SELECT count(*)::int FROM programmes WHERE code='QA-X'`)).toBe(0);
    expect(await scalar(db, `SELECT count(*)::int FROM courses WHERE code='QA-XX'`)).toBe(0);
  });

  it("an offering in college A cannot borrow college B's semester, course, section or teacher", async () => {
    const base = (semester: string, course: string, section: string, teacher: string) =>
      as(db, U.admin, `INSERT INTO public.course_offerings (college_id, semester_id, course_id, section_id, instructor_id, status)
        VALUES ('${COLLEGE_A}','${semester}','${course}','${section}','${teacher}','planned')`);
    const OWN_SEM = SEM_5, OWN_COURSE = "00000009-0000-4000-8000-000000000003", OWN_SECTION = "00000008-0000-4000-8000-000000000004";
    expect((await base(SEM_B, OWN_COURSE, OWN_SECTION, U.teacherA)).error).toMatch(/course_offerings_semester_tenant_fkey/);
    // 055's eligibility trigger may refuse first (a college A teacher is not
    // eligible for a college B course); either way the row does not land.
    expect((await base(OWN_SEM, COURSE_B, OWN_SECTION, U.teacherA)).error).toMatch(/course_offerings_course_tenant_fkey|not authorized to teach/);
    expect((await base(OWN_SEM, OWN_COURSE, SECTION_B, U.teacherA)).error).toMatch(/course_offerings_section_tenant_fkey/);
    // 055's instructor eligibility trigger (decision 4) now refuses a
    // foreign teacher before the key is checked; the tenant key is still the
    // backstop for every caller the trigger exempts (the service role), so it
    // is proven there.
    expect((await base(OWN_SEM, OWN_COURSE, OWN_SECTION, U.bTeacher)).error).toMatch(/course_offerings_instructor_tenant_fkey|not authorized to teach/);
    let ownerError: string | null = null;
    try {
      await db.query(`INSERT INTO public.course_offerings (college_id, semester_id, course_id, section_id, instructor_id, status)
        VALUES ('${COLLEGE_A}','${OWN_SEM}','${OWN_COURSE}','${OWN_SECTION}','${U.bTeacher}','planned')`);
    } catch (e) { ownerError = (e as Error).message; }
    expect(ownerError).toMatch(/course_offerings_instructor_tenant_fkey/);
    // and the all-own-college form of the same statement is accepted
    const ok = await base(OWN_SEM, OWN_COURSE, OWN_SECTION, U.teacherA);
    expect(ok.ok, ok.error ?? "").toBe(true);
  });

  it("a college B student cannot be enrolled in, marked present in, or graded in a college A offering", async () => {
    const enrol = await as(db, U.admin, `INSERT INTO public.course_enrollments (college_id, offering_id, student_id) VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S_B}')`);
    expect(enrol.error).toMatch(/course_enrollments_student_tenant_fkey/);
    const att = await as(db, U.admin, `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by) VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S_B}','${DATE}','present',auth.uid())`);
    // 051's enrolment-binding guard (P3-8) fires first for a student who is
    // not on this offering; the tenant FK is the backstop underneath it.
    expect(att.error).toMatch(/not enrolled|attendance_student_tenant_fkey/);
    const mark = await as(db, U.admin, `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, obtained_marks, max_marks, entered_by) VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S_B}','internal_1',10,20,auth.uid())`);
    expect(mark.error).toMatch(/not enrolled|marks_student_tenant_fkey/);
    expect(await scalar(db, `SELECT count(*)::int FROM course_enrollments WHERE student_id=$1 AND college_id=$2`, [S_B, COLLEGE_A])).toBe(0);
    expect(await scalar(db, `SELECT count(*)::int FROM attendance WHERE student_id=$1`, [S_B])).toBe(0);
  });

  it("a college B teacher cannot be named substitute on a college A offering", async () => {
    const r = await as(db, U.hodCse,
      `INSERT INTO public.substitution_assignments (college_id, offering_id, original_teacher_id, date, status, substitute_teacher_id)
         VALUES ('${COLLEGE_A}','${OFF.dsA3}','${U.teacherA}','2026-10-01','needed','${U.bTeacher}')`);
    expect(r.ok).toBe(false);
    // Two defences overlap here — the §7e insert rule (no substitute at
    // creation) and the tenant key. The point is that the row does not land.
    expect(await scalar(db, `SELECT count(*)::int FROM substitution_assignments WHERE substitute_teacher_id=$1`, [U.bTeacher])).toBe(0);
  });

  it("every tenant key in the schema is accounted for here", async () => {
    const rows = await verify<{ conname: string }>(db, `
      SELECT conname FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace
        AND conname LIKE '%_tenant_fkey' ORDER BY conname`);
    expect(rows.map((r) => r.conname)).toEqual([
      "attendance_offering_tenant_fkey", "attendance_student_tenant_fkey",
      "course_enrollments_offering_tenant_fkey", "course_enrollments_student_tenant_fkey",
      "course_offerings_course_tenant_fkey", "course_offerings_instructor_tenant_fkey",
      "course_offerings_section_tenant_fkey", "course_offerings_semester_tenant_fkey",
      "courses_department_tenant_fkey",
      // Finance Integration Hub (049): every child of a connection carries the
      // connection's college, so a College B row cannot hang off a College A
      // integration.
      "fam_connection_tenant_fkey", "fel_connection_tenant_fkey", "fic_cred_tenant_fkey",
      "frr_connection_tenant_fkey", "fsc_connection_tenant_fkey", "fso_connection_tenant_fkey", "fsr_connection_tenant_fkey",
      // Gate Security (050). gm_/gpc_pass_tenant_fkey are three-column —
      // (pass, college, student) — so a ledger row cannot name a pass in one
      // tenant, a college in another and a student in neither. The rest bind
      // guards, gates, assignments and instructions to one college.
      "gm_gate_tenant_fkey", "gm_pass_tenant_fkey", "gpc_pass_tenant_fkey",
      "marks_offering_tenant_fkey", "marks_student_tenant_fkey",
      "placement_applications_drive_tenant_fkey",
      "programmes_department_tenant_fkey", "sections_programme_tenant_fkey",
      "semesters_academic_year_tenant_fkey",
      "sga_gate_tenant_fkey", "sga_personnel_tenant_fkey",
      "si_gate_tenant_fkey", "si_personnel_tenant_fkey",
      "substitution_assignments_offering_tenant_fkey", "substitution_assignments_substitute_tenant_fkey",
      "timetable_slots_offering_tenant_fkey",
    ]);
  });
});

// ══════════════════════════════════════════════════════════════
// S6 — sections are scoped to the HOD's department (§7q)
// ══════════════════════════════════════════════════════════════

describe("S6: an HOD's section writes stop at their department", () => {
  const PROG_CSE = "00000007-0000-4000-8000-000000000001";
  const PROG_ECE = "00000007-0000-4000-8000-000000000002";
  const SECTION_ECE_A = "00000008-0000-4000-8000-000000000003";
  const SECTION_CSE_A = "00000008-0000-4000-8000-000000000001";

  it("cannot touch another department's section, nor create one under its programme", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.hodCse, `UPDATE public.sections SET name='Hijacked' WHERE id='${SECTION_ECE_A}'`)).rows).toBe(0);
      expect((await as(d, U.hodCse, `DELETE FROM public.sections WHERE id='${SECTION_ECE_A}'`)).rows).toBe(0);
      const ins = await as(d, U.hodCse, `INSERT INTO public.sections (college_id, programme_id, batch_year, name) VALUES ('${COLLEGE_A}','${PROG_ECE}',2026,'QA-ECE-X')`);
      expect(ins.ok).toBe(false);
      expect(await scalar(d, `SELECT name FROM sections WHERE id=$1`, [SECTION_ECE_A])).toBe("ECE-A");
    } finally { await d.close(); }
  });

  it("can manage its own department's sections, but cannot walk one out of the department", async () => {
    const d = await fresh();
    try {
      const ins = await as(d, U.hodCse, `INSERT INTO public.sections (college_id, programme_id, batch_year, name) VALUES ('${COLLEGE_A}','${PROG_CSE}',2026,'QA-CSE-X') RETURNING id`);
      expect(ins.ok, ins.error ?? "").toBe(true);
      expect((await as(d, U.hodCse, `UPDATE public.sections SET capacity=70 WHERE id='${SECTION_CSE_A}' RETURNING id`)).rows).toBe(1);
      const walkOut = await as(d, U.hodCse, `UPDATE public.sections SET programme_id='${PROG_ECE}' WHERE id='${SECTION_CSE_A}'`);
      expect(walkOut.ok).toBe(false);
      expect(await scalar(d, `SELECT programme_id FROM sections WHERE id=$1`, [SECTION_CSE_A])).toBe(PROG_CSE);
    } finally { await d.close(); }
  });

  it("MODEL: students are not members of sections — re-parenting a section changes no enrollment, attendance or authority", async () => {
    const d = await fresh();
    try {
      const cols = await verify<{ column_name: string }>(d, `SELECT column_name FROM information_schema.columns WHERE table_name='students' AND column_name IN ('section_id','programme_id')`);
      expect(cols).toEqual([]);
      const before = await verify(d, `SELECT count(*)::int n, md5(string_agg(e::text,'|' ORDER BY e.id)) h FROM course_enrollments e JOIN course_offerings o ON o.id=e.offering_id WHERE o.section_id=$1`, [SECTION_CSE_A]);
      await verify(d, `UPDATE sections SET programme_id=$2 WHERE id=$1`, [SECTION_CSE_A, PROG_ECE]); // as admin/console
      expect(await verify(d, `SELECT count(*)::int n, md5(string_agg(e::text,'|' ORDER BY e.id)) h FROM course_enrollments e JOIN course_offerings o ON o.id=e.offering_id WHERE o.section_id=$1`, [SECTION_CSE_A])).toEqual(before);
      // and the CSE HOD still heads the offering, because scope follows the COURSE's department
      expect(await scalar(d, `SELECT count(*)::int FROM course_offerings o WHERE o.section_id=$1 AND EXISTS (SELECT 1 FROM courses c JOIN departments dd ON dd.id=c.department_id WHERE c.id=o.course_id AND dd.hod_id=$2)`, [SECTION_CSE_A, U.hodCse]).then(Number)).toBeGreaterThan(0);
    } finally { await d.close(); }
  });
});
