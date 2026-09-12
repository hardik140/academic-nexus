import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Booting PostgreSQL is not a 5ms operation. Each test gets its own database
// (see freshDb) because a shared one would couple these tests to each other's
// inserted rows, and a security suite whose own isolation is doubtful is not
// worth much.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/**
 * Migration 047 section 7 (C1) executed against a real PostgreSQL engine.
 *
 * These tests do not mock a client and do not reason about policy text.
 * They start an in-process PostgreSQL (PGlite — the actual Postgres source
 * compiled to WASM, so RLS, SECURITY DEFINER, WITH CHECK and permissive
 * policy OR-ing all behave as they do in production), install the schema,
 * install the PRE-047 policies, then run the migration's own SQL — sliced
 * out of the .sql file rather than retyped, so the thing under test cannot
 * drift from the thing that ships.
 *
 * WHY THE OLD POLICIES ARE INSTALLED FIRST
 *
 * RLS policies are permissive: they OR together. A narrow new policy proves
 * nothing while a broad old one still stands. Installing 006/037/038's
 * policies first means these tests fail if 047 ever stops dropping them,
 * which is the failure mode that would silently reinstate C1.
 *
 * WHAT THIS DOES NOT COVER
 *
 * PostgREST's own behaviour, GoTrue, and the production instance's roles
 * and grants. This verifies the POLICY LOGIC. Applying 046+047 to a real
 * staging Supabase database is a separate step and is not what this file
 * claims to have done.
 */

const MIGRATION = join(process.cwd(), "supabase/migrations/047_academic_transactions_on_offerings.sql");
const FIXTURE = join(process.cwd(), "tests/rls/fixture.sql");
const SEED = join(process.cwd(), "tests/rls/seed.sql");

/**
 * Slices sections 7a-7c out of the real migration file.
 *
 * Deliberately not a copy: if someone edits a policy in the migration, the
 * next run of this suite executes the edited policy. A test that carried
 * its own copy of the SQL would keep passing while the shipped migration
 * regressed.
 */
function loadSql(path: string): string {
  // Normalised to LF. The migrations are CRLF on disk (Windows checkout), and
  // the multi-line patterns the mutation tests below match against would
  // silently never match otherwise — turning every mutation into a no-op that
  // "passes" for entirely the wrong reason.
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

function migrationRlsSection(): string {
  const sql = loadSql(MIGRATION);
  const start = sql.indexOf("-- 7a. Authority functions");
  // Ends at 7g: sections 7g-7i (hostel, gate pass, finance) reference tables
  // the academic fixture does not model, and they are exercised against the
  // real chain by tests/staging-*.test.ts instead.
  const end = sql.indexOf("-- 7g. Hostel");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      "Could not locate section 7 in migration 047. If the section headers were " +
        "renamed, update these markers — do not paste a copy of the SQL here."
    );
  }
  return sql.slice(start, end);
}

const U = {
  teacherA: "00000000-0000-4000-8000-00000000a001",
  teacherB: "00000000-0000-4000-8000-00000000a002",
  hodA: "00000000-0000-4000-8000-00000000a003",
  hodB: "00000000-0000-4000-8000-00000000a004",
  teachingHod: "00000000-0000-4000-8000-00000000a005",
  substitute: "00000000-0000-4000-8000-00000000a006",
  admin: "00000000-0000-4000-8000-00000000a007",
  finance: "00000000-0000-4000-8000-00000000a008",
  warden: "00000000-0000-4000-8000-00000000a009",
  director: "00000000-0000-4000-8000-00000000a010",
  studentA: "00000000-0000-4000-8000-00000000a011",
  studentB: "00000000-0000-4000-8000-00000000a012",
  superAdmin: "00000000-0000-4000-8000-00000000a013",
  foreignTeacher: "00000000-0000-4000-8000-00000000b001",
} as const;

const COLLEGE = "00000000-0000-4000-8000-0000000000c1";
const STUDENT_A = "00000000-0000-4000-8000-000000012001";
const STUDENT_B = "00000000-0000-4000-8000-000000012002";
const OFF_A = "00000000-0000-4000-8000-000000013001"; // Dept A, Teacher A
const OFF_B = "00000000-0000-4000-8000-000000013002"; // Dept B, Teacher B
const OFF_H = "00000000-0000-4000-8000-000000013003"; // Dept A, Teaching HOD
const OFF_X = "00000000-0000-4000-8000-000000013004"; // Dept A, Teacher A, cancelled
const ATT_1 = "00000000-0000-4000-8000-000000014001";
const DATE = "2026-09-10";

type Db = PGlite;

/**
 * Snapshots so each test gets an isolated database without paying initdb
 * every time: `preMigration` is fixture + seed, `postMigration` adds 047's
 * section 7. Restoring a data directory costs roughly a third of a cold boot.
 */
