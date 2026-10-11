import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  stagingDb, as, verify, scalar, U, S, OFF, COLLEGE_A, COLLEGE_B, DEPT_CSE, DEPT_ECE, SEM_3, SEM_5, SEM_PAST, COURSE_DS,
} from "./staging/harness";

/**
 * Migration 055 — the academic foundation (ACADEMIC_LIFECYCLE_CONTRACT.md,
 * PR 1) — against the repository's real migration chain on disposable
 * PostgreSQL.
 *
 * Every action runs as `authenticated` with the caller's claims, the way a
 * PostgREST request arrives, so each refusal here is what a browser, the
 * mobile app or a hand-built API call gets. verify()/scalar() read as the
 * owner and are used ONLY to check postconditions.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const SEC = {
  cseA: "00000008-0000-4000-8000-000000000001",
  cseB: "00000008-0000-4000-8000-000000000002",
  eceA: "00000008-0000-4000-8000-000000000003",
  mechA: "00000008-0000-4000-8000-000000000004",
  cseA2023: "00000008-0000-4000-8000-000000000005",
  bCse: "00000008-0000-4000-8000-000000000006",
} as const;
const PROG_CSE = "00000007-0000-4000-8000-000000000001";
const PROG_ECE = "00000007-0000-4000-8000-000000000002";
const COURSE_DBMS = "00000009-0000-4000-8000-000000000002";
const COURSE_OS = "00000009-0000-4000-8000-000000000003";
const REASON = "Agreed in the department meeting";

const rpc = (d: PGlite, uid: string, sql: string, params: unknown[] = []) => as(d, uid, sql, params);
const assignIncharge = (d: PGlite, actor: string, section: string, teacher: string) =>
  rpc(d, actor, `SELECT public.assign_class_incharge($1, $2, $3) AS r`, [section, teacher, REASON]);
const placeStudent = (d: PGlite, actor: string, student: string, section: string) =>
  rpc(d, actor, `SELECT public.assign_student_section($1, $2, $3) AS r`, [student, section, REASON]);
const slot = (d: PGlite, actor: string, offering: string, day: number, start: string, end: string, room: string | null) =>
  rpc(d, actor, `SELECT public.create_timetable_slot($1, $2, $3::time, $4::time, $5) AS id`, [offering, day, start, end, room]);
const enrolledCount = (d: PGlite, student: string, offering: string) =>
  scalar(d, `SELECT count(*)::int FROM public.course_enrollments WHERE student_id = $1 AND offering_id = $2 AND status = 'enrolled'`, [student, offering]);

// ─────────────────────────────────────────────────────────────
describe("migration 055: shape and backfill-by-trigger", () => {
  let db: PGlite;
  beforeAll(async () => { db = await stagingDb(); });
  afterAll(async () => { await db?.close(); });

  it("every new table has RLS, the restrictive access gate and the write gate", async () => {
    const tables = ["department_terms", "section_class_incharges", "student_section_assignments", "department_hod_assignments",
      "offering_instructor_history", "external_teaching_authorizations", "student_invitation_placements"];
    for (const t of tables) {
      expect(await scalar(db, `SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass`, [`public.${t}`])).toBe(true);
      expect(await scalar(db, `SELECT count(*)::int FROM pg_policies WHERE tablename = $1 AND policyname = 'tenant_access_gate' AND permissive = 'RESTRICTIVE'`, [t])).toBe(1);
      expect(await scalar(db, `SELECT count(*)::int FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = 'guard_tenant_write_access'`, [`public.${t}`])).toBe(1);
      // No write policy of any kind: functions are the only writers.
      expect(await scalar(db, `SELECT count(*)::int FROM pg_policies WHERE tablename = $1 AND cmd <> 'SELECT' AND policyname <> 'tenant_access_gate'`, [t])).toBe(0);
    }
  });

  it("HOD history is written by the database whenever departments.hod_id is set", async () => {
    const rows = await verify<{ department_id: string; hod_id: string }>(db,
      `SELECT department_id, hod_id FROM public.department_hod_assignments WHERE ended_at IS NULL ORDER BY department_id`);
    expect(rows.map((r) => r.department_id)).toContain(DEPT_CSE);
    expect(rows.find((r) => r.department_id === DEPT_CSE)?.hod_id).toBe(U.hodCse);
  });

  it("instructor history holds the current instructor of every staffed offering", async () => {
    const staffed = await scalar(db, `SELECT count(*)::int FROM public.course_offerings WHERE instructor_id IS NOT NULL`);
    expect(await scalar(db, `SELECT count(*)::int FROM public.offering_instructor_history WHERE ended_at IS NULL`)).toBe(staffed);
  });
});

// ─────────────────────────────────────────────────────────────
describe("department operational term (decision 1)", () => {
  let db: PGlite;
  beforeAll(async () => { db = await stagingDb(); });
  afterAll(async () => { await db?.close(); });

  it("readiness lists what is missing, and refuses anyone who does not manage the department", async () => {
    const r = await rpc(db, U.hodCse, `SELECT public.department_term_readiness($1) AS r`, [DEPT_CSE]);
    expect(r.ok).toBe(true);
    const readiness = r.data[0].r as { ready: boolean; status: string; semester_id: string; items: { code: string }[] };
    expect(readiness.ready).toBe(false);
    expect(readiness.status).toBe("not_started");
    expect(readiness.semester_id).toBe(SEM_3);
    const codes = readiness.items.map((i) => i.code);
    expect(codes).toContain("section_without_incharge");
    expect(codes).toContain("section_without_offerings"); // CSE-A 2023 has nothing in this term

    for (const outsider of [U.teacherA, U.hodEce, U.studentA, U.bHod]) {
      const denied = await rpc(db, outsider, `SELECT public.department_term_readiness($1)`, [DEPT_CSE]);
      expect(denied.ok, outsider).toBe(false);
    }
  });

  it("a department that is not ready cannot start; a teacher or another HOD never can", async () => {
    const r = await rpc(db, U.hodCse, `SELECT public.start_department_term($1)`, [DEPT_CSE]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not ready to start/);
    expect((await rpc(db, U.teacherA, `SELECT public.start_department_term($1)`, [DEPT_CSE])).error).toMatch(/Only the HOD/);
    expect((await rpc(db, U.hodEce, `SELECT public.start_department_term($1)`, [DEPT_CSE])).error).toMatch(/Only the HOD/);
  });

  it("start, start-twice, end, end-twice — and ending freezes the department's offerings", async () => {
    expect((await assignIncharge(db, U.hodCse, SEC.cseA, U.teacherA)).ok).toBe(true);
    expect((await assignIncharge(db, U.hodCse, SEC.cseB, U.teacherB)).ok).toBe(true);
    // The 2023 cohort has no classes this term: retire the section rather than invent offerings.
    expect((await as(db, U.hodCse, `UPDATE public.sections SET status = 'inactive' WHERE id = $1`, [SEC.cseA2023])).rows).toBe(1);

    const ready = await rpc(db, U.hodCse, `SELECT public.department_term_readiness($1) AS r`, [DEPT_CSE]);
    expect((ready.data[0].r as { ready: boolean }).ready).toBe(true);

    const started = await rpc(db, U.hodCse, `SELECT public.start_department_term($1) AS r`, [DEPT_CSE]);
    expect(started.ok, started.error ?? "").toBe(true);
    expect(await scalar(db, `SELECT status FROM public.department_terms WHERE department_id = $1 AND semester_id = $2`, [DEPT_CSE, SEM_3])).toBe("active");
    expect(await scalar(db, `SELECT count(*)::int FROM public.audit_logs WHERE action = 'department_term.started'`)).toBe(1);
    expect(await scalar(db, `SELECT count(*)::int FROM public.notifications WHERE title = 'Department term started' AND receiver_id = $1`, [U.teacherA])).toBe(1);

    const twice = await rpc(db, U.hodCse, `SELECT public.start_department_term($1)`, [DEPT_CSE]);
    expect(twice.error).toMatch(/already been started/);

    // Before the end, the instructor may still record attendance.
    expect((await as(db, U.teacherA, `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
      VALUES ($1, $2, $3, '2026-09-10', 'present', $4)`, [COLLEGE_A, OFF.dsA3, S.a, U.teacherA])).ok).toBe(true);

    expect((await rpc(db, U.hodCse, `SELECT public.end_department_term($1, 'short')`, [DEPT_CSE])).error).toMatch(/at least 10/);
    expect((await rpc(db, U.teacherA, `SELECT public.end_department_term($1, $2)`, [DEPT_CSE, REASON])).ok).toBe(false);
    const ended = await rpc(db, U.hodCse, `SELECT public.end_department_term($1, $2) AS r`, [DEPT_CSE, REASON]);
    expect(ended.ok, ended.error ?? "").toBe(true);
    expect(await scalar(db, `SELECT status FROM public.course_offerings WHERE id = $1`, [OFF.dsA3])).toBe("completed");
    // Another department's offering in the same term is untouched.
    expect(await scalar(db, `SELECT status FROM public.course_offerings WHERE id = $1`, [OFF.ece])).toBe("active");

    const afterEnd = await as(db, U.teacherA, `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
      VALUES ($1, $2, $3, '2026-09-11', 'present', $4)`, [COLLEGE_A, OFF.dsA3, S.a, U.teacherA]);
    expect(afterEnd.error).toMatch(/completed; its records are read-only/);
    // History survives: the attendance taken before the end is still there.
    expect(await scalar(db, `SELECT count(*)::int FROM public.attendance WHERE offering_id = $1 AND date = '2026-09-10'`, [OFF.dsA3])).toBe(1);

    expect((await rpc(db, U.hodCse, `SELECT public.end_department_term($1, $2)`, [DEPT_CSE, REASON])).error).toMatch(/already ended/);
  });

  it("the department-term row itself is immutable once ended, even for the database owner", async () => {
    let failed: string | null = null;
    try { await db.query(`UPDATE public.department_terms SET end_reason = 'rewritten history' WHERE department_id = $1`, [DEPT_CSE]); }
    catch (e) { failed = (e as Error).message; }
    expect(failed).toMatch(/closed history row is immutable/);
  });

  it("closing the college term ends every department term still running in it", async () => {
    const d = await stagingDb();
    try {
      await d.query(`INSERT INTO public.department_terms (college_id, department_id, semester_id, status, start_source) VALUES ($1, $2, $3, 'active', 'backfill')`, [COLLEGE_A, DEPT_ECE, SEM_3]);
      const close = await as(d, U.admin, `UPDATE public.semesters SET status = 'closed' WHERE id = $1`, [SEM_3]);
      expect(close.rows).toBe(1);
      expect(await scalar(d, `SELECT status FROM public.department_terms WHERE department_id = $1`, [DEPT_ECE])).toBe("ended");
    } finally { await d.close(); }
  });
});

// ─────────────────────────────────────────────────────────────
describe("Class In-Charge", () => {
  let db: PGlite;
  beforeAll(async () => { db = await stagingDb(); });
  afterAll(async () => { await db?.close(); });

  it("assign, then replace: the replacement ends the old row and keeps it as history", async () => {
    expect((await assignIncharge(db, U.hodCse, SEC.cseA, U.teacherA)).ok).toBe(true);
    const replaced = await assignIncharge(db, U.hodCse, SEC.cseA, U.teacherB);
    expect(replaced.ok, replaced.error ?? "").toBe(true);
    const rows = await verify<{ teacher_id: string; ended_at: string | null }>(db,
      `SELECT teacher_id, ended_at FROM public.section_class_incharges WHERE section_id = $1 ORDER BY assigned_at, ended_at NULLS LAST`, [SEC.cseA]);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.ended_at === null).map((r) => r.teacher_id)).toEqual([U.teacherB]);
    expect(await scalar(db, `SELECT count(*)::int FROM public.notifications WHERE title = 'Class In-Charge changed' AND receiver_id = $1`, [U.teacherA])).toBe(1);
    expect(await scalar(db, `SELECT count(*)::int FROM public.audit_logs WHERE action = 'class_incharge.assigned'`)).toBe(2);
  });

  it("refuses the same teacher twice, the wrong HOD, a teacher, a cross-department and a cross-college teacher", async () => {
    expect((await assignIncharge(db, U.hodCse, SEC.cseA, U.teacherB)).error).toMatch(/already the Class In-Charge/);
    expect((await assignIncharge(db, U.hodEce, SEC.cseA, U.teacherA)).error).toMatch(/Only the HOD/);
    expect((await assignIncharge(db, U.teacherA, SEC.cseA, U.teacherA)).error).toMatch(/Only the HOD/);
    expect((await assignIncharge(db, U.hodCse, SEC.cseB, U.hodEce)).error).toMatch(/active teacher of the section's department/);
    expect((await assignIncharge(db, U.hodCse, SEC.cseB, U.bTeacher)).error).toMatch(/active teacher of the section's department/);
    expect((await assignIncharge(db, U.bHod, SEC.cseB, U.teacherA)).error).toMatch(/not found in your college/);
  });

  it("an inactive teacher cannot become In-Charge", async () => {
    await db.query(`UPDATE public.profiles SET status = 'suspended' WHERE id = $1`, [U.teacherC]);
    try {
      expect((await assignIncharge(db, U.hodCse, SEC.cseB, U.teacherC)).error).toMatch(/active teacher/);
    } finally { await db.query(`UPDATE public.profiles SET status = 'active' WHERE id = $1`, [U.teacherC]); }
  });

  it("the table has no direct write path, and a closed row cannot be reopened even by the owner", async () => {
    const ins = await as(db, U.hodCse, `INSERT INTO public.section_class_incharges (college_id, semester_id, section_id, teacher_id) VALUES ($1,$2,$3,$4)`,
      [COLLEGE_A, SEM_3, SEC.cseB, U.teacherC]);
    expect(ins.ok).toBe(false);
    const upd = await as(db, U.admin, `UPDATE public.section_class_incharges SET teacher_id = $1`, [U.teacherC]);
    expect(upd.rows).toBe(0);
    let failed: string | null = null;
    try { await db.query(`UPDATE public.section_class_incharges SET ended_at = NULL WHERE teacher_id = $1`, [U.teacherA]); }
    catch (e) { failed = (e as Error).message; }
    expect(failed).toMatch(/immutable/);
  });
});

// ─────────────────────────────────────────────────────────────
describe("teacher assignment: instructor eligibility (decision 4) and history (defect 5)", () => {
  let db: PGlite;
  beforeAll(async () => { db = await stagingDb(); });
  afterAll(async () => { await db?.close(); });

  const createOffering = (actor: string, course: string, section: string, instructor: string | null, semester = SEM_5) =>
    as(db, actor, `INSERT INTO public.course_offerings (college_id, semester_id, course_id, section_id, instructor_id)
      VALUES ($1, $2, $3, $4, $5) RETURNING id`, [COLLEGE_A, semester, course, section, instructor]);

  it("an own-department teacher can be assigned; another department's cannot until authorized", async () => {
    expect((await createOffering(U.hodCse, COURSE_DS, SEC.cseB, U.teacherC)).ok).toBe(true);
    const external = await createOffering(U.hodCse, COURSE_DBMS, SEC.cseB, U.hodEce, SEM_5);
    expect(external.error).toMatch(/not authorized to teach this course/);

    expect((await rpc(db, U.hodEce, `SELECT public.grant_external_teaching($1, $2, $3)`, [DEPT_CSE, U.hodEce, REASON])).error).toMatch(/Only the HOD/);
    const grant = await rpc(db, U.hodCse, `SELECT public.grant_external_teaching($1, $2, $3) AS r`, [DEPT_CSE, U.hodEce, REASON]);
    expect(grant.ok, grant.error ?? "").toBe(true);
    const assigned = await createOffering(U.hodCse, COURSE_DBMS, SEC.cseB, U.hodEce, SEM_5);
    expect(assigned.ok, assigned.error ?? "").toBe(true);

    const authId = (grant.data[0].r as { id: string }).id;
    const revoke = await rpc(db, U.hodCse, `SELECT public.revoke_external_teaching($1, $2)`, [authId, REASON]);
    expect(revoke.error).toMatch(/still teaches an open offering/);
  });

  it("a director cannot name themselves instructor (047's recorded residual, now closed)", async () => {
    const r = await as(db, U.director, `UPDATE public.course_offerings SET instructor_id = $1 WHERE id = $2`, [U.director, OFF.dsA3]);
    expect(r.error).toMatch(/not authorized to teach/);
  });

  it("inactive and other-college teachers are refused", async () => {
    await db.query(`UPDATE public.profiles SET status = 'suspended' WHERE id = $1`, [U.teacherC]);
    try {
      expect((await as(db, U.hodCse, `UPDATE public.course_offerings SET instructor_id = $1 WHERE id = $2`, [U.teacherC, OFF.dsB3])).error)
        .toMatch(/not authorized/);
    } finally { await db.query(`UPDATE public.profiles SET status = 'active' WHERE id = $1`, [U.teacherC]); }
    expect((await as(db, U.hodCse, `UPDATE public.course_offerings SET instructor_id = $1 WHERE id = $2`, [U.bTeacher, OFF.dsB3])).ok).toBe(false);
  });

  it("an instructor change is recorded as history", async () => {
    const r = await as(db, U.hodCse, `UPDATE public.course_offerings SET instructor_id = $1 WHERE id = $2`, [U.teacherC, OFF.dbmsB3]);
    expect(r.rows).toBe(1);
    const hist = await verify<{ instructor_id: string; ended_at: string | null }>(db,
      `SELECT instructor_id, ended_at FROM public.offering_instructor_history WHERE offering_id = $1 ORDER BY started_at, ended_at NULLS LAST`, [OFF.dbmsB3]);
    expect(hist.map((h) => [h.instructor_id, h.ended_at === null])).toEqual([[U.teacherB, false], [U.teacherC, true]]);
  });

  it("defect 5: a closed term's teacher assignment cannot be changed — by HOD, admin or director", async () => {
    for (const actor of [U.hodCse, U.admin, U.director]) {
      const r = await as(db, actor, `UPDATE public.course_offerings SET instructor_id = $1 WHERE id = $2`, [U.teacherB, OFF.historical]);
      expect(r.ok, actor).toBe(false);
    }
    expect(await scalar(db, `SELECT instructor_id FROM public.course_offerings WHERE id = $1`, [OFF.historical])).toBe(U.teacherA);
  });

  it("offerings are created only for active sections and courses", async () => {
    await db.query(`UPDATE public.sections SET status = 'inactive' WHERE id = $1`, [SEC.cseA2023]);
    expect((await createOffering(U.hodCse, COURSE_OS, SEC.cseA2023, U.teacherA)).error).toMatch(/active section/);
  });
});

// ─────────────────────────────────────────────────────────────
describe("defect 4: completed offerings accept no academic writes", () => {
  let db: PGlite;
  beforeAll(async () => { db = await stagingDb(); });
  afterAll(async () => { await db?.close(); });

  it("attendance and marks on a completed offering are refused for the instructor", async () => {
    expect((await as(db, U.hodCse, `UPDATE public.course_offerings SET status = 'completed' WHERE id = $1`, [OFF.dsA3])).rows).toBe(1);
    const att = await as(db, U.teacherA, `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
      VALUES ($1, $2, $3, '2026-09-10', 'present', $4)`, [COLLEGE_A, OFF.dsA3, S.a, U.teacherA]);
    expect(att.error).toMatch(/completed/);
    const mk = await as(db, U.teacherA, `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks, entered_by)
      VALUES ($1, $2, $3, 'internal_1', 100, 80, $4)`, [COLLEGE_A, OFF.dsA3, S.a, U.teacherA]);
    expect(mk.error).toMatch(/completed/);
  });

  it("052's reopen window still allows corrections on a completed offering", async () => {
    await db.query(`INSERT INTO public.marks (id, college_id, offering_id, student_id, exam_type, max_marks, obtained_marks, entered_by)
      VALUES ('0000000c-0000-4000-8000-0000000000aa', $1, $2, $3, 'final', 100, 60, $4)`, [COLLEGE_A, OFF.dsA3, S.a, U.teacherA]);
    const fixClosed = await as(db, U.teacherA, `UPDATE public.marks SET obtained_marks = 64 WHERE id = '0000000c-0000-4000-8000-0000000000aa'`);
    expect(fixClosed.ok).toBe(false);
    expect((await as(db, U.admin, `UPDATE public.semesters SET status = 'closed' WHERE id = $1`, [SEM_3])).rows).toBe(1);
    const reopen = await as(db, U.admin, `SELECT public.reopen_semester($1, $2)`, [SEM_3, "Correcting a marks entry error"]);
    expect(reopen.ok, reopen.error ?? "").toBe(true);
    const fix = await as(db, U.teacherA, `UPDATE public.marks SET obtained_marks = 64 WHERE id = '0000000c-0000-4000-8000-0000000000aa'`);
    expect(fix.rows, fix.error ?? "").toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
describe("enrolment: no direct staff writes, one enrolled row per course per term", () => {
  let db: PGlite;
  beforeAll(async () => { db = await stagingDb(); });
  afterAll(async () => { await db?.close(); });

  it("the HOD and the instructor can no longer write enrolments directly", async () => {
    for (const actor of [U.hodCse, U.teacherA]) {
      const r = await as(db, actor, `INSERT INTO public.course_enrollments (college_id, student_id, offering_id) VALUES ($1, $2, $3)`,
        [COLLEGE_A, S.d, OFF.dsA3]);
      expect(r.ok, actor).toBe(false);
      const del = await as(db, actor, `DELETE FROM public.course_enrollments WHERE offering_id = $1`, [OFF.dsA3]);
      expect(del.rows, actor).toBe(0);
    }
    // Staff READ is unchanged.
    expect((await as(db, U.teacherA, `SELECT id FROM public.course_enrollments WHERE offering_id = $1`, [OFF.dsA3])).data.length).toBe(2);
  });

  it("a second active enrolment in the same course and term is refused, even for admin", async () => {
    const dup = await as(db, U.admin, `INSERT INTO public.course_enrollments (college_id, student_id, offering_id) VALUES ($1, $2, $3)`,
      [COLLEGE_A, S.a, OFF.dsB3]);
    expect(dup.error).toMatch(/already enrolled in this course for this term/);
    const ok = await as(db, U.admin, `INSERT INTO public.course_enrollments (college_id, student_id, offering_id) VALUES ($1, $2, $3)`,
      [COLLEGE_A, S.c, OFF.dbmsB3]);
    expect(ok.ok, ok.error ?? "").toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
describe("student section assignment and reconciliation", () => {
  let db: PGlite;
  beforeAll(async () => { db = await stagingDb(); });
  afterAll(async () => { await db?.close(); });

  it("lists the department's unplaced students to its HOD only", async () => {
    const r = await rpc(db, U.hodCse, `SELECT student_id FROM public.students_without_section($1)`, [DEPT_CSE]);
    expect(r.data.map((x) => x.student_id).sort()).toEqual([S.a, S.b, S.c, S.d, S.e, S.f].sort());
    expect((await rpc(db, U.hodEce, `SELECT * FROM public.students_without_section($1)`, [DEPT_CSE])).ok).toBe(false);
    expect((await rpc(db, U.teacherA, `SELECT * FROM public.students_without_section($1)`, [DEPT_CSE])).ok).toBe(false);
  });

  it("placing a student opens their section and enrols them, skipping a course they already take", async () => {
    const c = await placeStudent(db, U.hodCse, S.c, SEC.cseA);
    expect(c.ok, c.error ?? "").toBe(true);
    expect((c.data[0].r as { enrollments_created: number }).enrollments_created).toBe(2); // DBMS-A + OS; DS already via CSE-B
    expect(await enrolledCount(db, S.c, OFF.dbmsA3)).toBe(1);
    expect(await enrolledCount(db, S.c, OFF.dsA3)).toBe(0);
    expect(await scalar(db, `SELECT count(*)::int FROM public.audit_logs WHERE action = 'student_section.assigned'`)).toBe(1);
  });

  it("refuses a second current section, another department's section, the wrong HOD and a teacher", async () => {
    expect((await placeStudent(db, U.hodCse, S.c, SEC.cseB)).error).toMatch(/section change request/);
    expect((await placeStudent(db, U.hodCse, S.a, SEC.eceA)).error).toMatch(/own department/);
    expect((await placeStudent(db, U.hodEce, S.a, SEC.cseA)).error).toMatch(/Only the HOD/);
    expect((await placeStudent(db, U.teacherA, S.a, SEC.cseA)).error).toMatch(/Only the HOD/);
    expect((await placeStudent(db, U.bHod, S.a, SEC.cseA)).error).toMatch(/not found/);
  });

  it("assignments have no direct write path, and history cannot be rewritten", async () => {
    const ins = await as(db, U.admin, `INSERT INTO public.student_section_assignments (college_id, student_id, section_id, start_source) VALUES ($1,$2,$3,'reconciliation')`,
      [COLLEGE_A, S.d, SEC.cseB]);
    expect(ins.ok).toBe(false);
    let failed: string | null = null;
    try { await db.query(`UPDATE public.student_section_assignments SET section_id = $1 WHERE student_id = $2`, [SEC.cseB, S.c]); }
    catch (e) { failed = (e as Error).message; }
    expect(failed).toMatch(/history/);
    const del = await as(db, U.admin, `DELETE FROM public.student_section_assignments WHERE student_id = $1`, [S.c]);
    expect(del.rows).toBe(0);
  });

  it("answers 'which section was this student in during a term', and students read only their own", async () => {
    const at = await rpc(db, U.hodCse, `SELECT section_id FROM public.student_section_at($1, $2)`, [S.c, SEM_3]);
    expect(at.data.map((x) => x.section_id)).toEqual([SEC.cseA]);
    expect((await as(db, U.studentC, `SELECT id FROM public.student_section_assignments`)).data).toHaveLength(1);
    expect((await as(db, U.studentA, `SELECT id FROM public.student_section_assignments`)).data).toHaveLength(0);
  });

  it("a new offering in the active term reaches the section's current students — but never an elective", async () => {
    expect((await placeStudent(db, U.hodCse, S.d, SEC.cseB)).ok).toBe(true);
    const os = await as(db, U.hodCse, `INSERT INTO public.course_offerings (college_id, semester_id, course_id, section_id, instructor_id)
      VALUES ($1, $2, $3, $4, $5) RETURNING id`, [COLLEGE_A, SEM_3, COURSE_OS, SEC.cseB, U.teacherB]);
    expect(os.ok, os.error ?? "").toBe(true);
    expect(await enrolledCount(db, S.d, os.data[0].id as string)).toBe(1);

    const elective = await as(db, U.hodCse, `INSERT INTO public.courses (college_id, department_id, name, code, credits, type)
      VALUES ($1, $2, 'QA Machine Learning', 'QA-CS-EL1', 3, 'elective') RETURNING id`, [COLLEGE_A, DEPT_CSE]);
    expect(elective.ok, elective.error ?? "").toBe(true);
    const el = await as(db, U.hodCse, `INSERT INTO public.course_offerings (college_id, semester_id, course_id, section_id, instructor_id)
      VALUES ($1, $2, $3, $4, $5) RETURNING id`, [COLLEGE_A, SEM_3, elective.data[0].id, SEC.cseB, U.teacherB]);
    expect(el.ok, el.error ?? "").toBe(true);
    expect(await enrolledCount(db, S.d, el.data[0].id as string)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
describe("timetable authoring (decision 6) and visibility (defect 2)", () => {
  let db: PGlite;
  beforeAll(async () => { db = await stagingDb(); });
  afterAll(async () => { await db?.close(); });

  it("the HOD of the course's department schedules a class", async () => {
    const r = await slot(db, U.hodCse, OFF.dsA3, 4, "09:00", "10:00", "QA-R201");
    expect(r.ok, r.error ?? "").toBe(true);
    expect(await scalar(db, `SELECT count(*)::int FROM public.audit_logs WHERE action = 'timetable.slot_created'`)).toBe(1);
  });

  it("refuses teacher, section and room overlaps in the same term", async () => {
    expect((await slot(db, U.hodCse, OFF.dbmsA3, 4, "09:30", "10:30", "QA-R999")).error).toMatch(/Teacher conflict/);
    expect((await slot(db, U.hodCse, OFF.osHod, 4, "09:30", "10:30", "QA-R301")).error).toMatch(/Section conflict/);
    expect((await slot(db, U.hodCse, OFF.dsB3, 4, "09:30", "10:30", " qa-r201 ")).error).toMatch(/Room conflict/);
    // Back-to-back is not an overlap.
    expect((await slot(db, U.hodCse, OFF.dbmsA3, 4, "10:00", "11:00", "QA-R201")).ok).toBe(true);
  });

  it("refuses an inverted time, the wrong HOD, a teacher, and direct table writes", async () => {
    expect((await slot(db, U.hodCse, OFF.dsB3, 4, "11:00", "10:00", null)).error).toMatch(/end after it starts/);
    expect((await slot(db, U.hodEce, OFF.dsB3, 4, "09:00", "10:00", null)).error).toMatch(/Only the HOD/);
    expect((await slot(db, U.teacherA, OFF.dsA3, 4, "09:00", "10:00", null)).error).toMatch(/Only the HOD/);
    const direct = await as(db, U.hodCse, `INSERT INTO public.timetable_slots (college_id, offering_id, day_of_week, start_time, end_time) VALUES ($1,$2,4,'09:00','10:00')`,
      [COLLEGE_A, OFF.dsB3]);
    expect(direct.ok).toBe(false);
  });

  it("a closed term's timetable is history: no new slot, no removal", async () => {
    expect((await slot(db, U.hodCse, OFF.historical, 2, "09:00", "10:00", null)).ok).toBe(false);
    await db.query(`INSERT INTO public.timetable_slots (id, college_id, offering_id, day_of_week, start_time, end_time) VALUES
      ('0000000d-0000-4000-8000-0000000000ff', $1, $2, 2, '09:00', '10:00')`, [COLLEGE_A, OFF.historical]);
    const del = await rpc(db, U.hodCse, `SELECT public.delete_timetable_slot('0000000d-0000-4000-8000-0000000000ff')`);
    expect(del.ok).toBe(false);
    expect(await scalar(db, `SELECT count(*)::int FROM public.timetable_slots WHERE id = '0000000d-0000-4000-8000-0000000000ff'`)).toBe(1);
  });

  it("an instructor change that would double-book the teacher is refused", async () => {
    // Teacher B already teaches DS (CSE-B) Monday 10-11 (fixture). Put DBMS-A at the same time, then try to give it to B.
    expect((await slot(db, U.hodCse, OFF.dbmsA3, 1, "10:00", "11:00", "QA-R105")).ok).toBe(true);
    const r = await as(db, U.hodCse, `UPDATE public.course_offerings SET instructor_id = $1 WHERE id = $2`, [U.teacherB, OFF.dbmsA3]);
    expect(r.error).toMatch(/Timetable conflict/);
  });

  it("a student sees only the slots of their own enrolled offerings; staff see the college", async () => {
    const mine = await as(db, U.studentA, `SELECT offering_id FROM public.timetable_slots`);
    const ids = new Set(mine.data.map((x) => x.offering_id));
    expect(ids.has(OFF.dsA3)).toBe(true);
    expect(ids.has(OFF.dsB3)).toBe(false);
    const c = await as(db, U.studentC, `SELECT offering_id FROM public.timetable_slots`);
    expect([...new Set(c.data.map((x) => x.offering_id))]).toEqual([OFF.dsB3]);
    const staff = await as(db, U.teacherC, `SELECT DISTINCT offering_id FROM public.timetable_slots`);
    expect(staff.data.length).toBeGreaterThan(3);
    expect((await as(db, U.bStudent, `SELECT id FROM public.timetable_slots WHERE college_id = $1`, [COLLEGE_A])).data).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
describe("department academic configuration (decision 5)", () => {
  let db: PGlite;
  beforeAll(async () => { db = await stagingDb(); });
  afterAll(async () => { await db?.close(); });

  it("the HOD creates and edits their own department's programme, audited", async () => {
    const ins = await as(db, U.hodCse, `INSERT INTO public.programmes (college_id, department_id, name, code, duration_semesters)
      VALUES ($1, $2, 'QA M.Tech CSE', 'QA-MT-CSE', 4) RETURNING id`, [COLLEGE_A, DEPT_CSE]);
    expect(ins.ok, ins.error ?? "").toBe(true);
    const id = ins.data[0].id as string;
    expect((await as(db, U.hodCse, `UPDATE public.programmes SET name = 'QA M.Tech Computer Science' WHERE id = $1`, [id])).rows).toBe(1);
    expect(await scalar(db, `SELECT count(*)::int FROM public.audit_logs WHERE table_name = 'programmes' AND record_id = $1`, [id])).toBe(2);

    // No delete for the HOD, and no move to another department.
    await as(db, U.hodCse, `DELETE FROM public.programmes WHERE id = $1`, [id]);
    expect(await scalar(db, `SELECT count(*)::int FROM public.programmes WHERE id = $1`, [id])).toBe(1);
    expect((await as(db, U.hodCse, `UPDATE public.programmes SET department_id = $1 WHERE id = $2`, [DEPT_ECE, id])).ok).toBe(false);
  });

  it("another department's programme is out of reach; academic years and terms stay Admin/Director", async () => {
    expect((await as(db, U.hodCse, `INSERT INTO public.programmes (college_id, department_id, name, code) VALUES ($1, $2, 'X', 'QA-X')`, [COLLEGE_A, DEPT_ECE])).ok).toBe(false);
    expect((await as(db, U.hodCse, `UPDATE public.programmes SET name = 'hijacked' WHERE id = $1`, [PROG_ECE])).rows).toBe(0);
    expect((await as(db, U.hodCse, `UPDATE public.semesters SET name = 'renamed' WHERE id = $1`, [SEM_3])).rows).toBe(0);
    expect((await as(db, U.hodCse, `INSERT INTO public.academic_years (college_id, name) VALUES ($1, 'QA 2027-28')`, [COLLEGE_A])).ok).toBe(false);
  });

  it("history-bearing structure is protected: duration, section re-parenting, deactivation, deletion", async () => {
    expect((await placeStudent(db, U.hodCse, S.a, SEC.cseA)).ok).toBe(true); // a semester-3 student
    expect((await as(db, U.hodCse, `UPDATE public.programmes SET duration_semesters = 2 WHERE id = $1`, [PROG_CSE])).error).toMatch(/cannot be shorter/);
    expect((await as(db, U.hodCse, `UPDATE public.sections SET batch_year = 2025 WHERE id = $1`, [SEC.cseA])).error).toMatch(/cannot change its programme or batch year/);
    expect((await as(db, U.hodCse, `UPDATE public.sections SET status = 'inactive' WHERE id = $1`, [SEC.cseA])).error).toMatch(/current students/);
    expect((await as(db, U.admin, `DELETE FROM public.sections WHERE id = $1`, [SEC.cseB])).ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
describe("HOD replacement changes responsibility, not configuration", () => {
  let db: PGlite;
  beforeAll(async () => { db = await stagingDb(); });
  afterAll(async () => { await db?.close(); });

  const fingerprint = (d: PGlite) => scalar(d, `SELECT md5(string_agg(t, '|' ORDER BY t)) FROM (
      SELECT 'p' || to_jsonb(p)::text t FROM public.programmes p
      UNION ALL SELECT 's' || to_jsonb(s)::text FROM public.sections s
      UNION ALL SELECT 'c' || to_jsonb(c)::text FROM public.courses c
      UNION ALL SELECT 'o' || (to_jsonb(o) - 'updated_at')::text FROM public.course_offerings o
      UNION ALL SELECT 'e' || to_jsonb(e)::text FROM public.course_enrollments e
      UNION ALL SELECT 'y' || to_jsonb(y)::text FROM public.academic_years y
      UNION ALL SELECT 'm' || (to_jsonb(m) - 'updated_at')::text FROM public.semesters m) x`);

  it("HOD A -> HOD B: B inherits the existing configuration, A loses it, nothing is recreated", async () => {
    expect((await assignIncharge(db, U.hodCse, SEC.cseA, U.teacherA)).ok).toBe(true);
    const before = await fingerprint(db);

    const swap = await as(db, U.director, `UPDATE public.departments SET hod_id = $1 WHERE id = $2`, [U.hodEce, DEPT_CSE]);
    expect(swap.rows).toBe(1);
    expect(await fingerprint(db)).toBe(before);

    const hist = await verify<{ hod_id: string; ended_at: string | null }>(db,
      `SELECT hod_id, ended_at FROM public.department_hod_assignments WHERE department_id = $1 ORDER BY started_at, ended_at NULLS LAST`, [DEPT_CSE]);
    expect(hist.map((h) => [h.hod_id, h.ended_at === null])).toEqual([[U.hodCse, false], [U.hodEce, true]]);

    // The new HOD acts on the existing structure at once...
    expect((await assignIncharge(db, U.hodEce, SEC.cseA, U.teacherB)).ok).toBe(true);
    expect((await as(db, U.hodEce, `UPDATE public.programmes SET name = 'QA B.Tech CSE (renamed by new HOD)' WHERE id = $1`, [PROG_CSE])).rows).toBe(1);
    // ...and the old HOD can no longer touch it, by function or directly.
    expect((await assignIncharge(db, U.hodCse, SEC.cseA, U.teacherC)).error).toMatch(/Only the HOD/);
    expect((await rpc(db, U.hodCse, `SELECT public.department_term_readiness($1)`, [DEPT_CSE])).ok).toBe(false);
    expect((await as(db, U.hodCse, `UPDATE public.programmes SET name = 'old HOD edit' WHERE id = $1`, [PROG_CSE])).rows).toBe(0);
    expect((await as(db, U.hodCse, `UPDATE public.course_offerings SET max_students = 1 WHERE id = $1`, [OFF.dsA3])).rows).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
describe("student invitations: placement, acceptance, and defects 1 and 3", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await stagingDb();
    expect((await assignIncharge(db, U.hodCse, SEC.cseA, U.teacherA)).ok).toBe(true);
  });
  afterAll(async () => { await db?.close(); });

  let n = 0;
  /** An invited account exactly as inviteUserCore leaves it: auth user, pending student profile with the RESOLVED department. */
  async function invitee(): Promise<string> {
    n += 1;
    const id = `00000099-0000-4000-8000-${String(n).padStart(12, "0")}`;
    await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, jsonb_build_object('full_name', 'Invitee ' || $3::text, 'college_id', $4::text))`,
      [id, `invitee${n}@qa.test`, n, COLLEGE_A]);
    await db.query(`UPDATE public.profiles SET role = 'student', status = 'pending', department_id = $2 WHERE id = $1`, [id, DEPT_CSE]);
    return id;
  }
  async function invite(inviter: string, user: string, section: string, enrollment: string, semester = 3) {
    const inv = await as(db, inviter, `INSERT INTO public.invitations (college_id, email, role, invited_by, user_id)
      VALUES ($1, $4, 'student', $3, $2) RETURNING id`, [COLLEGE_A, user, inviter, `${user}@invite.qa.test`]);
    if (!inv.ok) return { inv, placement: null as null | Awaited<ReturnType<typeof as>> };
    const id = inv.data[0].id as string;
    const placement = await rpc(db, inviter, `SELECT public.create_student_invitation_placement($1, $2, $3, $4) AS r`, [id, section, enrollment, semester]);
    return { inv, placement, id };
  }

  it("preflight: HOD for their department, In-Charge for their own section — nobody else", async () => {
    const pf = (actor: string, section: string, enr = "QA-NEW-001", sem = 3) =>
      rpc(db, actor, `SELECT public.student_invitation_preflight($1, $2, $3) AS r`, [section, enr, sem]);
    const hod = await pf(U.hodCse, SEC.cseB);
    expect(hod.ok, hod.error ?? "").toBe(true);
    expect((hod.data[0].r as { department_id: string }).department_id).toBe(DEPT_CSE);
    expect((await pf(U.teacherA, SEC.cseA)).ok).toBe(true);
    expect((await pf(U.teacherA, SEC.cseB)).error).toMatch(/your own section/);
    // Regression: a section with NO In-Charge used to let any teacher through (NULL is not false).
    expect((await pf(U.teacherB, SEC.cseB)).error).toMatch(/your own section/);
    expect((await pf(U.hodEce, SEC.cseA)).error).toMatch(/own department's sections/);
    expect((await pf(U.bHod, SEC.cseA)).error).toMatch(/not found/);
    expect((await pf(U.hodCse, SEC.cseA, "QA-2026-CSE-001")).error).toMatch(/already in use/);
    expect((await pf(U.hodCse, SEC.cseA, "QA-NEW-002", 9)).error).toMatch(/between 1 and 8/);
    expect((await pf(U.studentA, SEC.cseA)).error).toMatch(/Only an HOD or a Class In-Charge/);
  });

  it("the invitation tier admits a teacher only while they are a Class In-Charge", async () => {
    const u = await invitee();
    expect((await as(db, U.teacherB, `INSERT INTO public.invitations (college_id, email, role, invited_by, user_id) VALUES ($1, 'x@qa.test', 'student', $2, $3)`,
      [COLLEGE_A, U.teacherB, u])).ok).toBe(false);
    expect((await as(db, U.teacherA, `INSERT INTO public.invitations (college_id, email, role, invited_by, user_id) VALUES ($1, 'y@qa.test', 'teacher', $2, $3)`,
      [COLLEGE_A, U.teacherA, u])).ok).toBe(false);
  });

  it("acceptance creates the student, their section, their enrolments and activates them — in one step", async () => {
    const u = await invitee();
    const { placement, id } = await invite(U.teacherA, u, SEC.cseA, "QA-NEW-100", 3);
    expect(placement?.ok, placement?.error ?? "").toBe(true);
    expect(await scalar(db, `SELECT department_id FROM public.invitations WHERE id = $1`, [id])).toBe(DEPT_CSE);

    const acc = await as(db, u, `SELECT public.accept_student_invitation($1) AS r`, [id]);
    expect(acc.ok, acc.error ?? "").toBe(true);
    const r = acc.data[0].r as { student_id: string; section_id: string; enrollments_created: number };
    expect(r.section_id).toBe(SEC.cseA);
    expect(r.enrollments_created).toBe(3); // DS-A, DBMS-A, OS (all CSE-A this term)
    const st = await verify<{ department_id: string; batch_year: number; semester: number; enrollment_number: string }>(db,
      `SELECT department_id, batch_year, semester, enrollment_number FROM public.students WHERE id = $1`, [r.student_id]);
    expect(st[0]).toMatchObject({ department_id: DEPT_CSE, batch_year: 2024, semester: 3, enrollment_number: "QA-NEW-100" });
    expect(await scalar(db, `SELECT status FROM public.profiles WHERE id = $1`, [u])).toBe("active");
    expect(await scalar(db, `SELECT status FROM public.invitations WHERE id = $1`, [id])).toBe("accepted");
    expect(await scalar(db, `SELECT consumed_student_id FROM public.student_invitation_placements WHERE invitation_id = $1`, [id])).toBe(r.student_id);
    expect(await scalar(db, `SELECT count(*)::int FROM public.notifications WHERE receiver_id = $1 AND title = 'Invitation accepted'`, [U.teacherA])).toBe(1);
    expect(await scalar(db, `SELECT count(*)::int FROM public.audit_logs WHERE action = 'student_invitation.accepted' AND record_id = $1`, [id])).toBe(1);

    // Reuse is refused.
    expect((await as(db, u, `SELECT public.accept_student_invitation($1)`, [id])).ok).toBe(false);
  });

  it("refuses an expired, a revoked, and someone else's invitation", async () => {
    const u1 = await invitee();
    const a = await invite(U.hodCse, u1, SEC.cseB, "QA-NEW-201");
    await db.query(`UPDATE public.invitations SET expires_at = now() - interval '1 day' WHERE id = $1`, [a.id]);
    expect((await as(db, u1, `SELECT public.accept_student_invitation($1)`, [a.id])).error).toMatch(/expired/);

    const u2 = await invitee();
    const b = await invite(U.hodCse, u2, SEC.cseB, "QA-NEW-202");
    await as(db, U.hodCse, `UPDATE public.invitations SET status = 'revoked' WHERE id = $1`, [b.id]);
    expect((await as(db, u2, `SELECT public.accept_student_invitation($1)`, [b.id])).error).toMatch(/no longer valid/);

    const u3 = await invitee();
    const c = await invite(U.hodCse, u3, SEC.cseB, "QA-NEW-203");
    expect((await as(db, u2, `SELECT public.accept_student_invitation($1)`, [c.id])).error).toMatch(/No pending invitation/);
    // None of them produced a student.
    expect(await scalar(db, `SELECT count(*)::int FROM public.students WHERE user_id IN ($1, $2, $3)`, [u1, u2, u3])).toBe(0);
  });

  it("defect 3 and forged placement: the invitee can write neither the invitation nor its placement", async () => {
    const u = await invitee();
    const { id } = await invite(U.hodCse, u, SEC.cseB, "QA-NEW-300");
    const upd = await as(db, u, `UPDATE public.invitations SET department_id = $1, role = 'teacher', expires_at = now() + interval '1 year' WHERE id = $2`, [DEPT_ECE, id]);
    expect(upd.rows).toBe(0);
    expect(await scalar(db, `SELECT department_id FROM public.invitations WHERE id = $1`, [id])).toBe(DEPT_CSE);
    // While pending, 053's write gate already refuses them; the policy removal
    // is what stops an ACTIVE invitee (019 let them rewrite the row for good).
    await db.query(`UPDATE public.profiles SET status = 'active' WHERE id = $1`, [u]);
    const active = await as(db, u, `UPDATE public.invitations SET department_id = $1 WHERE id = $2`, [DEPT_ECE, id]);
    expect(active.rows).toBe(0);
    expect(await scalar(db, `SELECT department_id FROM public.invitations WHERE id = $1`, [id])).toBe(DEPT_CSE);
    const pl = await as(db, u, `UPDATE public.student_invitation_placements SET section_id = $1 WHERE invitation_id = $2`, [SEC.eceA, id]);
    expect(pl.rows).toBe(0);
    // Only the inviter may attach a placement, and only once.
    const u2 = await invitee();
    const other = await as(db, U.hodCse, `INSERT INTO public.invitations (college_id, email, role, invited_by, user_id) VALUES ($1, 'z@qa.test', 'student', $2, $3) RETURNING id`,
      [COLLEGE_A, U.hodCse, u2]);
    expect((await rpc(db, U.teacherA, `SELECT public.create_student_invitation_placement($1, $2, 'QA-NEW-301', 3)`, [other.data[0].id, SEC.cseA])).error).toMatch(/Invitation not found/);
    expect((await rpc(db, U.hodCse, `SELECT public.create_student_invitation_placement($1, $2, 'QA-NEW-302', 3)`, [id, SEC.cseB])).error).toMatch(/already has a placement/);
  });

  it("acceptance is refused while the college is unavailable", async () => {
    const u = await invitee();
    const { id } = await invite(U.hodCse, u, SEC.cseB, "QA-NEW-400");
    const blocked = await as(db, U.superAdmin, `SELECT public.set_college_lifecycle($1, 'MAINTENANCE', 'Scheduled maintenance window tonight')`, [COLLEGE_A]);
    expect(blocked.ok, blocked.error ?? "").toBe(true);
    try {
      expect((await as(db, u, `SELECT public.accept_student_invitation($1)`, [id])).error).toMatch(/unavailable/);
    } finally {
      expect((await as(db, U.superAdmin, `SELECT public.set_college_lifecycle($1, 'ACTIVE', 'Maintenance window finished')`, [COLLEGE_A])).ok).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────
describe("my_academic_context(): one read for web and mobile", () => {
  let db: PGlite;
  beforeAll(async () => { db = await stagingDb(); });
  afterAll(async () => { await db?.close(); });

  it("a student's term, class, section, year of study and current offerings", async () => {
    expect((await assignIncharge(db, U.hodCse, SEC.cseA, U.teacherA)).ok).toBe(true);
    expect((await placeStudent(db, U.hodCse, S.a, SEC.cseA)).ok).toBe(true);
    const r = await as(db, U.studentA, `SELECT public.my_academic_context() AS r`);
    const ctx = r.data[0].r as {
      term: { id: string }; student: { programme_semester: number };
      section: { id: string; year_of_study: number; class_incharge: { id: string } }; offering_ids: string[];
    };
    expect(ctx.term.id).toBe(SEM_3);
    expect(ctx.student.programme_semester).toBe(3);
    expect(ctx.section.id).toBe(SEC.cseA);
    expect(ctx.section.year_of_study).toBe(3); // 2026-27 intake 2024
    expect(ctx.section.class_incharge.id).toBe(U.teacherA);
    expect(ctx.offering_ids.sort()).toEqual([OFF.dsA3, OFF.dbmsA3, OFF.osHod].sort());
  });

  it("a teacher's current offerings and In-Charge sections; College B sees none of College A", async () => {
    const r = await as(db, U.teacherA, `SELECT public.my_academic_context() AS r`);
    const ctx = r.data[0].r as { offering_ids: string[]; incharge_sections: { section_id: string }[] };
    expect(ctx.incharge_sections.map((s) => s.section_id)).toEqual([SEC.cseA]);
    expect(ctx.offering_ids).toContain(OFF.dsA3);
    expect(ctx.offering_ids).not.toContain(OFF.historical);
    const b = await as(db, U.bTeacher, `SELECT public.my_academic_context() AS r`);
    expect((b.data[0].r as { offering_ids: string[] }).offering_ids).toEqual([OFF.collegeB]);
    expect(COLLEGE_B).toBeTruthy();
  });
});
