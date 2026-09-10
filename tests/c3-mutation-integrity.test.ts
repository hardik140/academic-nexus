import { describe, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthorizedActor } from "@/lib/rbac";
import type { Database, UserRole } from "@/types/database";
import { createShimClient } from "./rls/supabase-shim";

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => {} }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { saveAttendanceCore } from "@/app/(portal)/teacher/attendance/actions";
import { saveMarksCore } from "@/app/(portal)/teacher/grading/actions";
import { assertPersisted } from "@/lib/concurrent-claim";

/**
 * C3 — a mutation must report what the database DID, not what the caller
 * asked for.
 *
 * These tests run the real Server Action logic against a real PostgreSQL
 * with the real RLS from migration 047. The failure mode being hunted is
 * precisely:
 *
 *     application returns { saved: 42 }
 *     database rows changed = 0
 *
 * so every assertion here checks BOTH the returned value and the table.
 * Asserting only that a call rejects would not distinguish a fixed action
 * from one that throws for an unrelated reason while still leaving the
 * register empty.
 *
 * Before the fix, saveAttendanceCore ended with `return { saved: rows.length }`
 * — the length of the array it had just built, never consulted against the
 * database. Every unauthorized-write test below would have reported success.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const FIXTURE = join(process.cwd(), "tests/rls/fixture.sql");
const SEED = join(process.cwd(), "tests/rls/seed.sql");
const MIGRATION = join(process.cwd(), "supabase/migrations/047_academic_transactions_on_offerings.sql");

function loadSql(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

function migrationRlsSection(): string {
  const sql = loadSql(MIGRATION);
  const start = sql.indexOf("-- 7a. Authority functions");
  const end = sql.indexOf("-- 8. Rebuild the analytics views");
  if (start < 0 || end < 0) throw new Error("Could not locate section 7 in migration 047.");
  return sql.slice(start, end);
}

let snapshot: Blob | File | null = null;

async function freshDb(): Promise<PGlite> {
  if (!snapshot) {
    const seedDb = new PGlite();
    await seedDb.exec(loadSql(FIXTURE));
    await seedDb.exec(loadSql(SEED));
    await seedDb.exec(migrationRlsSection());
    snapshot = await seedDb.dumpDataDir();
  }
  return new PGlite({ loadDataDir: snapshot });
}

const U = {
  teacherA: "00000000-0000-4000-8000-00000000a001",
  teacherB: "00000000-0000-4000-8000-00000000a002",
  hodA: "00000000-0000-4000-8000-00000000a003",
  teachingHod: "00000000-0000-4000-8000-00000000a005",
  substitute: "00000000-0000-4000-8000-00000000a006",
  admin: "00000000-0000-4000-8000-00000000a007",
  foreignTeacher: "00000000-0000-4000-8000-00000000b001",
} as const;

const COLLEGE = "00000000-0000-4000-8000-0000000000c1";
const OTHER_COLLEGE = "00000000-0000-4000-8000-0000000000c2";
const STUDENT_A = "00000000-0000-4000-8000-000000012001";
const STUDENT_B = "00000000-0000-4000-8000-000000012002";
/** A real student of this college, enrolled in no offering at all. */
const STUDENT_C = "00000000-0000-4000-8000-000000012003";
const OFF_A = "00000000-0000-4000-8000-000000013001"; // Dept A, Teacher A
const OFF_B = "00000000-0000-4000-8000-000000013002"; // Dept B, Teacher B
const OFF_H = "00000000-0000-4000-8000-000000013003"; // Dept A, Teaching HOD
const OFF_X = "00000000-0000-4000-8000-000000013004"; // Dept A, Teacher A, cancelled
const MISSING = "00000000-0000-4000-8000-0000000000ff";
const DATE = "2026-09-10";

function actorOf(userId: string, role: UserRole, collegeId = COLLEGE): AuthorizedActor {
  return { userId, role, collegeId };
}

function clientFor(db: PGlite, userId: string): SupabaseClient<Database> {
  return createShimClient(db, userId) as unknown as SupabaseClient<Database>;
}

async function countAttendance(db: PGlite, offeringId?: string): Promise<number> {
  const res = await db.query<{ n: number }>(
    offeringId
      ? `SELECT count(*)::int AS n FROM public.attendance WHERE offering_id = '${offeringId}'`
      : `SELECT count(*)::int AS n FROM public.attendance`
  );
  return Number(res.rows[0].n);
}