let preMigration: Blob | File | null = null;
let postMigration: Blob | File | null = null;

async function buildSnapshots() {
  if (postMigration) return;
  const db = new PGlite();
  await db.exec(loadSql(FIXTURE));
  await db.exec(loadSql(SEED));
  preMigration = await db.dumpDataDir();
  await db.exec(migrationRlsSection());
  postMigration = await db.dumpDataDir();
}

/**
 * A database with the fixture, the seed, and 047's section 7 applied.
 *
 * With `mutate`, section 7 is rewritten before it is applied — used by the
 * mutation-resistance tests. A mutation that fails to match anything throws
 * rather than quietly applying the unmodified policy: a no-op mutation makes
 * the corresponding test assert that a defect is absent from SQL that never
 * had the defect introduced, which looks like a pass and proves nothing.
 */
async function freshDb(mutate?: (sql: string) => string): Promise<Db> {
  await buildSnapshots();

  if (!mutate) {
    return new PGlite({ loadDataDir: postMigration! });
  }

  const original = migrationRlsSection();
  const mutated = mutate(original);
  if (mutated === original) {
    throw new Error(
      "Mutation did not change the migration SQL — its pattern no longer matches " +
        "section 7. Update the pattern; do not leave it silently inert."
    );
  }

  const db = new PGlite({ loadDataDir: preMigration! });
  await db.exec(mutated);
  return db;
}

interface Attempt {
  ok: boolean;
  error?: string;
  rows: number;
}

/**
 * Runs a statement as `authenticated` with auth.uid() set to `uid`, which
 * is how a real request arrives: a limited role plus a claim.
 *
 * Returns BOTH the error and the affected row count, because RLS denies in
 * two different ways and only one of them is loud. A WITH CHECK violation
 * on INSERT raises 42501; a USING mismatch on UPDATE or DELETE quietly
 * affects zero rows and reports success. The second is the failure mode
 * this codebase already carries eight migrations for.
 */
async function attempt(db: Db, uid: string, sql: string): Promise<Attempt> {
  await db.exec(`SET ROLE authenticated; SET test.user_id = '${uid}';`);
  try {
    const res = await db.query(sql);
    return { ok: true, rows: res.affectedRows ?? 0 };
  } catch (err) {
    return { ok: false, error: (err as Error).message, rows: 0 };
  } finally {
    await db.exec("RESET ROLE; RESET test.user_id;");
  }
}

/** Row count read as superuser, bypassing RLS — ground truth for §11. */
async function countRows(db: Db, sql: string): Promise<number> {
  const res = await db.query<{ n: number }>(sql);
  return Number(res.rows[0].n);
}

function insertAttendance(offeringId: string, studentId = STUDENT_B, date = DATE) {
  return `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
          VALUES ('${COLLEGE}', '${offeringId}', '${studentId}', '${date}', 'present', current_setting('test.user_id')::uuid)`;
}

function insertMarks(offeringId: string, studentId = STUDENT_B, examType = "midterm") {
  return `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks, entered_by)
          VALUES ('${COLLEGE}', '${offeringId}', '${studentId}', '${examType}', 100, 55, current_setting('test.user_id')::uuid)`;
}

/**
 * Asserts a write was denied AND had no effect.
 *
 * "Denied" is not enough on its own: a policy that lets the statement run
 * but matches no rows also reports success, so every denial assertion has
 * to check the table too.
 */
async function expectDenied(db: Db, result: Attempt, countSql: string, before: number) {
  const after = await countRows(db, countSql);
  expect(after).toBe(before);
  if (result.ok) {
    expect(result.rows).toBe(0);
  }
}

// ===========================================================================

