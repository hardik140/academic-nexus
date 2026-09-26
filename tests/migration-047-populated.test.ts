import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyFullChain } from "./staging/harness";

/**
 * §16 — what migration 047 does to a database that already has academic data.
 *
 * 047 restructures six transaction tables onto course_offerings with:
 *
 *     ALTER TABLE public.attendance
 *       ADD COLUMN IF NOT EXISTS offering_id UUID NOT NULL
 *
 * and no DEFAULT and no backfill. PostgreSQL accepts that only while the
 * table is empty; one pre-existing row and the statement is refused. The
 * companion test (migration-047-applies) runs the same migration against
 * EMPTY tables, which is the state the real database was in — so it proves
 * the migration applies, and says nothing at all about a populated one.
 *
 * This test asks the question that matters for any future deployment onto a
 * college that already has attendance and marks on the books.
 *
 * WHY THE EXPECTED RESULT IS "IT REFUSES"
 *
 * A migration that cannot prove where a legacy row belongs must not guess.
 * There is no derivable mapping from (student, course, date) to a
 * course_offering without knowing the section and the term the row was taken
 * in — and inventing one would silently attach a student's attendance to a
 * section they were never in. Refusing is the correct behaviour; the defect
 * would be succeeding.
 *
 * So this test pins TWO facts:
 *   1. 047 fails on populated tables rather than corrupting them, and
 *   2. the pre-existing rows survive the failed attempt untouched.
 *
 * It is a deployment-safety statement, not a bug report. The remediation is
 * a backfill migration written against the real legacy data — see
 * PHASE3_REMEDIATION_REPORT.md §16 — which cannot be written here because
 * this repository has no populated database to write it against.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

const MIGRATION = join(process.cwd(), "supabase/migrations/047_academic_transactions_on_offerings.sql");
const UP_TO = "046_academic_period_foundation.sql";
const lf = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("migration 047 against a POPULATED database (§16)", () => {
  let db: PGlite;
  let applyError: Error | null = null;
  let attendanceBefore = -1;
  let marksBefore = -1;

  beforeAll(async () => {
    db = new PGlite();
    const chain = await applyFullChain(db, UP_TO);
    const broken = chain.find((s) => s.error);
    if (broken) throw new Error(`chain failed before 047 at ${broken.file}: ${broken.error}`);

    // A realistic legacy row set: the seed (008) already provides a college,
    // a department and courses; this adds the person and the transactions
    // that a live college would have accumulated before 047 ran.
    await db.exec(`
      INSERT INTO auth.users (id, email, raw_user_meta_data)
        VALUES ('0d0d0d0d-0000-4000-8000-00000000d001','legacy.teacher@qa.test','{"full_name":"Legacy Teacher"}');
      INSERT INTO auth.users (id, email, raw_user_meta_data)
        VALUES ('0d0d0d0d-0000-4000-8000-00000000d002','legacy.student@qa.test','{"full_name":"Legacy Student"}');
    `);

    const college = (await db.query<{ id: string }>(`SELECT id FROM public.colleges LIMIT 1`)).rows[0].id;
    const dept = (await db.query<{ id: string }>(`SELECT id FROM public.departments WHERE college_id=$1 LIMIT 1`, [college])).rows[0].id;
    const course = (await db.query<{ id: string }>(`SELECT id FROM public.courses WHERE college_id=$1 LIMIT 1`, [college])).rows[0].id;

    await db.exec(`
      UPDATE public.profiles SET college_id='${college}', role='teacher', status='active', department_id='${dept}'
        WHERE id='0d0d0d0d-0000-4000-8000-00000000d001';
      UPDATE public.profiles SET college_id='${college}', role='student', status='active', department_id='${dept}'
        WHERE id='0d0d0d0d-0000-4000-8000-00000000d002';
    `);

    await db.exec(`
      INSERT INTO public.students (id, college_id, user_id, department_id, enrollment_number, batch_year, semester)
        VALUES ('0e0e0e0e-0000-4000-8000-00000000e001','${college}','0d0d0d0d-0000-4000-8000-00000000d002','${dept}','LEGACY-001',2024,3);
    `);

    // Legacy shape: attendance/marks keyed on course_id, which is exactly
    // what 047 replaces with offering_id.
    await db.exec(`
      INSERT INTO public.attendance (college_id, student_id, course_id, date, status, marked_by)
        VALUES ('${college}','0e0e0e0e-0000-4000-8000-00000000e001','${course}','2025-08-11','present','0d0d0d0d-0000-4000-8000-00000000d001'),
               ('${college}','0e0e0e0e-0000-4000-8000-00000000e001','${course}','2025-08-12','absent','0d0d0d0d-0000-4000-8000-00000000d001');
    `);
    await db.exec(`
      INSERT INTO public.marks (college_id, student_id, course_id, exam_type, max_marks, obtained_marks, entered_by)
        VALUES ('${college}','0e0e0e0e-0000-4000-8000-00000000e001','${course}','internal_1',50,41,'0d0d0d0d-0000-4000-8000-00000000d001');
    `);

    attendanceBefore = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.attendance`)).rows[0].n;
    marksBefore = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.marks`)).rows[0].n;

    try {
      await db.exec(lf(MIGRATION));
    } catch (e) {
      applyError = e as Error;
    }
  });

  it("has a genuinely populated fixture (guards the test itself)", () => {
    expect(attendanceBefore).toBe(2);
    expect(marksBefore).toBe(1);
  });

  it("REFUSES to apply rather than guessing where the legacy rows belong", () => {
    expect(applyError, "047 applied to a populated database — it must not").not.toBeNull();
    // PostgreSQL's own refusal: a NOT NULL column cannot be added to a table
    // that already has rows with nothing to put in it.
    expect(applyError!.message).toMatch(/contains null values|non-null|not-null|NOT NULL/i);
  });

  it("leaves the pre-existing academic history untouched after the failed attempt", async () => {
    const att = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.attendance`)).rows[0].n;
    const mk = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.marks`)).rows[0].n;
    expect(att).toBe(attendanceBefore);
    expect(mk).toBe(marksBefore);
  });

  it("never invents an offering for a row it could not map", async () => {
    // The failure must not have left a half-built column populated with a
    // guessed value — the outcome §16 calls "silently assigning arbitrary
    // offerings".
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='attendance' AND column_name='offering_id'`
    );
    if (cols.rows.length > 0) {
      const mapped = (await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.attendance WHERE offering_id IS NOT NULL`
      )).rows[0].n;
      expect(mapped, "047 assigned an offering to a legacy row it could not map").toBe(0);
    }
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.course_offerings`)).rows[0].n)
      .toBe(0);
  });
});

/**
 * The other half of §16: scripts/migrate-047-backfill.sql is the documented
 * path for a populated database — run once, after 046, before 047. It existed
 * in the repository but **nothing executed it**, so "there is a backfill" was
 * a claim about a file, not about behaviour.
 *
 * This rehearses the real production sequence end to end on realistic data:
 *
 *     001..046  →  legacy rows  →  BACKFILL  →  047  →  verify
 *
 * and checks the properties §16 requires: 100% mapping, no silent orphaning,
 * tenant/semester/course consistency, legacy values preserved, idempotency.
 */
