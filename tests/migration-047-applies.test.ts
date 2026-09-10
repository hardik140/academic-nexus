import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Runs the WHOLE of migration 047 against a post-046 schema, in a disposable
 * database, and checks the result.
 *
 * The policy tests in rls-offering-authority.test.ts execute section 7 only.
 * This answers the different question: does the migration apply at all —
 * in order, with its DDL dependencies satisfied. That question has already
 * bitten this file once (dropping attendance.course_id is refused while
 * mv_attendance_summary_raw selects it, which is why section 0 exists), and
 * the failure mode is a migration that half-applies against a real database.
 *
 * The fixture leaves the six restructured tables EMPTY, exactly as they are
 * in the real database. That is not a convenience: 047 adds
 * `offering_id UUID NOT NULL` with no default, which any pre-existing row
 * would reject.
 *
 * NOT claimed here: that 046 applies (it is already applied to the real
 * database and was verified there), nor that the production Supabase
 * instance's roles, extensions and PostgREST layer behave identically. This
 * is the SQL, executed.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const MIGRATION = join(process.cwd(), "supabase/migrations/047_academic_transactions_on_offerings.sql");
const PRE047 = join(process.cwd(), "tests/rls/pre047.sql");

function loadSql(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

describe("migration 047 applies to a post-046 database", () => {
  let db: PGlite;
  let applyError: Error | null = null;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(loadSql(PRE047));
    try {
      // The real file, whole, unedited.
      await db.exec(loadSql(MIGRATION));
    } catch (err) {
      applyError = err as Error;
    }
  });

  it("applies without error", () => {
    expect(applyError?.message ?? null).toBeNull();
  });

  it("drops every column the migration says it drops", async () => {
    const res = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('attendance','marks','timetable_slots','course_enrollments',
                             'attendance_correction_requests','substitution_assignments')
          AND column_name IN ('course_id','semester_id','semester','instructor_id')`
    );
    expect(res.rows).toEqual([]);
  });

  it("adds offering_id NOT NULL to all six transaction tables", async () => {
    const res = await db.query<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'offering_id'
          AND table_name IN ('attendance','marks','timetable_slots','course_enrollments',
                             'attendance_correction_requests','substitution_assignments')
        ORDER BY table_name`
    );
    expect(res.rows.map((r) => r.table_name)).toEqual([
      "attendance",
      "attendance_correction_requests",
      "course_enrollments",
      "marks",
      "substitution_assignments",
      "timetable_slots",
    ]);
    for (const row of res.rows) {
      expect(row.is_nullable, `${row.table_name}.offering_id is nullable`).toBe("NO");
    }
  });

  it("replaces the old identities with offering-scoped ones", async () => {
    const res = await db.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE contype = 'u'
          AND conrelid IN ('public.attendance'::regclass, 'public.marks'::regclass,
                           'public.course_enrollments'::regclass,
                           'public.substitution_assignments'::regclass)
        ORDER BY conname`
    );
    const names = res.rows.map((r) => r.conname);
    expect(names).toContain("attendance_offering_student_date_key");
    expect(names).toContain("marks_offering_student_exam_key");
    expect(names).toContain("course_enrollments_offering_student_key");
    expect(names).toContain("substitution_assignments_offering_date_key");
    // and the course-scoped ones are gone
    expect(names.some((n) => n.includes("course_id"))).toBe(false);
  });

  it("repoints course_enrollments.student_id at students, not profiles", async () => {
    const res = await db.query<{ target: string }>(
      `SELECT confrelid::regclass::text AS target FROM pg_constraint
        WHERE conname = 'course_enrollments_student_id_fkey'`
    );
    expect(res.rows[0]?.target).toBe("students");
  });

  it("rebuilds both analytics views and leaves them queryable", async () => {
    const views = await db.query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relname IN ('mv_attendance_summary','mv_attendance_summary_raw',
                          'mv_department_health','mv_department_health_raw')
        ORDER BY relname`
    );
    expect(views.rows.map((r) => r.relname)).toEqual([
      "mv_attendance_summary",
      "mv_attendance_summary_raw",
      "mv_department_health",
      "mv_department_health_raw",
    ]);

    // The rebuilt attendance view must expose the offering, which is the
    // point of the rebuild — the old key merged every section and semester.
    //
    // pg_attribute, not information_schema.columns: a materialized view is
    // not a standard SQL object and does not appear in information_schema at
    // all, so that query returns an empty set for every matview whether it
    // exists or not.
    const cols = await db.query<{ column_name: string }>(
      `SELECT attname AS column_name FROM pg_attribute
        WHERE attrelid = 'public.mv_attendance_summary_raw'::regclass
          AND attnum > 0 AND NOT attisdropped
        ORDER BY attname`
    );
    const names = cols.rows.map((c) => c.column_name);
    expect(names).toContain("offering_id");
    expect(names).toContain("semester_id");
    // and the columns four existing surfaces read with select("*") survive
    for (const kept of ["attendance_pct", "present_count", "absent_count", "total_count", "course_name", "course_code"]) {
      expect(names, `mv_attendance_summary lost ${kept}`).toContain(kept);
    }

    await db.exec("REFRESH MATERIALIZED VIEW public.mv_attendance_summary_raw;");
    await db.exec("REFRESH MATERIALIZED VIEW public.mv_department_health_raw;");
  });

  it("leaves refresh_analytics() working — CONCURRENTLY needs a unique index", async () => {
    // The scheduled refresh names all six matviews and uses
    // REFRESH ... CONCURRENTLY, which Postgres rejects unless the matview
    // carries a unique index and has been populated at least once. A rebuild
    // that dropped either property would not fail during the migration; it
    // would fail later, in a cron job, where nobody is watching.
    await expect(db.exec("SELECT public.refresh_analytics();")).resolves.toBeDefined();
  });

  it("keeps a unique index on each rebuilt matview", async () => {
    const res = await db.query<{ relname: string; n: number }>(
      `SELECT c.relname, count(*)::int AS n
         FROM pg_class c
         JOIN pg_index i ON i.indrelid = c.oid AND i.indisunique
        WHERE c.relname IN ('mv_attendance_summary_raw','mv_department_health_raw')
        GROUP BY c.relname ORDER BY c.relname`
    );
    expect(res.rows.map((r) => r.relname)).toEqual([
      "mv_attendance_summary_raw",
      "mv_department_health_raw",
    ]);
  });

  it("drops the indexes that sat on removed columns, and adds offering ones", async () => {
    const res = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('idx_attendance_course','idx_timetable_course',
                            'idx_course_enrollments_course','idx_attendance_offering',
                            'idx_marks_offering','idx_timetable_offering',
                            'idx_course_enrollments_offering','idx_substitution_offering')
        ORDER BY indexname`
    );
    const names = res.rows.map((r) => r.indexname);
    // Postgres removes an index with its column; these must be gone.
    expect(names).not.toContain("idx_attendance_course");
    expect(names).not.toContain("idx_timetable_course");
    expect(names).not.toContain("idx_course_enrollments_course");
    // and the offering-scoped replacements exist
    for (const idx of [
      "idx_attendance_offering",
      "idx_marks_offering",
      "idx_timetable_offering",
      "idx_course_enrollments_offering",
      "idx_substitution_offering",
    ]) {
      expect(names, `missing ${idx}`).toContain(idx);
    }
  });

  it("rebuilds the dependent substitution policy against the new model", async () => {
    // Section 0 drops it so the columns can go; 7c must put back a working
    // equivalent, not just leave the hole. A migration that dropped it and
    // forgot to recreate it would still "apply cleanly".
    const res = await db.query<{ qual: string }>(
      `SELECT qual FROM pg_policies
        WHERE tablename = 'substitution_assignments'
          AND policyname = 'substitution_read_enrolled_student'`
    );
    expect(res.rows.length).toBe(1);
    const qual = res.rows[0].qual;
    expect(qual).toContain("offering_id");
    expect(qual).not.toContain("course_id");
    // and it hops through students.user_id rather than comparing the old
    // profiles-space student_id to auth.uid()
    expect(qual).toMatch(/students/);
  });

  it("leaves the transaction tables empty — no data was invented", async () => {
    const res = await db.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM public.attendance)
            + (SELECT count(*) FROM public.marks)
            + (SELECT count(*) FROM public.course_enrollments)
            + (SELECT count(*) FROM public.timetable_slots) AS n`
    );
    expect(Number(res.rows[0].n)).toBe(0);
  });

  it("keeps courses.instructor_id, deprecated rather than dropped", async () => {
    const col = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'courses' AND column_name = 'instructor_id'`
    );
    expect(col.rows.length).toBe(1);

    const comment = await db.query<{ d: string | null }>(
      `SELECT col_description('public.courses'::regclass,
         (SELECT attnum FROM pg_attribute
           WHERE attrelid = 'public.courses'::regclass AND attname = 'instructor_id')) AS d`
    );
    expect(comment.rows[0].d).toMatch(/DEPRECATED/i);
  });

  it("ends with the offering-derived policy set in place", async () => {
    const res = await db.query<{ policyname: string }>(
      `SELECT policyname FROM pg_policies
        WHERE tablename IN ('attendance','marks') ORDER BY policyname`
    );
    expect(res.rows.map((r) => r.policyname)).toEqual([
      "attendance_insert_offering_authority",
      "attendance_read_staff",
      "attendance_read_student",
      "attendance_update_approved_correction",
      "attendance_update_offering_authority",
      "marks_delete_instructor",
      "marks_insert_instructor",
      "marks_read_staff",
      "marks_read_student",
      "marks_update_instructor",
    ]);
  });

  it("is idempotent enough to re-run section 7 without error", async () => {
    // Every policy in section 7 is preceded by a DROP POLICY IF EXISTS, and
    // the functions are CREATE OR REPLACE, so a re-run is a no-op rather
    // than a duplicate-object failure. Migrations get re-run by accident.
    const sql = loadSql(MIGRATION);
    const start = sql.indexOf("-- 7a. Authority functions");
    const end = sql.indexOf("-- 8. Rebuild the analytics views");
    await expect(db.exec(sql.slice(start, end))).resolves.toBeDefined();
  });
});