describe("047 §7 — the pre-047 role-only policies are actually removed", () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
  });

  it("drops every role-only academic write policy", async () => {
    const res = await db.query<{ policyname: string }>(
      `SELECT policyname FROM pg_policies
        WHERE tablename IN ('attendance','marks','attendance_correction_requests')
          AND policyname IN ('attendance_teacher_mark','attendance_teacher_update',
                             'attendance_hod_update','marks_teacher_manage',
                             'attendance_correction_update_staff')`
    );
    expect(res.rows.map((r) => r.policyname)).toEqual([]);
  });

  it("leaves the READ policies untouched", async () => {
    const res = await db.query<{ policyname: string }>(
      `SELECT policyname FROM pg_policies
        WHERE tablename IN ('attendance','marks') AND cmd = 'SELECT'
        ORDER BY policyname`
    );
    expect(res.rows.map((r) => r.policyname)).toEqual([
      "attendance_read_staff",
      "attendance_read_student",
      "marks_read_staff",
      "marks_read_student",
    ]);
  });

  it("states a WITH CHECK clause explicitly on every UPDATE policy", async () => {
    // Postgres would fall back to USING if one were omitted, so this asserts
    // a documentation convention rather than a behavioural guarantee: the
    // post-image rule is written where a reader looks for it, and a future
    // divergence between the two halves shows up in the diff.
    const res = await db.query<{ policyname: string; with_check: string | null }>(
      `SELECT policyname, with_check FROM pg_policies
        WHERE tablename IN ('attendance','marks','attendance_correction_requests')
          AND cmd = 'UPDATE'`
    );
    expect(res.rows.length).toBeGreaterThan(0);
    for (const row of res.rows) {
      expect(row.with_check, `${row.policyname} has no WITH CHECK`).not.toBeNull();
    }
  });

  it("pins search_path on every SECURITY DEFINER authority function", async () => {
    const res = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      `SELECT proname, prosecdef, proconfig FROM pg_proc
        WHERE proname IN ('can_write_offering_records','can_record_attendance','heads_offering_department')
        ORDER BY proname`
    );
    expect(res.rows.length).toBe(3);
    for (const row of res.rows) {
      expect(row.prosecdef, `${row.proname} is not SECURITY DEFINER`).toBe(true);
      expect(row.proconfig?.join(","), `${row.proname} has no pinned search_path`).toContain("search_path");
    }
  });
});

// ===========================================================================
// The ten tests named in the brief, run directly against the database.
// ===========================================================================