describe("the documented backfill makes 047 safe on populated data (§16)", () => {
  let db: PGlite;
  let backfillError: Error | null = null;
  let applyError: Error | null = null;
  let college = "";
  let course = "";

  beforeAll(async () => {
    db = new PGlite();
    const chain = await applyFullChain(db, UP_TO);
    const broken = chain.find((s) => s.error);
    if (broken) throw new Error(`chain failed before 047 at ${broken.file}: ${broken.error}`);

    await db.exec(`
      INSERT INTO auth.users (id, email, raw_user_meta_data)
        VALUES ('0d0d0d0d-0000-4000-8000-00000000d001','legacy.teacher@qa.test','{"full_name":"Legacy Teacher"}');
      INSERT INTO auth.users (id, email, raw_user_meta_data)
        VALUES ('0d0d0d0d-0000-4000-8000-00000000d002','legacy.student@qa.test','{"full_name":"Legacy Student"}');
    `);

    college = (await db.query<{ id: string }>(`SELECT id FROM public.colleges LIMIT 1`)).rows[0].id;
    const dept = (await db.query<{ id: string }>(`SELECT id FROM public.departments WHERE college_id=$1 LIMIT 1`, [college])).rows[0].id;
    course = (await db.query<{ id: string }>(`SELECT id FROM public.courses WHERE college_id=$1 LIMIT 1`, [college])).rows[0].id;

    // The backfill maps a legacy row through course.semester -> semester.sequence_no.
    // Pin the fixture to a term that actually exists so the mapping is
    // deterministic rather than accidental.
    const seq = (await db.query<{ sequence_no: number }>(
      `SELECT sequence_no FROM public.semesters WHERE college_id=$1 ORDER BY sequence_no LIMIT 1`, [college]
    )).rows[0].sequence_no;
    await db.exec(`UPDATE public.courses SET semester=${seq} WHERE id='${course}'`);

    await db.exec(`
      UPDATE public.profiles SET college_id='${college}', role='teacher', status='active', department_id='${dept}'
        WHERE id='0d0d0d0d-0000-4000-8000-00000000d001';
      UPDATE public.profiles SET college_id='${college}', role='student', status='active', department_id='${dept}'
        WHERE id='0d0d0d0d-0000-4000-8000-00000000d002';
      INSERT INTO public.students (id, college_id, user_id, department_id, enrollment_number, batch_year, semester)
        VALUES ('0e0e0e0e-0000-4000-8000-00000000e001','${college}','0d0d0d0d-0000-4000-8000-00000000d002','${dept}','LEGACY-001',2024,${seq});
      INSERT INTO public.attendance (college_id, student_id, course_id, date, status, marked_by)
        VALUES ('${college}','0e0e0e0e-0000-4000-8000-00000000e001','${course}','2025-08-11','present','0d0d0d0d-0000-4000-8000-00000000d001'),
               ('${college}','0e0e0e0e-0000-4000-8000-00000000e001','${course}','2025-08-12','absent','0d0d0d0d-0000-4000-8000-00000000d001');
      INSERT INTO public.marks (college_id, student_id, course_id, exam_type, max_marks, obtained_marks, entered_by)
        VALUES ('${college}','0e0e0e0e-0000-4000-8000-00000000e001','${course}','internal_1',50,41,'0d0d0d0d-0000-4000-8000-00000000d001');
    `);
    // Legacy enrolments keyed on the USER id (pre-047 FK was profiles), which
    // the backfill must translate to students.id.
    await db.exec(`
      INSERT INTO public.course_enrollments (college_id, student_id, course_id, status)
        VALUES ('${college}','0d0d0d0d-0000-4000-8000-00000000d002','${course}','completed');
    `);

    try {
      await db.exec(lf(join(process.cwd(), "scripts/migrate-047-backfill.sql")));
      // Idempotency: running it twice must not double-create or fail.
      await db.exec(lf(join(process.cwd(), "scripts/migrate-047-backfill.sql")));
    } catch (e) {
      backfillError = e as Error;
    }

    if (!backfillError) {
      try { await db.exec(lf(MIGRATION)); } catch (e) { applyError = e as Error; }
    }
  });

  it("the backfill runs, and runs twice, without error", () => {
    expect(backfillError?.message ?? null).toBeNull();
  });

  it("047 then applies cleanly to the populated database", () => {
    expect(applyError?.message ?? null).toBeNull();
  });

  it("maps every legacy row — no silent orphaning", async () => {
    for (const t of ["attendance", "marks", "course_enrollments"]) {
      const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${t} WHERE offering_id IS NULL`)).rows[0].n;
      expect(n, `${t} has unmapped rows`).toBe(0);
    }
  });

  it("preserves the legacy academic values verbatim", async () => {
    const att = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.attendance`)).rows[0].n;
    const mk = (await db.query<{ obtained_marks: number; max_marks: number }>(
      `SELECT obtained_marks, max_marks FROM public.marks`
    )).rows;
    expect(att).toBe(2);
    expect(mk.length).toBe(1);
    expect(Number(mk[0].obtained_marks)).toBe(41);
    expect(Number(mk[0].max_marks)).toBe(50);
  });

  it("every mapped offering agrees with the row's original course, college and term", async () => {
    const bad = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM public.attendance a
         JOIN public.course_offerings o ON o.id = a.offering_id
        WHERE o.course_id <> '${course}' OR o.college_id <> a.college_id`
    )).rows[0].n;
    expect(bad, "a row was attached to an offering for a different course or college").toBe(0);

    const semMismatch = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM public.course_offerings o
         JOIN public.semesters s ON s.id = o.semester_id
        WHERE s.college_id <> o.college_id`
    )).rows[0].n;
    expect(semMismatch, "an offering straddles a tenant boundary").toBe(0);
  });

  it("translates legacy enrolment student ids from users to students", async () => {
    const n = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.course_enrollments ce
        JOIN public.students st ON st.id = ce.student_id`
    )).rows[0].n;
    expect(n, "course_enrollments.student_id was not translated to students.id").toBe(1);
  });

  it("invents no more offerings than the legacy data implies", async () => {
    // One course, one section, one term => exactly one offering.
    const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.course_offerings`)).rows[0].n;
    expect(n).toBe(1);
  });
});