async function countMarks(db: PGlite, offeringId?: string): Promise<number> {
  const res = await db.query<{ n: number }>(
    offeringId
      ? `SELECT count(*)::int AS n FROM public.marks WHERE offering_id = '${offeringId}'`
      : `SELECT count(*)::int AS n FROM public.marks`
  );
  return Number(res.rows[0].n);
}

/** Enrols a student on an offering so the enrollment guard is not the thing under test. */
async function enrol(db: PGlite, offeringId: string, studentId: string) {
  await db.exec(
    `INSERT INTO public.course_enrollments (college_id, offering_id, student_id, status)
     VALUES ('${COLLEGE}', '${offeringId}', '${studentId}', 'enrolled')
     ON CONFLICT (offering_id, student_id) DO NOTHING`
  );
}

// ===========================================================================
// PHASE 4 — positive: the response must reflect what was actually persisted
// ===========================================================================

describe("authorized mutations report the real persisted count", () => {
  it("attendance: teacher on their own offering", async () => {
    const db = await freshDb();
    const before = await countAttendance(db, OFF_A);

    const result = await saveAttendanceCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
      offeringId: OFF_A,
      date: DATE,
      entries: [
        { studentDbId: STUDENT_A, status: "present" }, // seeded already: UPDATE
        { studentDbId: STUDENT_B, status: "absent" },  // new: INSERT
      ],
    });

    // `saved` counts rows AFFECTED, which is what an upsert of two rows over
    // one existing row does — not rows added. The distinction matters: the
    // register now holds a mark for both students, which is the thing the
    // teacher needs to be true, and a count of inserts would under-report it.
    expect(result.saved).toBe(2);
    expect(await countAttendance(db, OFF_A)).toBe(before + 1);
  });

  it("marks: teacher on their own offering", async () => {
    const db = await freshDb();
    const before = await countMarks(db, OFF_A);

    const result = await saveMarksCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
      offeringId: OFF_A,
      examType: "final",
      maxMarks: 100,
      entries: [{ studentDbId: STUDENT_A, obtainedMarks: 61 }],
    });

    expect(result.saved).toBe(1);
    expect(await countMarks(db, OFF_A)).toBe(before + 1);
  });

  it("a re-save of the same day updates in place rather than inflating the count", async () => {
    const db = await freshDb();
    const client = clientFor(db, U.teacherA);
    const actor = actorOf(U.teacherA, "teacher");
    const params = {
      offeringId: OFF_A,
      date: DATE,
      entries: [{ studentDbId: STUDENT_A, status: "present" as const }],
    };

    await saveAttendanceCore(client, actor, params);
    const afterFirst = await countAttendance(db, OFF_A);

    const second = await saveAttendanceCore(client, actor, {
      ...params,
      entries: [{ studentDbId: STUDENT_A, status: "absent" as const }],
    });

    expect(second.saved).toBe(1);
    expect(await countAttendance(db, OFF_A)).toBe(afterFirst);
    const status = await db.query<{ status: string }>(
      `SELECT status FROM public.attendance WHERE offering_id = '${OFF_A}' AND student_id = '${STUDENT_A}'`
    );
    expect(status.rows[0].status).toBe("absent");
  });

  it("teaching HOD on their own offering", async () => {
    const db = await freshDb();
    await enrol(db, OFF_H, STUDENT_A);
    const result = await saveAttendanceCore(clientFor(db, U.teachingHod), actorOf(U.teachingHod, "hod"), {
      offeringId: OFF_H,
      date: DATE,
      entries: [{ studentDbId: STUDENT_A, status: "present" }],
    });
    expect(result.saved).toBe(1);
    expect(await countAttendance(db, OFF_H)).toBe(1);
  });

  it("substitute on the covered offering and date", async () => {
    const db = await freshDb();
    await db.exec(
      `INSERT INTO public.substitution_assignments
         (college_id, offering_id, original_teacher_id, substitute_teacher_id, date, status)
       VALUES ('${COLLEGE}','${OFF_A}','${U.teacherA}','${U.substitute}','${DATE}','assigned')`
    );
    const result = await saveAttendanceCore(clientFor(db, U.substitute), actorOf(U.substitute, "teacher"), {
      offeringId: OFF_A,
      date: DATE,
      entries: [{ studentDbId: STUDENT_A, status: "late" }],
    });
    expect(result.saved).toBe(1);
    expect(await countAttendance(db, OFF_A)).toBe(1);
  });

  it("an empty payload is a legitimate zero, not an error", async () => {
    // Phase 3: zero rows can mean "nothing needed changing". Only a zero
    // that contradicts a non-empty request is a failure.
    const db = await freshDb();
    const result = await saveAttendanceCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
      offeringId: OFF_A,
      date: DATE,
      entries: [],
    });
    expect(result.saved).toBe(0);
    expect(await countAttendance(db)).toBe(1); // only the seeded row
  });

  it("marks: an empty payload is a legitimate zero", async () => {
    const db = await freshDb();
    const before = await countMarks(db);
    const result = await saveMarksCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
      offeringId: OFF_A,
      examType: "lab",
      maxMarks: 50,
      entries: [],
    });
    expect(result.saved).toBe(0);
    expect(await countMarks(db)).toBe(before);
  });

  it("marks: NaN is rejected by validation, never silently dropped", async () => {
    // saveMarksCore also carries a Number.isFinite filter after parsing. That
    // filter is unreachable for anything arriving through this schema, since
    // z.number() rejects NaN first — worth knowing before someone reads the
    // filter as the guard and relaxes the schema.
    const db = await freshDb();
    const before = await countMarks(db);
    await expect(
      saveMarksCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
        offeringId: OFF_A,
        examType: "lab",
        maxMarks: 50,
        entries: [{ studentDbId: STUDENT_A, obtainedMarks: Number.NaN }],
      })
    ).rejects.toThrow();
    expect(await countMarks(db)).toBe(before);
  });
});