describe("§10 direct database authorization tests", () => {
  const ATT_COUNT = `SELECT count(*)::int AS n FROM public.attendance`;
  const MARKS_COUNT = `SELECT count(*)::int AS n FROM public.marks`;

  it("Test 1 — Teacher A writes Offering A → ALLOW", async () => {
    const db = await freshDb();
    const before = await countRows(db, ATT_COUNT);
    const res = await attempt(db, U.teacherA, insertAttendance(OFF_A));
    expect(res.ok).toBe(true);
    expect(res.rows).toBe(1);
    expect(await countRows(db, ATT_COUNT)).toBe(before + 1);
  });

  it("Test 2 — Teacher A writes Offering B → DENY", async () => {
    const db = await freshDb();
    const before = await countRows(db, ATT_COUNT);
    const res = await attempt(db, U.teacherA, insertAttendance(OFF_B));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/row-level security/i);
    await expectDenied(db, res, ATT_COUNT, before);
  });

  it("Test 3 — HOD A writes Dept A attendance without being instructor → DENY", async () => {
    const db = await freshDb();
    const before = await countRows(db, ATT_COUNT);
    const res = await attempt(db, U.hodA, insertAttendance(OFF_A));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, ATT_COUNT, before);
  });

  it("Test 3b — HOD A cannot UPDATE Dept A attendance either", async () => {
    // This is the one migration 038 opened institution-wide. The UPDATE path
    // denies silently, so the row itself is the evidence.
    const db = await freshDb();
    const res = await attempt(
      db,
      U.hodA,
      `UPDATE public.attendance SET status = 'absent' WHERE id = '${ATT_1}'`
    );
    expect(res.rows).toBe(0);
    const status = await db.query<{ status: string }>(
      `SELECT status FROM public.attendance WHERE id = '${ATT_1}'`
    );
    expect(status.rows[0].status).toBe("present");
  });

  it("Test 4 — HOD A reviews a Dept A correction request → ALLOW", async () => {
    const db = await freshDb();
    await db.exec(
      `INSERT INTO public.attendance_correction_requests
         (id, college_id, attendance_id, student_id, offering_id, date, current_status, requested_status, submitted_by)
       VALUES ('00000000-0000-4000-8000-000000016001','${COLLEGE}','${ATT_1}','${STUDENT_A}','${OFF_A}','${DATE}','present','absent','${U.teacherA}')`
    );
    const res = await attempt(
      db,
      U.hodA,
      `UPDATE public.attendance_correction_requests
          SET status = 'approved', reviewed_by = '${U.hodA}'
        WHERE id = '00000000-0000-4000-8000-000000016001'`
    );
    expect(res.ok).toBe(true);
    expect(res.rows).toBe(1);
  });

  it("Test 4b — HOD B cannot review a Dept A correction request → DENY", async () => {
    const db = await freshDb();
    await db.exec(
      `INSERT INTO public.attendance_correction_requests
         (id, college_id, attendance_id, student_id, offering_id, date, current_status, requested_status, submitted_by)
       VALUES ('00000000-0000-4000-8000-000000016002','${COLLEGE}','${ATT_1}','${STUDENT_A}','${OFF_A}','${DATE}','present','absent','${U.teacherA}')`
    );
    const res = await attempt(
      db,
      U.hodB,
      `UPDATE public.attendance_correction_requests
          SET status = 'approved', reviewed_by = '${U.hodB}'
        WHERE id = '00000000-0000-4000-8000-000000016002'`
    );
    expect(res.rows).toBe(0);
    const row = await db.query<{ status: string }>(
      `SELECT status FROM public.attendance_correction_requests WHERE id = '00000000-0000-4000-8000-000000016002'`
    );
    expect(row.rows[0].status).toBe("pending");
  });

  it("Test 5 — Teaching HOD writes their assigned offering → ALLOW", async () => {
    const db = await freshDb();
    const res = await attempt(db, U.teachingHod, insertAttendance(OFF_H));
    expect(res.ok).toBe(true);
    expect(res.rows).toBe(1);
  });

  it("Test 5b — Teaching HOD may also enter marks on their assigned offering", async () => {
    const db = await freshDb();
    const res = await attempt(db, U.teachingHod, insertMarks(OFF_H));
    expect(res.ok).toBe(true);
    expect(res.rows).toBe(1);
  });

  it("Test 6 — Teaching HOD writes another teacher's offering → DENY", async () => {
    const db = await freshDb();
    const before = await countRows(db, ATT_COUNT);
    const res = await attempt(db, U.teachingHod, insertAttendance(OFF_A));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, ATT_COUNT, before);
  });

  it("Test 7 — HOD A writes Department B → DENY", async () => {
    const db = await freshDb();
    const before = await countRows(db, ATT_COUNT);
    const res = await attempt(db, U.hodA, insertAttendance(OFF_B));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, ATT_COUNT, before);
  });

  it("Test 8 — Student A writes attendance → DENY", async () => {
    const db = await freshDb();
    const before = await countRows(db, ATT_COUNT);
    const res = await attempt(db, U.studentA, insertAttendance(OFF_A, STUDENT_A));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, ATT_COUNT, before);
  });

  it("Test 9 — Finance writes attendance → DENY", async () => {
    const db = await freshDb();
    const before = await countRows(db, ATT_COUNT);
    const res = await attempt(db, U.finance, insertAttendance(OFF_A));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, ATT_COUNT, before);
  });

  it("Test 10 — Warden writes marks → DENY", async () => {
    const db = await freshDb();
    const before = await countRows(db, MARKS_COUNT);
    const res = await attempt(db, U.warden, insertMarks(OFF_A));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, MARKS_COUNT, before);
  });

  it("Director gets institutional oversight, not academic write", async () => {
    const db = await freshDb();
    const before = await countRows(db, ATT_COUNT);
    const res = await attempt(db, U.director, insertAttendance(OFF_A));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, ATT_COUNT, before);

    // but the read they rely on for oversight still works
    await db.exec(`SET ROLE authenticated; SET test.user_id = '${U.director}';`);
    const read = await db.query(`SELECT id FROM public.attendance`);
    await db.exec("RESET ROLE; RESET test.user_id;");
    expect(read.rows.length).toBeGreaterThan(0);
  });

  it("super_admin does not bypass the academic workflow", async () => {
    const db = await freshDb();
    const before = await countRows(db, ATT_COUNT);
    const res = await attempt(db, U.superAdmin, insertAttendance(OFF_A));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, ATT_COUNT, before);
  });

  it("admin writes any offering in their own college", async () => {
    const db = await freshDb();
    const res = await attempt(db, U.admin, insertAttendance(OFF_B));
    expect(res.ok).toBe(true);
    expect(res.rows).toBe(1);
  });

  it("a teacher from another college is denied even on a valid offering id", async () => {
    const db = await freshDb();
    const before = await countRows(db, ATT_COUNT);
    const res = await attempt(db, U.foreignTeacher, insertAttendance(OFF_A));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, ATT_COUNT, before);
  });
});

// ===========================================================================

describe("§5 marks — assignment, not role", () => {
  const MARKS_COUNT = `SELECT count(*)::int AS n FROM public.marks`;

  it("denies Teacher A INSERT on Teacher B's offering", async () => {
    const db = await freshDb();
    const before = await countRows(db, MARKS_COUNT);
    const res = await attempt(db, U.teacherA, insertMarks(OFF_B));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, MARKS_COUNT, before);
  });

  it("denies Teacher B UPDATE of Teacher A's marks row", async () => {
    const db = await freshDb();
    const res = await attempt(
      db,
      U.teacherB,
      `UPDATE public.marks SET obtained_marks = 99 WHERE offering_id = '${OFF_A}'`
    );
    expect(res.rows).toBe(0);
    const row = await db.query<{ obtained_marks: string }>(
      `SELECT obtained_marks FROM public.marks WHERE offering_id = '${OFF_A}'`
    );
    expect(Number(row.rows[0].obtained_marks)).toBe(70);
  });

  it("denies Teacher B DELETE of Teacher A's marks row", async () => {
    const db = await freshDb();
    const before = await countRows(db, MARKS_COUNT);
    const res = await attempt(db, U.teacherB, `DELETE FROM public.marks WHERE offering_id = '${OFF_A}'`);
    expect(res.rows).toBe(0);
    expect(await countRows(db, MARKS_COUNT)).toBe(before);
  });

  it("allows Teacher A to update their own offering's marks", async () => {
    const db = await freshDb();
    const res = await attempt(
      db,
      U.teacherA,
      `UPDATE public.marks SET obtained_marks = 88 WHERE offering_id = '${OFF_A}'`
    );
    expect(res.rows).toBe(1);
  });

  it("denies rewriting offering_id to an offering the actor does not hold", async () => {
    // The WITH CHECK case: Teacher A may update this row, and without a
    // post-image test could move it onto Teacher B's offering.
    const db = await freshDb();
    const res = await attempt(
      db,
      U.teacherA,
      `UPDATE public.marks SET offering_id = '${OFF_B}' WHERE offering_id = '${OFF_A}'`
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/row-level security/i);
  });
});

