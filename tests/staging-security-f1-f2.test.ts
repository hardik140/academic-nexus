import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  stagingDb,
  applyFullChain,
  as,
  verify,
  scalar,
  U,
  S,
  OFF,
  COLLEGE_A,
  COLLEGE_B,
  COURSE_DS,
  COURSE_MATHS,
  SEM_5,
  DATE,
} from "./staging/harness";

/**
 * Remediation of F1 and F2, verified against real PostgreSQL RLS.
 *
 * F1 — course_offerings_manage (046) was role + tenancy, so an HOD could
 * reassign an offering in a department they do not head, name themselves
 * instructor, and thereby acquire attendance and marks authority over
 * another department's class.
 *
 * F2 — attendance_correction_requests duplicates five columns from the
 * attendance row it names, and nothing tied the copy to the original, so a
 * request could describe a different offering, student or date than the
 * record it points at.
 *
 * Both fixes live in migration 047, which is still unapplied. 046 is already
 * applied to the real database and cannot be edited, and a later migration
 * would leave the hole open for the entire window between the two — the same
 * reasoning that put the C1 fix in 047 rather than in a follow-up.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

const MIGRATION = join(process.cwd(), "supabase/migrations/047_academic_transactions_on_offerings.sql");

let db: PGlite;

beforeAll(async () => {
  db = await stagingDb();
});

afterAll(async () => {
  await db?.close();
});

async function fresh(): Promise<PGlite> {
  return stagingDb();
}

// ══════════════════════════════════════════════════════════════
// PHASE 4 — which department owns an offering
// ══════════════════════════════════════════════════════════════

describe("the authoritative department relationship", () => {
  it("the service course really does have two different departments", async () => {
    const [row] = await verify<{ teaching: string; receiving: string }>(
      db,
      `SELECT c.department_id AS teaching, p.department_id AS receiving
         FROM course_offerings o
         JOIN courses c    ON c.id = o.course_id
         JOIN sections sec ON sec.id = o.section_id
         JOIN programmes p ON p.id = sec.programme_id
        WHERE o.id = $1`,
      [OFF.service]
    );
    // Engineering Mathematics is owned by Mechanical and delivered to a CSE
    // section. If these were equal the tests below would prove nothing.
    expect(row.teaching).not.toBe(row.receiving);
  });

  it("scope follows the TEACHING department, not the receiving one", async () => {
    // HOD-MECH owns the course; HOD-CSE owns the students.
    expect((await as(db, U.hodMech, `SELECT public.heads_offering_department('${OFF.service}') AS v`)).data[0].v).toBe(true);
    expect((await as(db, U.hodCse, `SELECT public.heads_offering_department('${OFF.service}') AS v`)).data[0].v).toBe(false);
  });

  it("heads_offering_department and heads_course_department agree everywhere", async () => {
    // One definition of "an HOD's department scope". If these ever disagree,
    // the offering-management policy and the review policies have drifted.
    for (const uid of [U.hodCse, U.hodEce, U.hodMech, U.teacherA, U.admin]) {
      const rows = await as(
        db,
        uid,
        `SELECT o.id,
                public.heads_offering_department(o.id) AS via_offering,
                public.heads_course_department(o.course_id) AS via_course
           FROM public.course_offerings o ORDER BY o.id`
      );
      expect(rows.data.length).toBeGreaterThan(0);
      for (const r of rows.data) {
        expect(r.via_offering, `disagreement on ${r.id} for ${uid}`).toBe(r.via_course);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════
// PHASE 5 — F1 test matrix
// ══════════════════════════════════════════════════════════════

describe("F1 — offering management", () => {
  it("F1.1 HOD cannot take an offering in a department they do not head", async () => {
    const d = await fresh();
    try {
      const r = await as(
        d,
        U.hodCse,
        `UPDATE public.course_offerings SET instructor_id = auth.uid() WHERE id='${OFF.ece}'`
      );
      // Silent denial: USING matches nothing, so no error and no rows.
      expect(r.ok).toBe(true);
      expect(r.rows).toBe(0);
      expect(
        await scalar(d, `SELECT instructor_id FROM course_offerings WHERE id=$1`, [OFF.ece])
      ).toBe(U.teacherC);
    } finally {
      await d.close();
    }
  });

  it("F1.2 HOD CAN manage an offering in their own department", async () => {
    const d = await fresh();
    try {
      // 046 granted HODs offering management; the fix scopes it, it does not
      // remove it. Assigning staff within your own department is the
      // legitimate half of that grant.
      const r = await as(
        d,
        U.hodCse,
        `UPDATE public.course_offerings SET instructor_id = '${U.teacherB}' WHERE id='${OFF.dsA3}'`
      );
      expect(r.rows).toBe(1);
      expect(
        await scalar(d, `SELECT instructor_id FROM course_offerings WHERE id=$1`, [OFF.dsA3])
      ).toBe(U.teacherB);
    } finally {
      await d.close();
    }
  });

  it("F1.3 HOD cannot assign anyone at all to another department's offering", async () => {
    const d = await fresh();
    try {
      const r = await as(
        d,
        U.hodCse,
        `UPDATE public.course_offerings SET instructor_id = '${U.teacherA}' WHERE id='${OFF.ece}'`
      );
      expect(r.rows).toBe(0);
      expect(
        await scalar(d, `SELECT instructor_id FROM course_offerings WHERE id=$1`, [OFF.ece])
      ).toBe(U.teacherC);
    } finally {
      await d.close();
    }
  });

  it("F1.4 a maximally greedy raw statement is scoped, never refused wholesale", async () => {
    const d = await fresh();
    try {
      // No application code writes course_offerings at all, so a raw
      // statement IS the only path — which is why RLS had to be the fix.
      //
      // An unfiltered UPDATE is the sharpest version of the question. It does
      // NOT fail; RLS is a filter, not a gate, so it silently narrows to the
      // rows the caller may touch. What matters is exactly which rows those
      // are.
      const blanket = await as(d, U.hodCse, `UPDATE public.course_offerings SET instructor_id=auth.uid()`);
      expect(blanket.ok).toBe(true);

      const taken = await verify<{ id: string }>(
        d,
        `SELECT id FROM course_offerings WHERE instructor_id=$1 ORDER BY id`,
        [U.hodCse]
      );
      // Every CSE-owned offering, and nothing else. Self-assignment inside
      // your own department is the legitimate half of the grant 046 made
      // (F1.2); crossing a department is the half this fix closes.
      const takenIds = taken.map((r) => r.id);
      expect(takenIds).not.toContain(OFF.ece);       // Electronics
      expect(takenIds).not.toContain(OFF.service);   // Mechanical, CSE students
      expect(takenIds).not.toContain(OFF.cancelled); // Mechanical
      expect(takenIds).not.toContain(OFF.collegeB);  // another tenant

      // and those rows still carry their original instructors
      expect(await scalar(d, `SELECT instructor_id FROM course_offerings WHERE id=$1`, [OFF.ece])).toBe(U.teacherC);
      expect(await scalar(d, `SELECT instructor_id FROM course_offerings WHERE id=$1`, [OFF.service])).toBe(U.teacherC);
      expect(await scalar(d, `SELECT instructor_id FROM course_offerings WHERE id=$1`, [OFF.collegeB])).toBe(U.bTeacher);
    } finally {
      await d.close();
    }
  });

  it("F1.4b a targeted statement against another department is a no-op", async () => {
    const d = await fresh();
    try {
      for (const sql of [
        `UPDATE public.course_offerings SET instructor_id=auth.uid() WHERE id='${OFF.ece}'`,
        `UPDATE public.course_offerings SET instructor_id=auth.uid() WHERE id='${OFF.service}'`,
        `DELETE FROM public.course_offerings WHERE id='${OFF.ece}'`,
      ]) {
        const r = await as(d, U.hodCse, sql);
        expect(r.rows, sql).toBe(0);
      }
      expect(await scalar(d, `SELECT count(*)::int FROM course_offerings WHERE id=$1`, [OFF.ece])).toBe(1);
    } finally {
      await d.close();
    }
  });

  it("F1.5 a teacher cannot modify any offering", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.teacherA, `UPDATE public.course_offerings SET instructor_id=auth.uid() WHERE id='${OFF.dsB3}'`)).rows).toBe(0);
      expect((await as(d, U.teacherA, `UPDATE public.course_offerings SET instructor_id=auth.uid() WHERE id='${OFF.dsA3}'`)).rows).toBe(0);
      const ins = await as(
        d,
        U.teacherA,
        `INSERT INTO public.course_offerings (college_id, semester_id, course_id, section_id, instructor_id, status)
           VALUES ('${COLLEGE_A}','${SEM_5}','${COURSE_DS}','00000008-0000-4000-8000-000000000004',auth.uid(),'active')`
      );
      expect(ins.ok).toBe(false);
      expect(await scalar(d, `SELECT instructor_id FROM course_offerings WHERE id=$1`, [OFF.dsB3])).toBe(U.teacherB);
    } finally {
      await d.close();
    }
  });

  it("F1.6 director keeps the college-wide authority 046 granted them", async () => {
    const d = await fresh();
    try {
      // Preserved deliberately. 046 named director explicitly, and narrowing
      // it would be inventing a rule rather than enforcing the existing one.
      const r = await as(
        d,
        U.director,
        `UPDATE public.course_offerings SET instructor_id='${U.teacherA}' WHERE id='${OFF.ece}'`
      );
      expect(r.rows).toBe(1);
    } finally {
      await d.close();
    }
  });

  it("RESIDUAL: a director can still self-assign and gain academic write", async () => {
    const d = await fresh();
    try {
      // Reported, not silently fixed. A director otherwise holds read-only
      // oversight of academic records; naming themselves instructor converts
      // that into write authority. It is narrower than F1 — director is an
      // institution-wide role, not a departmental one, so no scope boundary
      // is crossed — but it is the same shape and belongs in the report.
      expect((await as(d, U.director, `UPDATE public.course_offerings SET instructor_id=auth.uid() WHERE id='${OFF.dsA3}'`)).rows).toBe(1);
      const write = await as(
        d,
        U.director,
        `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
           VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.a}','${DATE}','present',auth.uid())`
      );
      expect(write.ok).toBe(true);
    } finally {
      await d.close();
    }
  });

  it("HOD cannot create an offering outside their department", async () => {
    const d = await fresh();
    try {
      const r = await as(
        d,
        U.hodCse,
        `INSERT INTO public.course_offerings (college_id, semester_id, course_id, section_id, instructor_id, status)
           VALUES ('${COLLEGE_A}','${SEM_5}','${COURSE_MATHS}','00000008-0000-4000-8000-000000000004',auth.uid(),'active')`
      );
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/row-level security/i);
    } finally {
      await d.close();
    }
  });

  it("HOD can create one inside their department", async () => {
    const d = await fresh();
    try {
      const r = await as(
        d,
        U.hodCse,
        `INSERT INTO public.course_offerings (college_id, semester_id, course_id, section_id, instructor_id, status)
           VALUES ('${COLLEGE_A}','${SEM_5}','${COURSE_DS}','00000008-0000-4000-8000-000000000002',auth.uid(),'active')`
      );
      expect(r.error).toBeNull();
    } finally {
      await d.close();
    }
  });

  it("WITH CHECK: HOD cannot walk an offering out of their department", async () => {
    const d = await fresh();
    try {
      // USING passes — OFF.dsA3 is a CSE offering and HOD-CSE heads CSE.
      // Only WITH CHECK stops the resulting row from landing in Mechanical.
      const r = await as(
        d,
        U.hodCse,
        `UPDATE public.course_offerings SET course_id='${COURSE_MATHS}' WHERE id='${OFF.dsA3}'`
      );
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/row-level security/i);
      expect(await scalar(d, `SELECT course_id FROM course_offerings WHERE id=$1`, [OFF.dsA3])).toBe(COURSE_DS);
    } finally {
      await d.close();
    }
  });

  it("a HOD cannot reach another college's offerings at all", async () => {
    const d = await fresh();
    try {
      const r = await as(d, U.hodCse, `UPDATE public.course_offerings SET instructor_id=auth.uid() WHERE id='${OFF.collegeB}'`);
      expect(r.rows).toBe(0);
      expect(await scalar(d, `SELECT instructor_id FROM course_offerings WHERE id=$1`, [OFF.collegeB])).toBe(U.bTeacher);
    } finally {
      await d.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════
// PHASE 8 — the security invariant, end to end
// ══════════════════════════════════════════════════════════════

describe("Phase 8 — authority cannot be manufactured", () => {
  it("the full escalation chain is broken at its first step", async () => {
    const d = await fresh();
    try {
      const before = await scalar(d, `SELECT instructor_id FROM course_offerings WHERE id=$1`, [OFF.ece]);

      // 1. try to become the instructor of another department's offering
      const grab = await as(d, U.hodCse, `UPDATE public.course_offerings SET instructor_id=auth.uid() WHERE id='${OFF.ece}'`);
      expect(grab.rows).toBe(0);

      // 2. the record that authorises is unchanged
      expect(await scalar(d, `SELECT instructor_id FROM course_offerings WHERE id=$1`, [OFF.ece])).toBe(before);

      // 3. so the authority predicate still says no
      expect((await as(d, U.hodCse, `SELECT public.can_write_offering_records('${OFF.ece}') AS v`)).data[0].v).toBe(false);

      // 4. and the write it was for is refused
      const att = await as(
        d,
        U.hodCse,
        `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
           VALUES ('${COLLEGE_A}','${OFF.ece}','${S.a}','${DATE}','present',auth.uid())`
      );
      expect(att.ok).toBe(false);
      const marks = await as(
        d,
        U.hodCse,
        `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks, entered_by)
           VALUES ('${COLLEGE_A}','${OFF.ece}','${S.a}','internal_1',100,90,auth.uid())`
      );
      expect(marks.ok).toBe(false);

      // 5. nothing landed
      expect(await scalar(d, `SELECT count(*)::int FROM attendance WHERE offering_id=$1`, [OFF.ece])).toBe(0);
      expect(await scalar(d, `SELECT count(*)::int FROM marks WHERE offering_id=$1`, [OFF.ece])).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("the same chain via the service course, where the students are theirs", async () => {
    const d = await fresh();
    try {
      // HOD-CSE's own students sit in this class, which is the most
      // plausible-looking version of the attack. The course is Mechanical's.
      expect((await as(d, U.hodCse, `UPDATE public.course_offerings SET instructor_id=auth.uid() WHERE id='${OFF.service}'`)).rows).toBe(0);
      expect((await as(d, U.hodCse, `SELECT public.can_write_offering_records('${OFF.service}') AS v`)).data[0].v).toBe(false);
      const att = await as(
        d,
        U.hodCse,
        `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
           VALUES ('${COLLEGE_A}','${OFF.service}','${S.a}','${DATE}','present',auth.uid())`
      );
      expect(att.ok).toBe(false);
    } finally {
      await d.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════
// PHASE 7 — F2 test matrix
// ══════════════════════════════════════════════════════════════

describe("F2 — correction request consistency", () => {
  async function withAttendance(d: PGlite, offering = OFF.dsA3, student = S.a, uid = U.teacherA) {
    await as(
      d,
      uid,
      `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
         VALUES ('${COLLEGE_A}','${offering}','${student}','${DATE}','absent',auth.uid())`
    );
    return String(
      await scalar(d, `SELECT id FROM attendance WHERE offering_id=$1 AND student_id=$2`, [offering, student])
    );
  }

  const request = (attId: string, opts: Partial<{ offering: string; student: string; date: string; college: string }> = {}) =>
    `INSERT INTO public.attendance_correction_requests
       (college_id, attendance_id, student_id, offering_id, date, current_status, requested_status, reason, submitted_by)
     VALUES ('${opts.college ?? COLLEGE_A}','${attId}','${opts.student ?? S.a}','${opts.offering ?? OFF.dsA3}',
             '${opts.date ?? DATE}','absent','present','QA', auth.uid())`;

  it("VALID: a request whose context matches the attendance row is accepted", async () => {
    const d = await fresh();
    try {
      const attId = await withAttendance(d);
      const r = await as(d, U.teacherA, request(attId));
      expect(r.error).toBeNull();
      expect(await scalar(d, `SELECT count(*)::int FROM attendance_correction_requests`)).toBe(1);
    } finally {
      await d.close();
    }
  });

  it("INVALID: a mismatched offering_id is refused, and nothing lands", async () => {
    const d = await fresh();
    try {
      const attId = await withAttendance(d);
      const r = await as(d, U.teacherA, request(attId, { offering: OFF.ece }));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/foreign key|violates/i);
      expect(await scalar(d, `SELECT count(*)::int FROM attendance_correction_requests`)).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("INVALID: a mismatched student_id is refused", async () => {
    const d = await fresh();
    try {
      const attId = await withAttendance(d);
      const r = await as(d, U.teacherA, request(attId, { student: S.b }));
      expect(r.ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM attendance_correction_requests`)).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("INVALID: a mismatched date is refused", async () => {
    const d = await fresh();
    try {
      const attId = await withAttendance(d);
      const r = await as(d, U.teacherA, request(attId, { date: "2026-09-11" }));
      expect(r.ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM attendance_correction_requests`)).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("CROSS-COLLEGE: a request declaring another college is refused", async () => {
    const d = await fresh();
    try {
      const attId = await withAttendance(d);
      const r = await as(d, U.teacherA, request(attId, { college: COLLEGE_B }));
      expect(r.ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM attendance_correction_requests`)).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("the constraint holds against UPDATE too, not only INSERT", async () => {
    const d = await fresh();
    try {
      const attId = await withAttendance(d);
      await as(d, U.teacherA, request(attId));
      // A request that was consistent when filed cannot be edited into an
      // inconsistent one afterwards.
      const r = await as(
        d,
        U.hodCse,
        `UPDATE public.attendance_correction_requests SET offering_id='${OFF.ece}'`
      );
      expect(r.ok).toBe(false);
      expect(await scalar(d, `SELECT offering_id FROM attendance_correction_requests`)).toBe(OFF.dsA3);
    } finally {
      await d.close();
    }
  });

  it("OWNERSHIP is unchanged: submitted_by must still be the caller", async () => {
    const d = await fresh();
    try {
      const attId = await withAttendance(d);
      const r = await as(
        d,
        U.teacherA,
        `INSERT INTO public.attendance_correction_requests
           (college_id, attendance_id, student_id, offering_id, date, current_status, requested_status, reason, submitted_by)
         VALUES ('${COLLEGE_A}','${attId}','${S.a}','${OFF.dsA3}','${DATE}','absent','present','QA','${U.teacherB}')`
      );
      expect(r.ok).toBe(false);
    } finally {
      await d.close();
    }
  });

  it("HOD REVIEW scope is unchanged: only the owning department may approve", async () => {
    const d = await fresh();
    try {
      const attId = await withAttendance(d);
      await as(d, U.teacherA, request(attId));
      const reqId = String(await scalar(d, `SELECT id FROM attendance_correction_requests`));

      expect((await as(d, U.hodEce, `UPDATE public.attendance_correction_requests SET status='approved', reviewed_by=auth.uid() WHERE id='${reqId}'`)).rows).toBe(0);
      expect((await as(d, U.hodMech, `UPDATE public.attendance_correction_requests SET status='approved', reviewed_by=auth.uid() WHERE id='${reqId}'`)).rows).toBe(0);
      expect((await as(d, U.hodCse, `UPDATE public.attendance_correction_requests SET status='approved', reviewed_by=auth.uid() WHERE id='${reqId}'`)).rows).toBe(1);
    } finally {
      await d.close();
    }
  });

  it("SELF-APPROVAL is still denied", async () => {
    const d = await fresh();
    try {
      const attId = await withAttendance(d);
      // HOD-CSE files it themselves on Teacher A's offering, then approves.
      await as(d, U.hodCse, request(attId));
      const reqId = String(await scalar(d, `SELECT id FROM attendance_correction_requests`));
      await as(d, U.hodCse, `UPDATE public.attendance_correction_requests SET status='approved', reviewed_by=auth.uid() WHERE id='${reqId}'`);

      const applied = await as(d, U.hodCse, `UPDATE public.attendance SET status='present' WHERE id='${attId}'`);
      expect(applied.rows).toBe(0);
      expect(await scalar(d, `SELECT status FROM attendance WHERE id=$1`, [attId])).toBe("absent");
    } finally {
      await d.close();
    }
  });

  it("the approved-correction path still works end to end", async () => {
    const d = await fresh();
    try {
      const attId = await withAttendance(d);
      await as(d, U.teacherA, request(attId));
      const reqId = String(await scalar(d, `SELECT id FROM attendance_correction_requests`));
      expect((await as(d, U.hodCse, `UPDATE public.attendance_correction_requests SET status='approved', reviewed_by=auth.uid() WHERE id='${reqId}'`)).rows).toBe(1);
      expect((await as(d, U.hodCse, `UPDATE public.attendance SET status='present' WHERE id='${attId}'`)).rows).toBe(1);
      expect(await scalar(d, `SELECT status FROM attendance WHERE id=$1`, [attId])).toBe("present");
    } finally {
      await d.close();
    }
  });

  it("deleting the attendance row still cascades the request away", async () => {
    const d = await fresh();
    try {
      const attId = await withAttendance(d);
      await as(d, U.teacherA, request(attId));
      // The composite FK replaced 037's single-column one; ON DELETE CASCADE
      // has to have survived the swap.
      await verify(d, `DELETE FROM public.attendance WHERE id=$1`, [attId]);
      expect(await scalar(d, `SELECT count(*)::int FROM attendance_correction_requests`)).toBe(0);
    } finally {
      await d.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════
// PHASE 9 — mutation testing
// ══════════════════════════════════════════════════════════════

describe("mutation resistance", () => {
  function loadMigration(): string {
    return readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n");
  }

  /**
   * Rebuilds the whole database with one deliberate weakening applied to the
   * migration text, and returns it.
   *
   * A mutation whose pattern no longer matches THROWS rather than applying
   * the unmodified file. Silently running the correct SQL would make the
   * test assert that a defect is absent from a migration the defect was
   * never introduced into — a pass that proves nothing.
   */
  async function mutated(label: string, mutate: (sql: string) => string): Promise<PGlite> {
    const original = loadMigration();
    const changed = mutate(original);
    if (changed === original) {
      throw new Error(
        `Mutation "${label}" did not change the migration — its pattern no longer matches. ` +
          `Update the pattern; do not leave it silently inert.`
      );
    }

    const db = new PGlite();
    const files = (await import("node:fs")).readdirSync(join(process.cwd(), "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    await db.exec(readFileSync(join(process.cwd(), "tests/staging/platform.sql"), "utf8").replace(/\r\n/g, "\n"));
    for (const f of files) {
      const sql =
        f === "047_academic_transactions_on_offerings.sql"
          ? changed
          : readFileSync(join(process.cwd(), "supabase/migrations", f), "utf8").replace(/\r\n/g, "\n");
      await db.exec(sql);
    }
    await db.exec(readFileSync(join(process.cwd(), "tests/staging/qa-dataset.sql"), "utf8").replace(/\r\n/g, "\n"));
    return db;
  }

  it("detects: HOD department predicate removed from course_offerings_manage", async () => {
    const d = await mutated("drop hod predicate", (sql) =>
      sql.replace(
        /public\.get_my_role\(\) = 'hod'\s*\n\s*AND public\.heads_course_department\(course_id\)/g,
        "public.get_my_role() = 'hod'"
      )
    );
    try {
      // With the predicate gone this is 046's hole again.
      const r = await as(d, U.hodCse, `UPDATE public.course_offerings SET instructor_id=auth.uid() WHERE id='${OFF.ece}'`);
      expect(r.rows, "mutation was not detected — the escalation is open").toBe(1);
    } finally {
      await d.close();
    }
  });

  it("detects: the new-row check neutralised, letting an offering be walked out of scope", async () => {
    // NOT "WITH CHECK deleted". Postgres falls back to USING for the new row
    // when WITH CHECK is absent, so deleting the clause is inert and a
    // mutation built that way would pass while proving nothing. Replacing it
    // with `true` is what actually disables the new-row check.
    const d = await mutated("neutralise new-row check", (sql) => {
      const createAt = sql.indexOf('CREATE POLICY "course_offerings_manage"');
      const wcAt = sql.indexOf("WITH CHECK (", createAt);
      if (wcAt === -1) return sql;
      const end = sql.indexOf(";", wcAt);
      return sql.slice(0, wcAt) + "WITH CHECK (true)" + sql.slice(end);
    });
    try {
      // USING still guards the OLD row, so the cross-department grab stays
      // blocked — but moving one of their own offerings into Mechanical,
      // taking its records with it, opens up.
      const r = await as(d, U.hodCse, `UPDATE public.course_offerings SET course_id='${COURSE_MATHS}' WHERE id='${OFF.dsA3}'`);
      expect(r.rows, "mutation was not detected — the new-row check is doing nothing").toBe(1);
      expect(await scalar(d, `SELECT course_id FROM course_offerings WHERE id=$1`, [OFF.dsA3])).toBe(COURSE_MATHS);
    } finally {
      await d.close();
    }
  });

  it("removing WITH CHECK entirely is inert — USING covers the new row", async () => {
    // Recorded as a fact about Postgres, not as a security property. It is
    // the reason the mutation above is written the way it is.
    const d = await mutated("delete WITH CHECK clause", (sql) => {
      const createAt = sql.indexOf('CREATE POLICY "course_offerings_manage"');
      const wcAt = sql.indexOf("WITH CHECK (", createAt);
      if (wcAt === -1) return sql;
      const end = sql.indexOf(";", wcAt);
      return sql.slice(0, wcAt) + sql.slice(end);
    });
    try {
      const r = await as(d, U.hodCse, `UPDATE public.course_offerings SET course_id='${COURSE_MATHS}' WHERE id='${OFF.dsA3}'`);
      expect(r.rows).toBe(0);
      expect(await scalar(d, `SELECT course_id FROM course_offerings WHERE id=$1`, [OFF.dsA3])).toBe(COURSE_DS);
    } finally {
      await d.close();
    }
  });

  it("detects: 046's broad course_offerings_manage restored", async () => {
    const d = await mutated("restore 046 policy", (sql) => {
      const start = sql.indexOf('DROP POLICY IF EXISTS "course_offerings_manage" ON public.course_offerings;');
      if (start === -1) return sql;
      const createAt = sql.indexOf('CREATE POLICY "course_offerings_manage"', start);
      const end = sql.indexOf(";", sql.indexOf("WITH CHECK (", createAt));
      return (
        sql.slice(0, createAt) +
        `CREATE POLICY "course_offerings_manage" ON public.course_offerings
  FOR ALL USING (
    college_id = public.get_my_college_id()
    AND public.get_my_role() IN ('admin', 'director', 'hod')
  )` +
        sql.slice(end)
      );
    });
    try {
      const r = await as(d, U.hodCse, `UPDATE public.course_offerings SET instructor_id=auth.uid() WHERE id='${OFF.ece}'`);
      expect(r.rows, "mutation was not detected").toBe(1);
      // And the escalation completes. Migration 051 added an independent
      // enrolment-binding guard (P3-8) on attendance, so to isolate the
      // control THIS test targets — course_offerings_manage — the student is
      // first enrolled in the offering via the owner path. With that second
      // lock satisfied, a successful write proves the offering-manage weakening
      // alone reopened the escalation.
      await d.exec(
        `INSERT INTO public.course_enrollments (college_id, offering_id, student_id, status)
           VALUES ('${COLLEGE_A}','${OFF.ece}','${S.a}','enrolled')`
      );
      const att = await as(
        d,
        U.hodCse,
        `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
           VALUES ('${COLLEGE_A}','${OFF.ece}','${S.a}','${DATE}','present',auth.uid())`
      );
      expect(att.ok).toBe(true);
    } finally {
      await d.close();
    }
  });

  it("detects: correction offering consistency dropped from the composite key", async () => {
    const d = await mutated("drop offering from composite FK", (sql) =>
      sql
        .replace(
          "UNIQUE (id, college_id, offering_id, student_id, date);",
          "UNIQUE (id, college_id, student_id, date);"
        )
        .replace(
          "FOREIGN KEY (attendance_id, college_id, offering_id, student_id, date)\n  REFERENCES public.attendance (id, college_id, offering_id, student_id, date)",
          "FOREIGN KEY (attendance_id, college_id, student_id, date)\n  REFERENCES public.attendance (id, college_id, student_id, date)"
        )
    );
    try {
      await as(
        d,
        U.teacherA,
        `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
           VALUES ('${COLLEGE_A}','${OFF.dsA3}','${S.a}','${DATE}','absent',auth.uid())`
      );
      const attId = String(await scalar(d, `SELECT id FROM attendance WHERE offering_id=$1`, [OFF.dsA3]));
      const r = await as(
        d,
        U.teacherA,
        `INSERT INTO public.attendance_correction_requests
           (college_id, attendance_id, student_id, offering_id, date, current_status, requested_status, reason, submitted_by)
         VALUES ('${COLLEGE_A}','${attId}','${S.a}','${OFF.ece}','${DATE}','absent','present','QA',auth.uid())`
      );
      expect(r.ok, "mutation was not detected — mismatched offering accepted").toBe(true);
    } finally {
      await d.close();
    }
  });

  it("detects: the correction/attendance relationship removed entirely", async () => {
    const d = await mutated("drop composite FK", (sql) =>
      sql.replace(
        /ALTER TABLE public\.attendance_correction_requests\n  ADD CONSTRAINT attendance_correction_requests_attendance_context_fkey[\s\S]*?ON DELETE CASCADE;/,
        "-- mutation: constraint removed"
      )
    );
    try {
      const r = await verify<{ n: number }>(
        d,
        `SELECT count(*)::int AS n FROM pg_constraint
          WHERE conname='attendance_correction_requests_attendance_context_fkey'`
      );
      expect(r[0].n, "mutation was not detected").toBe(0);

      // With the FK gone, a request can point at an attendance row that does
      // not exist at all.
      const bad = await as(
        d,
        U.teacherA,
        `INSERT INTO public.attendance_correction_requests
           (college_id, attendance_id, student_id, offering_id, date, current_status, requested_status, reason, submitted_by)
         VALUES ('${COLLEGE_A}','0000000b-0000-4000-8000-0000000000ff','${S.a}','${OFF.dsA3}','${DATE}','absent','present','QA',auth.uid())`
      );
      expect(bad.ok).toBe(true);
    } finally {
      await d.close();
    }
  });

  it("detects: heads_course_department widened to ignore the HOD assignment", async () => {
    const d = await mutated("widen department predicate", (sql) =>
      sql.replace(
        `    FROM public.courses c
    JOIN public.departments d ON d.id = c.department_id
    WHERE c.id = p_course_id
      AND d.hod_id = auth.uid()`,
        `    FROM public.courses c
    JOIN public.departments d ON d.id = c.department_id
    WHERE c.id = p_course_id`
      )
    );
    try {
      const r = await as(d, U.hodCse, `UPDATE public.course_offerings SET instructor_id=auth.uid() WHERE id='${OFF.ece}'`);
      expect(r.rows, "mutation was not detected").toBe(1);
    } finally {
      await d.close();
    }
  });
});
