import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthorizedActor } from "@/lib/rbac";
import type { Database } from "@/types/database";
import type { UserRole } from "@/types/database";
import {
  loadOffering,
  canWriteOfferingRecords,
  assertCanWriteOfferingRecords,
  assertCanRecordAttendance,
  assertOfferingInReviewScope,
  resolveHodDepartmentIds,
  listTeachableOfferings,
  getActiveSemesterId,
  type OfferingContext,
} from "@/lib/offerings";

/**
 * Authority-boundary tests for lib/offerings.ts.
 *
 * The fake client below does NOT return canned rows per call site. It records
 * the .eq() predicates and filters seeded fixture tables with them, so a test
 * that passes has actually proved the query is scoped — "does listTeachable
 * filter by instructor_id" is answered by the data, not by a stub that was
 * told to say yes. A helper that dropped its scoping filter would return
 * every seeded row and the test would fail.
 *
 * Embedded selects (`courses:course_id(department_id)`) are resolved from the
 * fixture tables the same way PostgREST would, because the department a HOD
 * is scoped against arrives through exactly that join.
 */

type Row = Record<string, unknown>;

interface Fixtures {
  course_offerings: Row[];
  courses: Row[];
  sections: Row[];
  departments: Row[];
  semesters: Row[];
  substitution_assignments: Row[];
}

/** Expands `courses:course_id(department_id)` etc. against the fixtures. */
function embed(table: string, row: Row, select: string, db: Fixtures): Row {
  const out = { ...row };
  const embeds = select.matchAll(/(\w+):(\w+)\(([^)]*)\)/g);
  for (const [, alias, fk, cols] of embeds) {
    const target = (db as unknown as Record<string, Row[]>)[alias];
    if (!target) continue;
    const parent = target.find((t) => t.id === row[fk]);
    out[alias] = parent
      ? Object.fromEntries(cols.split(",").map((c) => [c.trim(), parent[c.trim()]]))
      : null;
  }
  void table;
  return out;
}

function makeClient(db: Fixtures) {
  const calls: { table: string; filters: [string, unknown][] }[] = [];

  const client = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      let select = "";
      calls.push({ table, filters });

      const run = () => {
        const rows = ((db as unknown as Record<string, Row[]>)[table] ?? []).filter((r) =>
          filters.every(([col, val]) => r[col] === val)
        );
        return rows.map((r) => embed(table, r, select, db));
      };

      const builder = {
        select(cols: string) {
          select = cols;
          return builder;
        },
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return builder;
        },
        maybeSingle() {
          const rows = run();
          // Mirrors PostgREST: more than one row is an error, not a pick-first.
          if (rows.length > 1) return Promise.resolve({ data: null, error: { message: "multiple rows" } });
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve({ data: run(), error: null }).then(resolve);
        },
      };
      return builder;
    },
    _calls: calls,
  };

  return client as unknown as SupabaseClient<Database> & { _calls: typeof calls };
}

// ---------------------------------------------------------------- fixtures

const COLLEGE = "college-1";
const OTHER_COLLEGE = "college-2";

const DEPT_A = "dept-a";
const DEPT_B = "dept-b";

const TEACHER_A = "teacher-a";
const TEACHER_B = "teacher-b";
const HOD_A = "hod-a";
const HOD_B = "hod-b";
const HOD_TEACHING = "hod-teaching";
const HOD_TWO_DEPTS = "hod-two-depts";
const SUBSTITUTE = "substitute-1";
const ADMIN = "admin-1";

/** Offering held by Teacher A, in Department A. */
const OFF_A = "off-a";
/** Offering held by Teacher B, in Department B. */
const OFF_B = "off-b";
/** Offering in Department A held by a HOD who also teaches. */
const OFF_HOD = "off-hod";
/** Offering in Department A with nobody assigned. */
const OFF_UNASSIGNED = "off-unassigned";
/** Cancelled offering, otherwise held by Teacher A. */
const OFF_CANCELLED = "off-cancelled";
/** Offering belonging to a different college entirely. */
const OFF_FOREIGN = "off-foreign";
/** Offering whose course row carries no department. */
const OFF_ORPHANED = "off-orphaned";
/** Last semester's offering of the same course, still held by Teacher A. */
const OFF_HISTORIC = "off-historic";

const SEM_CURRENT = "sem-current";
const SEM_PAST = "sem-past";

