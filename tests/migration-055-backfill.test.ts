import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyFullChain, S, U, COLLEGE_A, COLLEGE_B, SEM_3 } from "./staging/harness";

/**
 * Migration 055 applied to a database that ALREADY holds academic data —
 * the deployment shape (contract §4). The chain is applied through 054, the
 * QA dataset is loaded, and only then is 055 applied, so its backfill runs
 * against real rows rather than an empty schema.
 *
 * The backfill derives and never invents:
 *   - HOD history: one open row per department that has an HOD;
 *   - instructor history: the current instructor of every offering;
 *   - department terms: active only where a department already teaches
 *     its own courses in the active college term;
 *   - student sections: only where a student's active-term enrolments all
 *     point to ONE section of their own department; everyone else is left
 *     for an explicit decision.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const lf = (p: string) => readFileSync(join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const q = async <T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

describe("migration 055 against a populated database", () => {
  let db: PGlite;
  let applyError: string | null = null;

  beforeAll(async () => {
    db = new PGlite();
    const steps = await applyFullChain(db, "054_session_registry.sql");
    const failed = steps.find((s) => s.error);
    if (failed) throw new Error(`chain failed at ${failed.file}: ${failed.error}`);
    await db.exec(lf("tests/staging/qa-dataset.sql"));
    try { await db.exec(lf("supabase/migrations/055_academic_foundation.sql")); }
    catch (e) { applyError = (e as Error).message; }
  });
  afterAll(async () => { await db?.close(); });

  it("applies cleanly on top of existing academic data", () => {
    expect(applyError).toBeNull();
  });

  it("HOD history: one open backfill row per department with an HOD, no more", async () => {
    const rows = await q<{ n: number; departments: number }>(db, `
      SELECT (SELECT count(*)::int FROM department_hod_assignments WHERE ended_at IS NULL AND source = 'backfill') n,
             (SELECT count(*)::int FROM departments WHERE hod_id IS NOT NULL) departments`);
    expect(rows[0].n).toBe(rows[0].departments);
  });

  it("instructor history: the current instructor of every staffed offering", async () => {
    const rows = await q<{ missing: number }>(db, `
      SELECT count(*)::int missing FROM course_offerings o
      WHERE o.instructor_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM offering_instructor_history h WHERE h.offering_id = o.id AND h.instructor_id = o.instructor_id AND h.ended_at IS NULL)`);
    expect(rows[0].missing).toBe(0);
  });

  it("department terms: only departments already teaching their own courses in the active term", async () => {
    const rows = await q<{ department_id: string; semester_id: string; status: string }>(db,
      `SELECT department_id, semester_id, status FROM department_terms ORDER BY department_id`);
    // College A's active term is QA Semester 3: CSE teaches DS, DBMS and OS
    // there; Mechanical's only Sem-3 offering is CANCELLED, so it is not
    // counted. College B's CSE teaches in its own active term.
    expect(rows.map((r) => r.status)).toEqual(["active", "active"]);
    expect(rows.find((r) => r.department_id === "00000002-0000-4000-8000-000000000001")?.semester_id).toBe(SEM_3);
    expect(rows.some((r) => r.department_id === "00000002-0000-4000-8000-000000000003")).toBe(false);
  });

  it("student sections: derived only when every active-term enrolment points to one section", async () => {
    const rows = await q<{ student_id: string; section_id: string; start_source: string }>(db,
      `SELECT student_id, section_id, start_source FROM student_section_assignments WHERE ended_at IS NULL`);
    const placed = new Map(rows.map((r) => [r.student_id, r.section_id]));
    // A, B, D: all of their Semester 3 enrolments are CSE-A. C: CSE-B only.
    expect(placed.get(S.a)).toBe("00000008-0000-4000-8000-000000000001");
    expect(placed.get(S.b)).toBe("00000008-0000-4000-8000-000000000001");
    expect(placed.get(S.d)).toBe("00000008-0000-4000-8000-000000000001");
    expect(placed.get(S.c)).toBe("00000008-0000-4000-8000-000000000002");
    // E is enrolled only in a PLANNED term, F only in history: not guessed.
    expect(placed.has(S.e)).toBe(false);
    expect(placed.has(S.f)).toBe(false);
    // College B's student follows the same rule in their own college.
    expect(placed.get(S.bStudent)).toBe("00000008-0000-4000-8000-000000000006");
    expect(rows.every((r) => r.start_source === "backfill")).toBe(true);
  });

  it("invents nothing: no Class In-Charge, no placement, no audit row or notification", async () => {
    const [r] = await q<{ incharges: number; placements: number; audit: number; notes: number }>(db, `
      SELECT (SELECT count(*)::int FROM section_class_incharges) incharges,
             (SELECT count(*)::int FROM student_invitation_placements) placements,
             (SELECT count(*)::int FROM audit_logs WHERE action LIKE 'department_term.%' OR action LIKE 'student_section.%' OR action LIKE 'class_incharge.%') audit,
             (SELECT count(*)::int FROM notifications WHERE title IN ('Department term started', 'You are a Class In-Charge', 'Your section')) notes`);
    expect(r).toEqual({ incharges: 0, placements: 0, audit: 0, notes: 0 });
  });

  it("existing records are untouched: every enrolment, attendance row, mark and student is identical (insert timestamps aside)", async () => {
    const fresh = new PGlite();
    try {
      await applyFullChain(fresh, "054_session_registry.sql");
      await fresh.exec(lf("tests/staging/qa-dataset.sql"));
      const hash = async (d: PGlite) => (await q<{ h: string }>(d, `SELECT md5(string_agg(t, '|' ORDER BY t)) h FROM (
          SELECT 'e' || (to_jsonb(e) - 'created_at' - 'updated_at')::text t FROM course_enrollments e
          UNION ALL SELECT 'a' || (to_jsonb(a) - 'created_at' - 'updated_at')::text FROM attendance a
          UNION ALL SELECT 'm' || (to_jsonb(m) - 'created_at' - 'updated_at')::text FROM marks m
          UNION ALL SELECT 's' || (to_jsonb(s) - 'created_at' - 'updated_at')::text FROM students s) x`))[0].h;
      expect(await hash(db)).toBe(await hash(fresh));
    } finally { await fresh.close(); }
    expect([U.hodCse, COLLEGE_A, COLLEGE_B].length).toBe(3);
  });

  it("re-applying 055 converges: the backfill does not duplicate anything", async () => {
    const count = async () => (await q<{ n: string }>(db, `SELECT (
        (SELECT count(*) FROM department_hod_assignments) + (SELECT count(*) FROM offering_instructor_history)
      + (SELECT count(*) FROM department_terms) + (SELECT count(*) FROM student_section_assignments))::text n`))[0].n;
    const before = await count();
    await db.exec(lf("supabase/migrations/055_academic_foundation.sql"));
    expect(await count()).toBe(before);
  });
});