// ===========================================================================

describe("§4 substitute scope", () => {
  const ATT_COUNT = `SELECT count(*)::int AS n FROM public.attendance`;

  async function withSubstitution(over: Partial<{ offering: string; date: string; status: string }> = {}) {
    const db = await freshDb();
    const offering = over.offering ?? OFF_A;
    const date = over.date ?? DATE;
    const status = over.status ?? "assigned";
    await db.exec(
      `INSERT INTO public.substitution_assignments
         (college_id, offering_id, original_teacher_id, substitute_teacher_id, date, status)
       VALUES ('${COLLEGE}','${offering}','${U.teacherA}','${U.substitute}','${date}','${status}')`
    );
    return db;
  }

  it("allows the assigned substitute on the assigned offering and date", async () => {
    const db = await withSubstitution();
    const res = await attempt(db, U.substitute, insertAttendance(OFF_A, STUDENT_B, DATE));
    expect(res.ok).toBe(true);
    expect(res.rows).toBe(1);
  });

  it("denies the substitute a different date", async () => {
    const db = await withSubstitution();
    const before = await countRows(db, ATT_COUNT);
    const res = await attempt(db, U.substitute, insertAttendance(OFF_A, STUDENT_B, "2026-09-11"));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, ATT_COUNT, before);
  });

  it("denies the substitute a different offering", async () => {
    const db = await withSubstitution();
    const before = await countRows(db, ATT_COUNT);
    const res = await attempt(db, U.substitute, insertAttendance(OFF_B, STUDENT_B, DATE));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, ATT_COUNT, before);
  });

  it("denies a substitution still in 'needed' state", async () => {
    const db = await withSubstitution({ status: "needed" });
    const before = await countRows(db, ATT_COUNT);
    const res = await attempt(db, U.substitute, insertAttendance(OFF_A, STUDENT_B, DATE));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, ATT_COUNT, before);
  });

  it("gives the substitute NO marks authority", async () => {
    const db = await withSubstitution();
    const before = await countRows(db, `SELECT count(*)::int AS n FROM public.marks`);
    const res = await attempt(db, U.substitute, insertMarks(OFF_A));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, `SELECT count(*)::int AS n FROM public.marks`, before);
  });

  it("cannot reopen a cancelled offering", async () => {
    const db = await withSubstitution({ offering: OFF_X });
    const before = await countRows(db, ATT_COUNT);
    const res = await attempt(db, U.substitute, insertAttendance(OFF_X, STUDENT_B, DATE));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, ATT_COUNT, before);
  });

  it("does not become general access to the offering — no marks, no other dates", async () => {
    const db = await withSubstitution();
    const okDay = await attempt(db, U.substitute, insertAttendance(OFF_A, STUDENT_B, DATE));
    expect(okDay.ok).toBe(true);
    const otherDay = await attempt(db, U.substitute, insertAttendance(OFF_A, STUDENT_A, "2026-09-12"));
    expect(otherDay.ok).toBe(false);
  });
});

// ===========================================================================

describe("cancelled offerings are closed to everyone", () => {
  const ATT_COUNT = `SELECT count(*)::int AS n FROM public.attendance`;

  it("denies the assigned instructor", async () => {
    const db = await freshDb();
    const before = await countRows(db, ATT_COUNT);
    const res = await attempt(db, U.teacherA, insertAttendance(OFF_X));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, ATT_COUNT, before);
  });

  it("denies admin", async () => {
    const db = await freshDb();
    const before = await countRows(db, ATT_COUNT);
    const res = await attempt(db, U.admin, insertAttendance(OFF_X));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, ATT_COUNT, before);
  });
});

// ===========================================================================