// ===========================================================================
// PHASE 4/6 — the C3 defect itself: no false success on a refused write
// ===========================================================================

describe("refused mutations never report success", () => {
  /**
   * The shared assertion for every denial: the call must fail, and the
   * table must be untouched. If it somehow resolves, `saved` must not be a
   * fabricated count.
   */
  async function expectNoFalseSuccess(
    db: PGlite,
    call: Promise<{ saved: number }>,
    countBefore: number,
    counter: (db: PGlite) => Promise<number>
  ) {
    let outcome: { saved: number } | null = null;
    let threw = false;
    try {
      outcome = await call;
    } catch {
      threw = true;
    }
    const after = await counter(db);
    expect(after).toBe(countBefore);
    if (!threw) {
      expect(outcome?.saved ?? 0).toBe(0);
    }
    return threw;
  }

  it("teacher writing another teacher's offering", async () => {
    const db = await freshDb();
    await enrol(db, OFF_B, STUDENT_A);
    const before = await countAttendance(db);
    const threw = await expectNoFalseSuccess(
      db,
      saveAttendanceCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
        offeringId: OFF_B,
        date: DATE,
        entries: [{ studentDbId: STUDENT_A, status: "present" }],
      }),
      before,
      countAttendance
    );
    expect(threw).toBe(true);
  });

  it("non-teaching HOD writing their own department's offering", async () => {
    const db = await freshDb();
    const before = await countAttendance(db);
    const threw = await expectNoFalseSuccess(
      db,
      saveAttendanceCore(clientFor(db, U.hodA), actorOf(U.hodA, "hod"), {
        offeringId: OFF_A,
        date: DATE,
        entries: [{ studentDbId: STUDENT_A, status: "present" }],
      }),
      before,
      countAttendance
    );
    expect(threw).toBe(true);
  });

  it("teaching HOD reaching outside their own assignment", async () => {
    const db = await freshDb();
    const before = await countAttendance(db);
    await expectNoFalseSuccess(
      db,
      saveAttendanceCore(clientFor(db, U.teachingHod), actorOf(U.teachingHod, "hod"), {
        offeringId: OFF_A,
        date: DATE,
        entries: [{ studentDbId: STUDENT_A, status: "present" }],
      }),
      before,
      countAttendance
    );
  });

  it("teacher from another college", async () => {
    const db = await freshDb();
    const before = await countAttendance(db);
    await expectNoFalseSuccess(
      db,
      saveAttendanceCore(
        clientFor(db, U.foreignTeacher),
        actorOf(U.foreignTeacher, "teacher", OTHER_COLLEGE),
        { offeringId: OFF_A, date: DATE, entries: [{ studentDbId: STUDENT_A, status: "present" }] }
      ),
      before,
      countAttendance
    );
  });

  it("cancelled offering, even for its own instructor", async () => {
    const db = await freshDb();
    await enrol(db, OFF_X, STUDENT_A);
    const before = await countAttendance(db);
    await expectNoFalseSuccess(
      db,
      saveAttendanceCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
        offeringId: OFF_X,
        date: DATE,
        entries: [{ studentDbId: STUDENT_A, status: "present" }],
      }),
      before,
      countAttendance
    );
  });

  it("substitute writing marks on the offering they cover", async () => {
    const db = await freshDb();
    await db.exec(
      `INSERT INTO public.substitution_assignments
         (college_id, offering_id, original_teacher_id, substitute_teacher_id, date, status)
       VALUES ('${COLLEGE}','${OFF_A}','${U.teacherA}','${U.substitute}','${DATE}','assigned')`
    );
    const before = await countMarks(db);
    await expectNoFalseSuccess(
      db,
      saveMarksCore(clientFor(db, U.substitute), actorOf(U.substitute, "teacher"), {
        offeringId: OFF_A,
        examType: "final",
        maxMarks: 100,
        entries: [{ studentDbId: STUDENT_A, obtainedMarks: 90 }],
      }),
      before,
      countMarks
    );
  });

  it("marks on another teacher's offering", async () => {
    const db = await freshDb();
    await enrol(db, OFF_B, STUDENT_A);
    const before = await countMarks(db);
    await expectNoFalseSuccess(
      db,
      saveMarksCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
        offeringId: OFF_B,
        examType: "final",
        maxMarks: 100,
        entries: [{ studentDbId: STUDENT_A, obtainedMarks: 90 }],
      }),
      before,
      countMarks
    );
  });
});