function fixtures(): Fixtures {
  return {
    courses: [
      { id: "course-a", department_id: DEPT_A, name: "Data Structures", code: "CS201" },
      { id: "course-b", department_id: DEPT_B, name: "Thermodynamics", code: "ME201" },
      { id: "course-orphan", department_id: null, name: "Broken", code: "XX000" },
    ],
    sections: [
      { id: "sec-1", name: "A", batch_year: 2024 },
      { id: "sec-2", name: "B", batch_year: 2024 },
    ],
    departments: [
      { id: DEPT_A, hod_id: HOD_A },
      { id: DEPT_B, hod_id: HOD_B },
    ],
    semesters: [
      { id: SEM_CURRENT, college_id: COLLEGE, status: "active" },
      { id: SEM_PAST, college_id: COLLEGE, status: "closed" },
    ],
    substitution_assignments: [],
    course_offerings: [
      offering(OFF_A, { course_id: "course-a", instructor_id: TEACHER_A }),
      offering(OFF_B, { course_id: "course-b", instructor_id: TEACHER_B, section_id: "sec-2" }),
      offering(OFF_HOD, { course_id: "course-a", instructor_id: HOD_TEACHING, section_id: "sec-2" }),
      offering(OFF_UNASSIGNED, { course_id: "course-a", instructor_id: null }),
      offering(OFF_CANCELLED, { course_id: "course-a", instructor_id: TEACHER_A, status: "cancelled" }),
      offering(OFF_ORPHANED, { course_id: "course-orphan", instructor_id: TEACHER_A }),
      offering(OFF_HISTORIC, { course_id: "course-a", instructor_id: TEACHER_A, semester_id: SEM_PAST }),
      offering(OFF_FOREIGN, { course_id: "course-b", instructor_id: TEACHER_A, college_id: OTHER_COLLEGE }),
    ],
  };
}

function offering(id: string, over: Row = {}): Row {
  return {
    id,
    college_id: COLLEGE,
    semester_id: SEM_CURRENT,
    course_id: "course-a",
    section_id: "sec-1",
    instructor_id: null,
    status: "active",
    ...over,
  };
}

function actorOf(userId: string, role: UserRole, collegeId = COLLEGE): AuthorizedActor {
  return { userId, role, collegeId };
}

const teacherA = actorOf(TEACHER_A, "teacher");
const teacherB = actorOf(TEACHER_B, "teacher");
const hodA = actorOf(HOD_A, "hod");
const hodB = actorOf(HOD_B, "hod");
const hodTeaching = actorOf(HOD_TEACHING, "hod");
const admin = actorOf(ADMIN, "admin");

/** Loads a context straight from fixtures, for the pure-predicate tests. */
async function ctx(offeringId: string, actor: AuthorizedActor = admin): Promise<OfferingContext> {
  return loadOffering(makeClient(fixtures()), actor, offeringId);
}

// ------------------------------------------------------------ TEACHER SCOPE