describe("§12 student read scope is preserved", () => {
  it("Student A reads their own attendance", async () => {
    const db = await freshDb();
    await db.exec(`SET ROLE authenticated; SET test.user_id = '${U.studentA}';`);
    const res = await db.query(`SELECT id FROM public.attendance`);
    await db.exec("RESET ROLE; RESET test.user_id;");
    expect(res.rows.length).toBe(1);
  });

  it("Student A cannot read Student B's attendance", async () => {
    const db = await freshDb();
    // Give student B a row of their own, then check A still sees only theirs.
    await db.exec(
      `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
       VALUES ('${COLLEGE}','${OFF_A}','${STUDENT_B}','${DATE}','absent','${U.teacherA}')`
    );
    await db.exec(`SET ROLE authenticated; SET test.user_id = '${U.studentA}';`);
    const res = await db.query<{ student_id: string }>(`SELECT student_id FROM public.attendance`);
    await db.exec("RESET ROLE; RESET test.user_id;");
    expect(res.rows.map((r) => r.student_id)).toEqual([STUDENT_A]);
  });

  it("Student A cannot write attendance for Student B", async () => {
    const db = await freshDb();
    const before = await countRows(db, `SELECT count(*)::int AS n FROM public.attendance`);
    const res = await attempt(db, U.studentA, insertAttendance(OFF_A, STUDENT_B));
    expect(res.ok).toBe(false);
    await expectDenied(db, res, `SELECT count(*)::int AS n FROM public.attendance`, before);
  });
});

// ===========================================================================

describe("§11 the correction workflow, and separation of duties in the database", () => {
  async function withPendingCorrection(submittedBy: string) {
    const db = await freshDb();
    await db.exec(
      `INSERT INTO public.attendance_correction_requests
         (id, college_id, attendance_id, student_id, offering_id, date, current_status, requested_status, submitted_by, status, reviewed_by)
       VALUES ('00000000-0000-4000-8000-000000017001','${COLLEGE}','${ATT_1}','${STUDENT_A}','${OFF_A}','${DATE}','present','absent','${submittedBy}','approved','${U.hodA}')`
    );
    return db;
  }

  it("lets the reviewing HOD apply a correction they approved", async () => {
    const db = await withPendingCorrection(U.teacherA);
    const res = await attempt(
      db,
      U.hodA,
      `UPDATE public.attendance SET status = 'absent' WHERE id = '${ATT_1}'`
    );
    expect(res.rows).toBe(1);
    const row = await db.query<{ status: string }>(
      `SELECT status FROM public.attendance WHERE id = '${ATT_1}'`
    );
    expect(row.rows[0].status).toBe("absent");
  });

  it("refuses when the reviewer is also the submitter", async () => {
    // Separation of duties enforced by the database, not only by
    // assertNotSelfApproval in application code.
    const db = await withPendingCorrection(U.hodA);
    const res = await attempt(
      db,
      U.hodA,
      `UPDATE public.attendance SET status = 'absent' WHERE id = '${ATT_1}'`
    );
    expect(res.rows).toBe(0);
    const row = await db.query<{ status: string }>(
      `SELECT status FROM public.attendance WHERE id = '${ATT_1}'`
    );
    expect(row.rows[0].status).toBe("present");
  });

  it("refuses a HOD from another department even with an approved request", async () => {
    const db = await freshDb();
    await db.exec(
      `INSERT INTO public.attendance_correction_requests
         (college_id, attendance_id, student_id, offering_id, date, current_status, requested_status, submitted_by, status, reviewed_by)
       VALUES ('${COLLEGE}','${ATT_1}','${STUDENT_A}','${OFF_A}','${DATE}','present','absent','${U.teacherA}','approved','${U.hodB}')`
    );
    const res = await attempt(
      db,
      U.hodB,
      `UPDATE public.attendance SET status = 'absent' WHERE id = '${ATT_1}'`
    );
    expect(res.rows).toBe(0);
  });

  it("refuses when no approved request exists — an approval is required, not a role", async () => {
    const db = await freshDb();
    const res = await attempt(
      db,
      U.hodA,
      `UPDATE public.attendance SET status = 'absent' WHERE id = '${ATT_1}'`
    );
    expect(res.rows).toBe(0);
  });
});

// ===========================================================================
// §16 — mutation resistance. Each mutation reintroduces a specific defect;
// the suite must notice.
// ===========================================================================