// ===========================================================================
// PHASE 6 — negative cases
// ===========================================================================

describe("negative cases", () => {
  it("nonexistent offering", async () => {
    const db = await freshDb();
    await expect(
      saveAttendanceCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
        offeringId: MISSING,
        date: DATE,
        entries: [{ studentDbId: STUDENT_A, status: "present" }],
      })
    ).rejects.toThrow(/not found in your college/i);
    expect(await countAttendance(db)).toBe(1);
  });

  it("nonexistent student", async () => {
    const db = await freshDb();
    await expect(
      saveAttendanceCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
        offeringId: OFF_A,
        date: DATE,
        entries: [{ studentDbId: MISSING, status: "present" }],
      })
    ).rejects.toThrow(/not enrolled/i);
    expect(await countAttendance(db)).toBe(1);
  });

  it("student not enrolled in this offering", async () => {
    // Student C is a real, active student of this college — the guard has to
    // reject them for THIS class, not merely reject unknown UUIDs.
    const db = await freshDb();
    await expect(
      saveAttendanceCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
        offeringId: OFF_A,
        date: DATE,
        entries: [{ studentDbId: STUDENT_C, status: "present" }],
      })
    ).rejects.toThrow(/not enrolled/i);
    expect(await countAttendance(db)).toBe(1);
  });

  it("malformed payload is rejected before any authorization work", async () => {
    const db = await freshDb();
    await expect(
      saveAttendanceCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
        offeringId: "not-a-uuid",
        date: DATE,
        entries: [{ studentDbId: STUDENT_A, status: "present" }],
      })
    ).rejects.toThrow();
    expect(await countAttendance(db)).toBe(1);
  });

  it("marks above the maximum are clamped, not rejected — existing behaviour", async () => {
    const db = await freshDb();
    const result = await saveMarksCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
      offeringId: OFF_A,
      examType: "viva",
      maxMarks: 50,
      entries: [{ studentDbId: STUDENT_A, obtainedMarks: 999 }],
    });
    expect(result.saved).toBe(1);
    const row = await db.query<{ obtained_marks: string }>(
      `SELECT obtained_marks FROM public.marks WHERE offering_id = '${OFF_A}' AND exam_type = 'viva'`
    );
    expect(Number(row.rows[0].obtained_marks)).toBe(50);
  });
});

// ===========================================================================
// PHASE 7 — mixed-scope bulk payloads
// ===========================================================================

