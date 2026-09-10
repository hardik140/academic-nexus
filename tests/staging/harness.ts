import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A disposable PostgreSQL carrying the repository's REAL migration chain.
 *
 * WHAT MAKES THIS DIFFERENT FROM tests/rls/fixture.sql
 *
 * The existing RLS suite installs a hand-written post-046 schema and then
 * executes section 7 of migration 047. That answers "is the policy logic
 * right". It cannot answer "does this repository's migration history
 * actually produce that schema", because the schema under test was written
 * by hand to match.
 *
 * This harness applies platform.sql and then every file in
 * supabase/migrations in order, unedited — 001 through 047. The only
 * hand-written SQL is the Supabase platform layer (auth schema, auth.uid(),
 * the three PostgREST roles, default privileges), which is not part of the
 * repository and has to come from somewhere.
 *
 * WHAT IT IS NOT
 *
 * Not Supabase. PostgREST and GoTrue are absent: there is no HTTP layer, no
 * JWT verification, no connection pooler. Statements arrive as SQL rather
 * than as PostgREST's translation of a query string. So this proves what
 * the DATABASE does when a request arrives as a given role with a given
 * claim — which is the last line of defence, and the one that holds when
 * the application is bypassed — and proves nothing about the layers above.
 *
 * Anything asserted with this harness should be reported as
 * "disposable PostgreSQL", never as "staging verified".
 */

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, "supabase/migrations");