describe("§16 mutation resistance", () => {
  const ATT_COUNT = `SELECT count(*)::int AS n FROM public.attendance`;

  it("assignment predicate removed → cross-offering write is no longer refused", async () => {
    const db = await freshDb((sql) => sql.replace("OR o.instructor_id = auth.uid()", "OR true"));
    const res = await attempt(db, U.teacherA, insertAttendance(OFF_B));
    expect(res.ok).toBe(true); // the defect is reachable again
  });

  it("HOD blanket write restored → Test 3 stops holding", async () => {
    const db = await freshDb((sql) =>
      sql.replace(
        "public.get_my_role() = 'admin'\n        OR o.instructor_id = auth.uid()",
        "public.get_my_role() IN ('admin','hod')\n        OR o.instructor_id = auth.uid()"
      )
    );
    const res = await attempt(db, U.hodA, insertAttendance(OFF_A));
    expect(res.ok).toBe(true);
  });

  it("department scope removed → cross-department review is no longer refused", async () => {
    const db = await freshDb((sql) => sql.replace("AND d.hod_id = auth.uid()", "AND true"));
    await db.exec(
      `INSERT INTO public.attendance_correction_requests
         (id, college_id, attendance_id, student_id, offering_id, date, current_status, requested_status, submitted_by)
       VALUES ('00000000-0000-4000-8000-000000018001','${COLLEGE}','${ATT_1}','${STUDENT_A}','${OFF_A}','${DATE}','present','absent','${U.teacherA}')`
    );
    const res = await attempt(
      db,
      U.hodB,
      `UPDATE public.attendance_correction_requests SET status='approved'
        WHERE id = '00000000-0000-4000-8000-000000018001'`
    );
    expect(res.rows).toBe(1);
  });

  it("substitute date restriction removed → any date becomes writable", async () => {
    const db = await freshDb((sql) => sql.replace("AND sa.date = p_date", ""));
    await db.exec(
      `INSERT INTO public.substitution_assignments
         (college_id, offering_id, original_teacher_id, substitute_teacher_id, date, status)
       VALUES ('${COLLEGE}','${OFF_A}','${U.teacherA}','${U.substitute}','${DATE}','assigned')`
    );
    const res = await attempt(db, U.substitute, insertAttendance(OFF_A, STUDENT_B, "2026-12-25"));
    expect(res.ok).toBe(true);
  });

  it("substitute status check removed → an unaccepted 'needed' row authorizes writes", async () => {
    const db = await freshDb((sql) => sql.replace("AND sa.status = 'assigned'", ""));
    await db.exec(
      `INSERT INTO public.substitution_assignments
         (college_id, offering_id, original_teacher_id, substitute_teacher_id, date, status)
       VALUES ('${COLLEGE}','${OFF_A}','${U.teacherA}','${U.substitute}','${DATE}','needed')`
    );
    const res = await attempt(db, U.substitute, insertAttendance(OFF_A, STUDENT_B, DATE));
    expect(res.ok).toBe(true);
  });

  it("self-approval clause removed → requester can apply their own correction", async () => {
    // replaceAll: the separation-of-duties clause appears in both the USING
    // and the WITH CHECK half, and leaving either standing still denies.
    const db = await freshDb((sql) => sql.replaceAll("AND r.submitted_by  <> auth.uid()", ""));
    await db.exec(
      `INSERT INTO public.attendance_correction_requests
         (college_id, attendance_id, student_id, offering_id, date, current_status, requested_status, submitted_by, status, reviewed_by)
       VALUES ('${COLLEGE}','${ATT_1}','${STUDENT_A}','${OFF_A}','${DATE}','present','absent','${U.hodA}','approved','${U.hodA}')`
    );
    const res = await attempt(
      db,
      U.hodA,
      `UPDATE public.attendance SET status = 'absent' WHERE id = '${ATT_1}'`
    );
    expect(res.rows).toBe(1);
  });

  it("cancelled-offering check removed → a cancelled offering becomes writable", async () => {
    const db = await freshDb((sql) => sql.replace("AND o.status <> 'cancelled'\n      AND (", "AND ("));
    const res = await attempt(db, U.teacherA, insertAttendance(OFF_X));
    expect(res.ok).toBe(true);
  });

  it("post-image test weakened on marks UPDATE → offering_id can be rewritten", async () => {
    // Note what this mutation is NOT: simply deleting the WITH CHECK clause
    // proves nothing, because Postgres then applies the USING expression as
    // the post-image test. Verified by trying it — the write was still
    // refused. To actually reintroduce the defect the post-image test has to
    // be made permissive, which is what this does.
    const db = await freshDb((sql) =>
      sql.replace(
        `CREATE POLICY "marks_update_instructor" ON public.marks
  FOR UPDATE
  USING (
    college_id = public.get_my_college_id()
    AND public.can_write_offering_records(offering_id)
  )
  WITH CHECK (
    college_id = public.get_my_college_id()
    AND public.can_write_offering_records(offering_id)
  );`,
        `CREATE POLICY "marks_update_instructor" ON public.marks
  FOR UPDATE
  USING (
    college_id = public.get_my_college_id()
    AND public.can_write_offering_records(offering_id)
  )
  WITH CHECK (true);`
      )
    );
    const res = await attempt(
      db,
      U.teacherA,
      `UPDATE public.marks SET offering_id = '${OFF_B}' WHERE offering_id = '${OFF_A}'`
    );
    expect(res.ok).toBe(true);
    expect(res.rows).toBe(1);
  });

  it("old broad policy left in place → the narrow one is bypassed", async () => {
    // The permissive-OR failure mode: if 047 stops dropping
    // marks_teacher_manage, any teacher writes any offering again.
    const db = await freshDb((sql) =>
      sql.replace('DROP POLICY IF EXISTS "marks_teacher_manage" ON public.marks;', "")
    );
    const res = await attempt(db, U.teacherA, insertMarks(OFF_B));
    expect(res.ok).toBe(true);
  });

  it("control: without any mutation every one of those is refused", async () => {
    const db = await freshDb();
    const before = await countRows(db, ATT_COUNT);
    expect((await attempt(db, U.teacherA, insertAttendance(OFF_B))).ok).toBe(false);
    expect((await attempt(db, U.hodA, insertAttendance(OFF_A))).ok).toBe(false);
    expect((await attempt(db, U.teacherA, insertAttendance(OFF_X))).ok).toBe(false);
    expect((await attempt(db, U.teacherA, insertMarks(OFF_B))).ok).toBe(false);
    expect(await countRows(db, ATT_COUNT)).toBe(before);
  });
});