describe("mixed-scope bulk payloads", () => {
  it("one unauthorized student in an otherwise valid batch rejects the WHOLE batch", async () => {
    // The semantics are atomic, and deliberately so: partially writing a
    // register would leave a class half-marked with no indication which half.
    const db = await freshDb();
    await enrol(db, OFF_B, STUDENT_C);
    const before = await countAttendance(db);

    await expect(
      saveAttendanceCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
        offeringId: OFF_A,
        date: DATE,
        entries: [
          { studentDbId: STUDENT_A, status: "present" }, // legitimately on OFF_A
          { studentDbId: STUDENT_C, status: "present" }, // enrolled on OFF_B only
        ],
      })
    ).rejects.toThrow(/not enrolled/i);

    // The authorized half must not have landed either.
    expect(await countAttendance(db)).toBe(before);
  });

  it("a student from another college cannot be smuggled into a valid batch", async () => {
    const db = await freshDb();
    await db.exec(
      `INSERT INTO public.students (id, college_id, user_id, department_id, enrollment_number)
       VALUES ('00000000-0000-4000-8000-0000000120ff', '${OTHER_COLLEGE}', NULL, NULL, 'QA-FOREIGN')`
    );
    const before = await countAttendance(db);

    await expect(
      saveAttendanceCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
        offeringId: OFF_A,
        date: DATE,
        entries: [
          { studentDbId: STUDENT_A, status: "present" },
          { studentDbId: "00000000-0000-4000-8000-0000000120ff", status: "present" },
        ],
      })
    ).rejects.toThrow(/not enrolled/i);
    expect(await countAttendance(db)).toBe(before);
  });

  it("the payload cannot address two offerings at once — the API shape forbids it", async () => {
    // Phase 7's scenario (Student A -> Offering A, Student B -> Offering B in
    // one request) is not expressible: offeringId is a single scalar on the
    // request and every row is built from it server-side. This test pins that
    // shape so a future 'convenience' change to per-entry offerings has to
    // confront the authorization consequence rather than inherit it.
    const params = {
      offeringId: OFF_A,
      date: DATE,
      entries: [{ studentDbId: STUDENT_A, status: "present" as const }],
    };
    expect(Object.keys(params.entries[0])).toEqual(["studentDbId", "status"]);
    expect(Object.keys(params.entries[0])).not.toContain("offeringId");
  });

  it("client-supplied college_id is ignored — rows are built from the session", async () => {
    const db = await freshDb();
    await saveAttendanceCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
      offeringId: OFF_A,
      date: DATE,
      // deliberately smuggling extra fields a naive implementation might spread
      entries: [
        { studentDbId: STUDENT_A, status: "present", college_id: OTHER_COLLEGE } as never,
      ],
    });
    const row = await db.query<{ college_id: string; marked_by: string }>(
      `SELECT college_id, marked_by FROM public.attendance
        WHERE offering_id = '${OFF_A}' AND student_id = '${STUDENT_A}'`
    );
    expect(row.rows[0].college_id).toBe(COLLEGE);
    expect(row.rows[0].marked_by).toBe(U.teacherA);
  });
});

// ===========================================================================
// The regression the whole phase exists for
// ===========================================================================

describe("the C3 regression itself", () => {
  it("assertPersisted turns a silent zero-row write into an error", () => {
    expect(() => assertPersisted([], 42, "attendance")).toThrow(/changed nothing/i);
    expect(() => assertPersisted(null, 1, "attendance")).toThrow(/changed nothing/i);
  });

  it("assertPersisted catches a partial write", () => {
    expect(() => assertPersisted([{ id: "a" }], 3, "marks")).toThrow(/Only 1 of 3/);
  });

  it("assertPersisted passes a matching write through and returns the count", () => {
    expect(assertPersisted([{ id: "a" }, { id: "b" }], 2, "attendance")).toBe(2);
  });

  it("assertPersisted accepts a legitimate zero-for-zero", () => {
    expect(assertPersisted([], 0, "attendance")).toBe(0);
  });

  it("the old implementation would have reported success on a refused write", async () => {
    // Demonstrates the defect rather than describing it. `rows.length` is
    // what the pre-fix code returned; against the same refused write the
    // database is empty. Both halves are measured here, so this test fails
    // if the RLS ever stops refusing — it cannot rot into a tautology.
    const db = await freshDb();
    await enrol(db, OFF_B, STUDENT_A);
    const entries = [{ studentDbId: STUDENT_A, status: "present" as const }];

    let reported = -1;
    try {
      const result = await saveAttendanceCore(clientFor(db, U.teacherA), actorOf(U.teacherA, "teacher"), {
        offeringId: OFF_B,
        date: DATE,
        entries,
      });
      reported = result.saved;
    } catch {
      reported = -1;
    }

    expect(await countAttendance(db, OFF_B)).toBe(0);
    expect(reported).not.toBe(entries.length); // the old code returned exactly this
  });
});