function loadSql(path: string): string {
  // The migrations are CRLF on disk (Windows checkout). Postgres copes, but
  // any code here that slices or matches the text would not.
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/** Every migration file, in the order the CLI would apply them. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export interface ApplyStep {
  file: string;
  ms: number;
  error: string | null;
}

/**
 * Applies the chain to a fresh database and reports every step.
 *
 * Errors are collected rather than thrown so a failure names the file that
 * failed and the suite can still report the ones that came before it — a
 * migration test whose only output is a stack trace makes the reader guess
 * how far it got.
 */
export async function applyFullChain(db: PGlite): Promise<ApplyStep[]> {
  const steps: ApplyStep[] = [];
  await db.exec(loadSql(join(ROOT, "tests/staging/platform.sql")));

  for (const file of migrationFiles()) {
    const started = Date.now();
    try {
      await db.exec(loadSql(join(MIGRATIONS_DIR, file)));
      steps.push({ file, ms: Date.now() - started, error: null });
    } catch (err) {
      steps.push({ file, ms: Date.now() - started, error: (err as Error).message });
      break;
    }
  }
  return steps;
}

/**
 * Snapshot of {chain + QA dataset}, built once and restored per test.
 *
 * Restoring a data directory costs roughly a third of a cold boot, and every
 * test needs its own database: a shared one would let an earlier test's
 * INSERT satisfy a later test's precondition, which in a security suite is
 * indistinguishable from the bug it is meant to catch.
 */
let seeded: Blob | File | null = null;

async function buildSnapshot(): Promise<void> {
  if (seeded) return;
  const db = new PGlite();
  const steps = await applyFullChain(db);
  const failed = steps.find((s) => s.error);
  if (failed) {
    throw new Error(`Migration chain failed at ${failed.file}: ${failed.error}`);
  }
  await db.exec(loadSql(join(ROOT, "tests/staging/qa-dataset.sql")));
  seeded = await db.dumpDataDir();
  await db.close();
}

/** A migrated, seeded, disposable database of its own. */
export async function stagingDb(): Promise<PGlite> {
  await buildSnapshot();
  return new PGlite({ loadDataDir: seeded! });
}

// ─────────────────────────────────────────────────────────────
// Identities
// ─────────────────────────────────────────────────────────────

export const U = {
  hodCse: "00000003-0000-4000-8000-000000000001", // ALSO an instructor
  hodEce: "00000003-0000-4000-8000-000000000002",
  teacherA: "00000003-0000-4000-8000-000000000003",
  teacherB: "00000003-0000-4000-8000-000000000004",
  teacherC: "00000003-0000-4000-8000-000000000005",
  studentA: "00000003-0000-4000-8000-000000000006",
  studentB: "00000003-0000-4000-8000-000000000007",
  studentC: "00000003-0000-4000-8000-000000000008",
  studentD: "00000003-0000-4000-8000-000000000009",
  studentE: "00000003-0000-4000-8000-00000000000a",
  studentF: "00000003-0000-4000-8000-00000000000b",
  director: "00000003-0000-4000-8000-00000000000c",
  finance: "00000003-0000-4000-8000-00000000000d",
  warden: "00000003-0000-4000-8000-00000000000e",
  admin: "00000003-0000-4000-8000-00000000000f",
  superAdmin: "00000003-0000-4000-8000-000000000010",
  hodMech: "00000003-0000-4000-8000-000000000014",
  bTeacher: "00000003-0000-4000-8000-000000000011",
  bStudent: "00000003-0000-4000-8000-000000000012",
  bHod: "00000003-0000-4000-8000-000000000013",
} as const;

/** students(id) — NOT profiles(id). 047 made these distinct id spaces. */
export const S = {
  a: "00000004-0000-4000-8000-000000000001",
  b: "00000004-0000-4000-8000-000000000002",
  c: "00000004-0000-4000-8000-000000000003",
  d: "00000004-0000-4000-8000-000000000004",
  e: "00000004-0000-4000-8000-000000000005",
  f: "00000004-0000-4000-8000-000000000006",
  bStudent: "00000004-0000-4000-8000-000000000007",
} as const;

export const OFF = {
  /** Data Structures / CSE-A / Sem 3 / Teacher A */
  dsA3: "0000000a-0000-4000-8000-000000000001",
  /** Data Structures / CSE-B / Sem 3 / Teacher B — same course, other section */
  dsB3: "0000000a-0000-4000-8000-000000000002",
  /** Data Structures / CSE-A / Sem 5 / Teacher C — same course and section name */
  dsA5: "0000000a-0000-4000-8000-000000000003",
  dbmsA3: "0000000a-0000-4000-8000-000000000004",
  dbmsB3: "0000000a-0000-4000-8000-000000000005",
  /** Operating Systems / CSE-A / Sem 3 / HOD-CSE as instructor */
  osHod: "0000000a-0000-4000-8000-000000000006",
  /** ECE department, for HOD review scope */
  ece: "0000000a-0000-4000-8000-000000000007",
  /** 2025-26 delivery of Data Structures / CSE-A */
  historical: "0000000a-0000-4000-8000-000000000008",
  /** Cancelled, Teacher A still named as instructor */
  cancelled: "0000000a-0000-4000-8000-000000000009",
  /**
   * A SERVICE COURSE: Engineering Mathematics, owned by Mechanical, taught
   * to a CSE section. Teaching department and receiving department disagree,
   * which is what makes the authority predicate falsifiable.
   */
  service: "0000000a-0000-4000-8000-00000000000b",
  /** College B */
  collegeB: "0000000a-0000-4000-8000-00000000000a",
} as const;

export const COLLEGE_A = "00000001-0000-4000-8000-000000000001";
export const COLLEGE_B = "00000001-0000-4000-8000-000000000002";
export const DEPT_CSE = "00000002-0000-4000-8000-000000000001";
export const DEPT_ECE = "00000002-0000-4000-8000-000000000002";
export const DEPT_MECH = "00000002-0000-4000-8000-000000000003";
/** Engineering Mathematics — owned by Mechanical. */
export const COURSE_MATHS = "00000009-0000-4000-8000-000000000005";
export const SEM_3 = "00000006-0000-4000-8000-000000000003";
export const SEM_5 = "00000006-0000-4000-8000-000000000005";
export const SEM_PAST = "00000006-0000-4000-8000-000000000009";
export const COURSE_DS = "00000009-0000-4000-8000-000000000001";

/** A weekday inside QA Semester 3. */
export const DATE = "2026-09-10";

// ─────────────────────────────────────────────────────────────
// Executing as a user
// ─────────────────────────────────────────────────────────────

export interface Attempt {
  ok: boolean;
  error: string | null;
  rows: number;
  data: Record<string, unknown>[];
}

/**
 * Runs SQL the way a request arrives: the JWT claim first, then the limited
 * role. In that order deliberately — PostgREST sets the claim while still
 * connected as the pooler user, and `authenticated` never gets to choose its
 * own subject.
 *
 * Returns the error AND the affected row count, because RLS denies in two
 * ways and only one is loud. An INSERT blocked by WITH CHECK raises 42501; an
 * UPDATE or DELETE blocked by USING quietly affects zero rows and reports
 * success. The quiet one is the entire C3 defect class, so a helper that
 * returned only `ok` would hide exactly what these tests exist to find.
 */
export async function as(
  db: PGlite,
  uid: string,
  sql: string,
  params: unknown[] = []
): Promise<Attempt> {
  await db.exec(`SET request.jwt.claim.sub = '${uid}'; SET ROLE authenticated;`);
  try {
    const res = await db.query<Record<string, unknown>>(sql, params);
    return { ok: true, error: null, rows: res.affectedRows ?? 0, data: res.rows ?? [] };
  } catch (err) {
    return { ok: false, error: (err as Error).message, rows: 0, data: [] };
  } finally {
    await db.exec("RESET ROLE; RESET request.jwt.claim.sub;");
  }
}

/**
 * Reads as the database owner, bypassing RLS.
 *
 * ONLY for verifying the postcondition — "did the row actually change" — and
 * never for the action under test. A test that both acted and checked through
 * this would prove nothing about authorization at all.
 */
export async function verify<T = Record<string, unknown>>(
  db: PGlite,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows ?? [];
}

/** Convenience: the single scalar a verification query returns. */
export async function scalar(db: PGlite, sql: string, params: unknown[] = []): Promise<unknown> {
  const rows = await verify<Record<string, unknown>>(db, sql, params);
  return rows.length ? Object.values(rows[0])[0] : undefined;
}