// ===========================================================================
// Offering identity — what actually distinguishes one delivery from another.
// These assert the model itself, at the database, rather than any one policy.
// ===========================================================================

const OFF_PAST = "00000000-0000-4000-8000-000000013005"; // same course+section as OFF_A, earlier semester

describe("offering identity", () => {
  it("same course, different section → different offerings", async () => {
    const db = await freshDb();
    const res = await db.query<{ id: string; course_id: string; section_id: string }>(
      `SELECT id, course_id, section_id FROM public.course_offerings
        WHERE id IN ('${OFF_A}', '${OFF_H}')`
    );
    const [a, h] = [res.rows.find((r) => r.id === OFF_A)!, res.rows.find((r) => r.id === OFF_H)!];
    expect(a.course_id).toBe(h.course_id);
    expect(a.section_id).not.toBe(h.section_id);
    expect(a.id).not.toBe(h.id);
  });

  it("same course, same section, different semester → different offerings", async () => {
    const db = await freshDb();
    const res = await db.query<{ id: string; course_id: string; section_id: string; semester_id: string }>(
      `SELECT id, course_id, section_id, semester_id FROM public.course_offerings
        WHERE id IN ('${OFF_A}', '${OFF_PAST}')`
    );
    const [now, past] = [res.rows.find((r) => r.id === OFF_A)!, res.rows.find((r) => r.id === OFF_PAST)!];
    expect(now.course_id).toBe(past.course_id);
    expect(now.section_id).toBe(past.section_id);
    expect(now.semester_id).not.toBe(past.semester_id);
  });

  it("authority follows the offering's instructor, not the course", async () => {
    // Teacher A holds this semester's offering; Teacher B held last
    // semester's — same course, same section. Each may write only their own.
    const db = await freshDb();

    expect((await attempt(db, U.teacherA, insertAttendance(OFF_A))).ok).toBe(true);
    expect((await attempt(db, U.teacherA, insertAttendance(OFF_PAST, STUDENT_A, "2026-03-02"))).ok).toBe(false);
    expect((await attempt(db, U.teacherB, insertAttendance(OFF_PAST, STUDENT_B, "2026-03-02"))).ok).toBe(true);
  });

  it("historical records stay addressable and attributed to their own term", async () => {
    // Taking over a course confers nothing over the predecessor's semester,
    // and the predecessor keeps their own — a register is a record of what
    // happened, not a function of who teaches now.
    const db = await freshDb();
    await db.exec(
      `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
       VALUES ('${COLLEGE}','${OFF_PAST}','${STUDENT_A}','2026-03-02','present','${U.teacherB}')`
    );

    const rows = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.attendance WHERE offering_id = '${OFF_PAST}'`
    );
    expect(Number(rows.rows[0].n)).toBe(1);

    const overwrite = await attempt(
      db,
      U.teacherA,
      `UPDATE public.attendance SET status = 'absent' WHERE offering_id = '${OFF_PAST}'`
    );
    expect(overwrite.rows).toBe(0);

    const after = await db.query<{ status: string }>(
      `SELECT status FROM public.attendance WHERE offering_id = '${OFF_PAST}'`
    );
    expect(after.rows[0].status).toBe("present");
  });

  it("a completed offering still accepts marks from its own instructor", async () => {
    // Only 'cancelled' closes an offering to writes — end-of-term marks
    // legitimately land against a completed one.
    const db = await freshDb();
    const res = await attempt(db, U.teacherB, insertMarks(OFF_PAST, STUDENT_A, "final"));
    expect(res.ok).toBe(true);
    expect(res.rows).toBe(1);
  });
});