describe("teacher write authority", () => {
  it("allows the assigned instructor to write their own offering", async () => {
    const db = makeClient(fixtures());
    const offering = await assertCanWriteOfferingRecords(db, teacherA, OFF_A);
    expect(offering.id).toBe(OFF_A);
    expect(offering.departmentId).toBe(DEPT_A);
  });

  it("denies a teacher another instructor's offering", async () => {
    const db = makeClient(fixtures());
    await expect(assertCanWriteOfferingRecords(db, teacherA, OFF_B)).rejects.toThrow(
      /only record academic records for course offerings assigned to you/i
    );
  });

  it("denies write by ID manipulation — sending a foreign offeringId proves nothing", async () => {
    // Teacher B asks to write Teacher A's offering by simply naming its id.
    // Nothing in the request is trusted; the server re-reads the assignment.
    const db = makeClient(fixtures());
    await expect(assertCanWriteOfferingRecords(db, teacherB, OFF_A)).rejects.toThrow();
  });

  it("denies an offering with no instructor assigned", async () => {
    const db = makeClient(fixtures());
    await expect(assertCanWriteOfferingRecords(db, teacherA, OFF_UNASSIGNED)).rejects.toThrow();
  });

  it("denies a cancelled offering even to its own instructor", async () => {
    const db = makeClient(fixtures());
    await expect(assertCanWriteOfferingRecords(db, teacherA, OFF_CANCELLED)).rejects.toThrow();
  });

  it("still allows the historic offering the teacher actually held", async () => {
    // Authority follows the offering, and an offering is semester-scoped, so
    // last semester's records stay reachable by whoever held THAT offering —
    // current-semester assignment does not reach backwards or forwards.
    const db = makeClient(fixtures());
    const offering = await assertCanWriteOfferingRecords(db, teacherA, OFF_HISTORIC);
    expect(offering.semesterId).toBe(SEM_PAST);
  });

  it("does not let a successor rewrite a predecessor's semester", async () => {
    // Teacher B now teaches course-a in the current semester (OFF_A reassigned)
    // but the PAST semester's offering is a different row with its own
    // instructor, so B gains nothing historical.
    const db = makeClient(fixtures());
    await expect(assertCanWriteOfferingRecords(db, teacherB, OFF_HISTORIC)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- HOD SCOPE

describe("hod authority", () => {
  it("denies a HOD blanket write over their own department's offering", async () => {
    // The load-bearing separation of duties: a HOD reviews what a teacher
    // recorded, and cannot become the recorder. OFF_A is in Department A,
    // which HOD_A heads, and they are still denied.
    const db = makeClient(fixtures());
    await expect(assertCanWriteOfferingRecords(db, hodA, OFF_A)).rejects.toThrow();
  });

  it("allows a teaching HOD to write the offering they are assigned to", async () => {
    const db = makeClient(fixtures());
    const offering = await assertCanWriteOfferingRecords(db, hodTeaching, OFF_HOD);
    expect(offering.instructorId).toBe(HOD_TEACHING);
  });

  it("grants a teaching HOD nothing beyond that one offering", async () => {
    // Multi-role union, correctly bounded: teacher-side write on their own
    // offering, HOD-side review on the department — never HOD-side write.
    const db = makeClient(fixtures());
    await expect(assertCanWriteOfferingRecords(db, hodTeaching, OFF_A)).rejects.toThrow();
  });

  it("allows department-scoped review of an offering in their own department", async () => {
    const db = makeClient(fixtures());
    await expect(assertOfferingInReviewScope(db, hodA, await ctx(OFF_A))).resolves.toBeUndefined();
  });

  it("denies review of another department's offering", async () => {
    const db = makeClient(fixtures());
    await expect(assertOfferingInReviewScope(db, hodA, await ctx(OFF_B))).rejects.toThrow(
      /only act on course offerings in your own department/i
    );
  });

  it("ignores a department_id the caller supplies — scope comes from departments.hod_id", async () => {
    // HOD B presents Department A's offering. There is no request field that
    // could change the answer: scope is re-derived from hod_id server-side.
    const db = makeClient(fixtures());
    await expect(assertOfferingInReviewScope(db, hodB, await ctx(OFF_A))).rejects.toThrow();
  });

  it("fails closed for a hod who heads no department", async () => {
    const db = makeClient(fixtures());
    const orphanHod = actorOf("hod-nowhere", "hod");
    await expect(assertOfferingInReviewScope(db, orphanHod, await ctx(OFF_A))).rejects.toThrow();
  });

  it("resolves BOTH departments for a HOD who heads two", async () => {
    // departments.hod_id has no unique constraint (migration 002). The
    // single-row form of this query resolves such a HOD to null and silently
    // denies them everything.
    const db = fixtures();
    db.departments = [
      { id: DEPT_A, hod_id: HOD_TWO_DEPTS },
      { id: DEPT_B, hod_id: HOD_TWO_DEPTS },
    ];
    const client = makeClient(db);
    const actor = actorOf(HOD_TWO_DEPTS, "hod");

    expect(await resolveHodDepartmentIds(client, actor)).toEqual([DEPT_A, DEPT_B]);
    await expect(assertOfferingInReviewScope(client, actor, await ctx(OFF_A))).resolves.toBeUndefined();
    await expect(assertOfferingInReviewScope(client, actor, await ctx(OFF_B))).resolves.toBeUndefined();
  });

  it("still denies a two-department HOD a department they do not head", async () => {
    const db = fixtures();
    db.departments = [{ id: DEPT_A, hod_id: HOD_TWO_DEPTS }, { id: DEPT_B, hod_id: HOD_B }];
    const client = makeClient(db);
    await expect(
      assertOfferingInReviewScope(client, actorOf(HOD_TWO_DEPTS, "hod"), await ctx(OFF_B))
    ).rejects.toThrow();
  });
});

// -------------------------------------------------------------- OTHER ROLES

describe("roles with no academic write authority", () => {
  const denied: UserRole[] = [
    "student",
    "finance",
    "warden",
    "director",
    "placement_cell",
    "super_admin",
  ];

  for (const role of denied) {
    it(`denies ${role} write access to an offering they do not instruct`, async () => {
      const db = makeClient(fixtures());
      await expect(assertCanWriteOfferingRecords(db, actorOf(`u-${role}`, role), OFF_A)).rejects.toThrow();
    });
  }

  it("denies a student write access to another student's offering records", async () => {
    // Student record ownership is enforced in RLS via students.user_id =
    // auth.uid(); this layer's contribution is that no student holds an
    // offering, so the write path is closed to them regardless of ids sent.
    const db = makeClient(fixtures());
    await expect(assertCanWriteOfferingRecords(db, actorOf("student-1", "student"), OFF_A)).rejects.toThrow();
  });

  it("allows admin any offering inside their own college", async () => {
    const db = makeClient(fixtures());
    await expect(assertCanWriteOfferingRecords(db, admin, OFF_B)).resolves.toMatchObject({ id: OFF_B });
  });

  it("denies admin an offering in another college", async () => {
    const db = makeClient(fixtures());
    await expect(assertCanWriteOfferingRecords(db, admin, OFF_FOREIGN)).rejects.toThrow(
      /not found in your college/i
    );
  });

  it("denies admin a cancelled offering", async () => {
    const db = makeClient(fixtures());
    await expect(assertCanWriteOfferingRecords(db, admin, OFF_CANCELLED)).rejects.toThrow();
  });
});

// ------------------------------------------------------------ ATTENDANCE / SUB

describe("attendance write authority (substitute widening)", () => {
  const DATE = "2026-09-10";

  function withSubstitution(over: Row = {}) {
    const db = fixtures();
    db.substitution_assignments = [
      {
        id: "sub-1",
        offering_id: OFF_A,
        date: DATE,
        substitute_teacher_id: SUBSTITUTE,
        status: "assigned",
        ...over,
      },
    ];
    return makeClient(db);
  }

  it("allows an assigned substitute to mark that offering on that date", async () => {
    const db = withSubstitution();
    const offering = await assertCanRecordAttendance(db, actorOf(SUBSTITUTE, "teacher"), OFF_A, DATE);
    expect(offering.id).toBe(OFF_A);
  });

  it("denies the substitute a DIFFERENT date on the same offering", async () => {
    const db = withSubstitution();
    await expect(
      assertCanRecordAttendance(db, actorOf(SUBSTITUTE, "teacher"), OFF_A, "2026-09-11")
    ).rejects.toThrow();
  });

  it("denies the substitute a different offering on the same date", async () => {
    const db = withSubstitution();
    await expect(
      assertCanRecordAttendance(db, actorOf(SUBSTITUTE, "teacher"), OFF_B, DATE)
    ).rejects.toThrow();
  });

  it("denies a substitution that has not been assigned yet", async () => {
    // status 'needed' is the leave-approval placeholder — nobody is covering
    // the class yet, so it confers nothing.
    const db = withSubstitution({ status: "needed" });
    await expect(
      assertCanRecordAttendance(db, actorOf(SUBSTITUTE, "teacher"), OFF_A, DATE)
    ).rejects.toThrow();
  });

  it("gives the substitute no MARKS authority on the covered offering", async () => {
    // Covering one class is not authority over the section's assessment.
    const db = withSubstitution();
    await expect(
      assertCanWriteOfferingRecords(db, actorOf(SUBSTITUTE, "teacher"), OFF_A)
    ).rejects.toThrow();
  });

  it("does not let a substitution reopen a cancelled offering", async () => {
    const db = withSubstitution({ offering_id: OFF_CANCELLED });
    await expect(
      assertCanRecordAttendance(db, actorOf(SUBSTITUTE, "teacher"), OFF_CANCELLED, DATE)
    ).rejects.toThrow();
  });

  it("still allows the assigned instructor without consulting substitutions", async () => {
    const db = makeClient(fixtures());
    await expect(assertCanRecordAttendance(db, teacherA, OFF_A, DATE)).resolves.toMatchObject({ id: OFF_A });
  });
});

// ------------------------------------------------------------- FAIL CLOSED

describe("fail-closed behaviour", () => {
  it("throws for a missing offering rather than returning null", async () => {
    const db = makeClient(fixtures());
    await expect(loadOffering(db, teacherA, "does-not-exist")).rejects.toThrow(/not found in your college/i);
  });

  it("throws for a cross-college offering", async () => {
    const db = makeClient(fixtures());
    await expect(loadOffering(db, teacherA, OFF_FOREIGN)).rejects.toThrow(/not found in your college/i);
  });

  it("throws when the offering's course has no department", async () => {
    // A HOD scope check against `undefined` would otherwise compare
    // undefined === undefined for a HOD who heads nothing.
    const db = makeClient(fixtures());
    await expect(loadOffering(db, teacherA, OFF_ORPHANED)).rejects.toThrow(/no department/i);
  });

  it("denies when the offering table is empty (no data is not permission)", async () => {
    const db = fixtures();
    db.course_offerings = [];
    await expect(assertCanWriteOfferingRecords(makeClient(db), admin, OFF_A)).rejects.toThrow();
  });

  it("denies review when the departments table is empty", async () => {
    const context = await ctx(OFF_A);
    const db = fixtures();
    db.departments = [];
    await expect(assertOfferingInReviewScope(makeClient(db), hodA, context)).rejects.toThrow();
  });

  it("canWriteOfferingRecords is false for a null instructor even at role level", () => {
    const context: OfferingContext = {
      id: OFF_UNASSIGNED,
      collegeId: COLLEGE,
      semesterId: SEM_CURRENT,
      courseId: "course-a",
      sectionId: "sec-1",
      instructorId: null,
      departmentId: DEPT_A,
      status: "active",
    };
    expect(canWriteOfferingRecords(teacherA, context)).toBe(false);
    expect(canWriteOfferingRecords(hodA, context)).toBe(false);
    expect(canWriteOfferingRecords(admin, context)).toBe(true);
  });
});

// ----------------------------------------------------------------- LISTING

describe("listTeachableOfferings", () => {
  it("returns only the actor's own offerings for a teacher", async () => {
    const db = makeClient(fixtures());
    const rows = await listTeachableOfferings(db, teacherA);
    const ids = rows.map((r) => (r as Row).id);
    expect(ids).toContain(OFF_A);
    expect(ids).not.toContain(OFF_B);
    expect(ids).not.toContain(OFF_HOD);
  });

  it("does not widen for a HOD — a non-teaching HOD sees nothing to teach", async () => {
    const db = makeClient(fixtures());
    expect(await listTeachableOfferings(db, hodA)).toEqual([]);
  });

  it("returns the college's offerings for an admin", async () => {
    const db = makeClient(fixtures());
    const ids = (await listTeachableOfferings(db, admin)).map((r) => (r as Row).id);
    expect(ids).toContain(OFF_A);
    expect(ids).toContain(OFF_B);
    expect(ids).not.toContain(OFF_FOREIGN);
  });

  it("scopes to a semester when one is given, without defaulting to it", async () => {
    const db = makeClient(fixtures());
    const scoped = (await listTeachableOfferings(db, teacherA, SEM_PAST)).map((r) => (r as Row).id);
    expect(scoped).toEqual([OFF_HISTORIC]);

    const unscoped = (await listTeachableOfferings(db, teacherA)).map((r) => (r as Row).id);
    expect(unscoped).toContain(OFF_HISTORIC);
    expect(unscoped.length).toBeGreaterThan(scoped.length);
  });
});

describe("getActiveSemesterId", () => {
  it("returns the college's active semester", async () => {
    expect(await getActiveSemesterId(makeClient(fixtures()), teacherA)).toBe(SEM_CURRENT);
  });

  it("returns null when the college has no active semester", async () => {
    const db = fixtures();
    db.semesters = [{ id: SEM_PAST, college_id: COLLEGE, status: "closed" }];
    expect(await getActiveSemesterId(makeClient(db), teacherA)).toBeNull();
  });

  it("does not leak another college's active semester", async () => {
    const db = fixtures();
    db.semesters = [{ id: "sem-other", college_id: OTHER_COLLEGE, status: "active" }];
    expect(await getActiveSemesterId(makeClient(db), teacherA)).toBeNull();
  });
});
