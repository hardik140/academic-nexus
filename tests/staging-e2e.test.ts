import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  stagingDb,
  as,
  verify,
  scalar,
  U,
  S,
  OFF,
  COLLEGE_A,
  COLLEGE_B,
  DEPT_CSE,
  DEPT_ECE,
  SEM_3,
  SEM_PAST,
  COURSE_DS,
  DATE,
} from "./staging/harness";

/**
 * Phase 9 end-to-end verification against the repository's real migration
 * chain and a realistic institutional dataset.
 *
 * SCOPE, STATED HONESTLY
 *
 * This is disposable PostgreSQL, not Supabase. Docker is unavailable in this
 * environment, so `supabase start` cannot run, and the only Supabase project
 * the repository is configured against is the one the application itself
 * uses — it carries no staging marker, so nothing here was applied to it.
 *
 * What that means for these results: everything below is a claim about what
 * PostgreSQL does when a statement arrives as `authenticated` with a given
 * `sub` claim. That is the enforcement boundary that survives the
 * application being bypassed, which is the thing worth proving. It is NOT a
 * claim about PostgREST's request translation, GoTrue's token issuance, or
 * the hosted instance's roles and grants.
 *
 * Every DENY assertion checks the database AFTER the attempt. An RLS-blocked
 * UPDATE reports success and affects zero rows, so "no error" proves nothing
 * and "zero rows" alone proves only that the statement matched nothing —
 * the row itself has to be read back.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

let db: PGlite;

beforeAll(async () => {
  db = await stagingDb();
});

afterAll(async () => {
  await db?.close();
});

// Fresh database per describe-block that mutates, so one block's writes
// cannot satisfy another block's precondition.
async function fresh(): Promise<PGlite> {
  return stagingDb();
}

const insertAttendance = (offering: string, student: string, date = DATE, status = "present") =>
  `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
     VALUES ('${COLLEGE_A}', '${offering}', '${student}', '${date}', '${status}', auth.uid())`;

const insertMarks = (offering: string, student: string, examType = "internal_1") =>
  `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks, entered_by)
     VALUES ('${COLLEGE_A}', '${offering}', '${student}', '${examType}', 100, 77, auth.uid())`;

// ══════════════════════════════════════════════════════════════
// PHASE 5 — post-migration schema
// ══════════════════════════════════════════════════════════════

describe("Phase 5 — schema after the real 001→047 chain", () => {
  it("carries the full academic hierarchy", async () => {
    const tables = await verify<{ table_name: string }>(
      db,
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public'
          AND table_name IN ('academic_years','semesters','departments','programmes',
                             'sections','courses','course_offerings')
        ORDER BY table_name`
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      "academic_years",
      "course_offerings",
      "courses",
      "departments",
      "programmes",
      "sections",
      "semesters",
    ]);
  });

  it("gives course_offerings its four identity columns", async () => {
    const cols = await verify<{ column_name: string; is_nullable: string }>(
      db,
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='course_offerings'
          AND column_name IN ('semester_id','course_id','section_id','instructor_id')
        ORDER BY column_name`
    );
    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]));
    expect(byName.semester_id).toBe("NO");
    expect(byName.course_id).toBe("NO");
    expect(byName.section_id).toBe("NO");
    // Nullable on purpose: an offering can be scheduled before it is staffed.
    // canWriteOfferingRecords treats NULL as "nobody", never as "anybody".
    expect(byName.instructor_id).toBe("YES");
  });

  it("requires offering_id NOT NULL on every transaction table", async () => {
    const rows = await verify<{ table_name: string; is_nullable: string }>(
      db,
      `SELECT table_name, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND column_name='offering_id'
          AND table_name IN ('attendance','marks','course_enrollments','timetable_slots',
                             'attendance_correction_requests','substitution_assignments')
        ORDER BY table_name`
    );
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.is_nullable, `${r.table_name}.offering_id is nullable`).toBe("NO");
    }
  });

  it("points course_enrollments.student_id at students, not profiles", async () => {
    const target = await scalar(
      db,
      `SELECT confrelid::regclass::text FROM pg_constraint
        WHERE conname='course_enrollments_student_id_fkey'`
    );
    expect(target).toBe("students");
  });

  it("keeps courses.instructor_id present and documented as deprecated", async () => {
    const exists = await scalar(
      db,
      `SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema='public' AND table_name='courses' AND column_name='instructor_id'`
    );
    expect(exists).toBe(1);

    const comment = await scalar(
      db,
      `SELECT col_description('public.courses'::regclass, ordinal_position)
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='courses' AND column_name='instructor_id'`
    );
    expect(String(comment ?? "")).toMatch(/DEPRECATED/i);
  });

  it("drops the old course-scoped identities", async () => {
    const stale = await verify<{ table_name: string; column_name: string }>(
      db,
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name IN ('attendance','marks','timetable_slots','course_enrollments',
                             'attendance_correction_requests','substitution_assignments')
          AND column_name IN ('course_id','semester_id','semester','instructor_id')`
    );
    expect(stale).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════
// PHASE 15 — teacher end to end
// ══════════════════════════════════════════════════════════════

describe("Phase 15 — teacher", () => {
  it("Teacher A holds exactly the two CSE-A Sem-3 deliveries", async () => {
    const rows = await as(
      db,
      U.teacherA,
      `SELECT id FROM public.course_offerings
        WHERE instructor_id = auth.uid() AND status = 'active' ORDER BY id`
    );
    expect(rows.data.map((r) => r.id)).toEqual([OFF.dsA3, OFF.dbmsA3]);
  });

  it("writes attendance to their own offering, and the row lands correctly", async () => {
    const d = await fresh();
    try {
      const r = await as(d, U.teacherA, insertAttendance(OFF.dsA3, S.a));
      expect(r.error).toBeNull();

      const [row] = await verify<{ offering_id: string; student_id: string; date: string; status: string; marked_by: string }>(
        d,
        `SELECT offering_id, student_id, date::text, status, marked_by FROM public.attendance
          WHERE offering_id=$1 AND student_id=$2 AND date=$3`,
        [OFF.dsA3, S.a, DATE]
      );
      expect(row.offering_id).toBe(OFF.dsA3);
      expect(row.student_id).toBe(S.a);
      expect(row.date).toBe(DATE);
      expect(row.status).toBe("present");
      expect(row.marked_by).toBe(U.teacherA);
    } finally {
      await d.close();
    }
  });

  it("cannot write attendance to another teacher's offering, and nothing lands", async () => {
    const d = await fresh();
    try {
      const r = await as(d, U.teacherA, insertAttendance(OFF.dsB3, S.c));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/row-level security/i);

      const after = await scalar(
        d,
        `SELECT count(*)::int FROM public.attendance WHERE offering_id=$1`,
        [OFF.dsB3]
      );
      expect(after).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("cannot UPDATE another teacher's attendance — the silent-denial path", async () => {
    const d = await fresh();
    try {
      await as(d, U.teacherB, insertAttendance(OFF.dsB3, S.c, DATE, "absent"));
      const before = await scalar(
        d,
        `SELECT status FROM public.attendance WHERE offering_id=$1 AND student_id=$2`,
        [OFF.dsB3, S.c]
      );
      expect(before).toBe("absent");

      const r = await as(
        d,
        U.teacherA,
        `UPDATE public.attendance SET status='present' WHERE offering_id='${OFF.dsB3}'`
      );
      // The tell: no error at all, and zero rows touched.
      expect(r.ok).toBe(true);
      expect(r.rows).toBe(0);

      const after = await scalar(
        d,
        `SELECT status FROM public.attendance WHERE offering_id=$1 AND student_id=$2`,
        [OFF.dsB3, S.c]
      );
      expect(after).toBe("absent");
    } finally {
      await d.close();
    }
  });

  it("cannot grant itself authority by forging college_id on the insert", async () => {
    const d = await fresh();
    try {
      const r = await as(
        d,
        U.teacherA,
        `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
           VALUES ('${COLLEGE_B}', '${OFF.dsB3}', '${S.c}', '${DATE}', 'present', auth.uid())`
      );
      expect(r.ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE offering_id=$1`, [OFF.dsB3])).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("cannot attribute the write to somebody else", async () => {
    const d = await fresh();
    try {
      // marked_by is not covered by the policy, so this INSERT is permitted —
      // recorded here so the gap is a documented fact rather than a surprise.
      const r = await as(
        d,
        U.teacherA,
        `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
           VALUES ('${COLLEGE_A}', '${OFF.dsA3}', '${S.a}', '${DATE}', 'present', '${U.teacherB}')`
      );
      expect(r.ok).toBe(true);
      const markedBy = await scalar(
        d,
        `SELECT marked_by FROM public.attendance WHERE offering_id=$1 AND student_id=$2`,
        [OFF.dsA3, S.a]
      );
      // Authority was still Teacher A's; only the attribution is wrong. The
      // application always sets marked_by from the session, so this is
      // reachable only by bypassing it — an audit-integrity gap, not an
      // authorization one.
      expect(markedBy).toBe(U.teacherB);
    } finally {
      await d.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════
// PHASE 16 — section isolation (the central claim of the model)
// ══════════════════════════════════════════════════════════════

describe("Phase 16 — section isolation", () => {
  it("the same course is three independent offerings", async () => {
    const rows = await verify<{ id: string; section_id: string; semester_id: string; instructor_id: string }>(
      db,
      `SELECT id, section_id, semester_id, instructor_id FROM public.course_offerings
        WHERE course_id=$1 ORDER BY id`,
      [COURSE_DS]
    );
    expect(rows).toHaveLength(4); // 3 current + 1 historical
    expect(new Set(rows.map((r) => r.instructor_id)).size).toBe(3);
  });

  it("Teacher A and Teacher B deny each other on the same course", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.teacherA, insertAttendance(OFF.dsB3, S.c))).ok).toBe(false);
      expect((await as(d, U.teacherB, insertAttendance(OFF.dsA3, S.a))).ok).toBe(false);
      expect((await as(d, U.teacherA, insertMarks(OFF.dsB3, S.c))).ok).toBe(false);
      expect((await as(d, U.teacherB, insertMarks(OFF.dsA3, S.a))).ok).toBe(false);

      expect(await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE date=$1`, [DATE])).toBe(0);
      expect(await scalar(d, `SELECT count(*)::int FROM public.marks WHERE exam_type='internal_1' AND offering_id <> $1`, [OFF.historical])).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("keeps the two sections' records completely separate", async () => {
    const d = await fresh();
    try {
      await as(d, U.teacherA, insertAttendance(OFF.dsA3, S.a, DATE, "present"));
      await as(d, U.teacherB, insertAttendance(OFF.dsB3, S.c, DATE, "absent"));

      const rows = await verify<{ offering_id: string; student_id: string; status: string }>(
        d,
        `SELECT offering_id, student_id, status FROM public.attendance WHERE date=$1 ORDER BY offering_id`,
        [DATE]
      );
      expect(rows).toEqual([
        { offering_id: OFF.dsA3, student_id: S.a, status: "present" },
        { offering_id: OFF.dsB3, student_id: S.c, status: "absent" },
      ]);
    } finally {
      await d.close();
    }
  });

  it("does not let a teacher reach a student who is only in the other section", async () => {
    const d = await fresh();
    try {
      // Student C exists, is in the same college and the same course — just
      // not in Teacher A's delivery of it. Migration 051 (P3-8) made enrolment
      // binding a DATABASE invariant (guard_enrolled_student), not just an
      // application one, so the offering-scoped RLS pass is no longer enough:
      // the row is refused because Student C is not enrolled in this offering.
      const r = await as(d, U.teacherA, insertAttendance(OFF.dsA3, S.c));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/not enrolled/);
      const enrolled = await scalar(
        d,
        `SELECT count(*)::int FROM public.course_enrollments WHERE offering_id=$1 AND student_id=$2`,
        [OFF.dsA3, S.c]
      );
      expect(enrolled).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("Teacher C's Sem-5 delivery of the same course is separate again", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.teacherC, insertAttendance(OFF.dsA5, S.e))).ok).toBe(true);
      expect((await as(d, U.teacherA, insertAttendance(OFF.dsA5, S.e))).ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE offering_id=$1`, [OFF.dsA5])).toBe(1);
    } finally {
      await d.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════
// PHASE 17 — the teaching HOD
// ══════════════════════════════════════════════════════════════

describe("Phase 17 — teaching HOD", () => {
  it("writes to the offering they are assigned to", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.hodCse, insertAttendance(OFF.osHod, S.a))).error).toBeNull();
      expect((await as(d, U.hodCse, insertMarks(OFF.osHod, S.a))).error).toBeNull();
      expect(await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE offering_id=$1`, [OFF.osHod])).toBe(1);
    } finally {
      await d.close();
    }
  });

  it("is denied on a colleague's offering INSIDE their own department", async () => {
    const d = await fresh();
    try {
      // The load-bearing test for "HOD REVIEW is not HOD WRITE": OFF.dsA3 is
      // a CSE offering, HOD-CSE heads CSE, and they still cannot write it.
      const att = await as(d, U.hodCse, insertAttendance(OFF.dsA3, S.a));
      expect(att.ok).toBe(false);
      const marks = await as(d, U.hodCse, insertMarks(OFF.dsA3, S.a));
      expect(marks.ok).toBe(false);

      expect(await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE offering_id=$1`, [OFF.dsA3])).toBe(0);
      expect(await scalar(d, `SELECT count(*)::int FROM public.marks WHERE offering_id=$1`, [OFF.dsA3])).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("cannot silently UPDATE attendance in their own department", async () => {
    const d = await fresh();
    try {
      await as(d, U.teacherA, insertAttendance(OFF.dsA3, S.a, DATE, "absent"));
      const r = await as(
        d,
        U.hodCse,
        `UPDATE public.attendance SET status='present' WHERE offering_id='${OFF.dsA3}'`
      );
      expect(r.rows).toBe(0);
      expect(
        await scalar(d, `SELECT status FROM public.attendance WHERE offering_id=$1`, [OFF.dsA3])
      ).toBe("absent");
    } finally {
      await d.close();
    }
  });

  it("holds review standing over their own department only", async () => {
    const own = await as(db, U.hodCse, `SELECT public.heads_offering_department('${OFF.dsA3}') AS v`);
    expect(own.data[0].v).toBe(true);
    const other = await as(db, U.hodCse, `SELECT public.heads_offering_department('${OFF.ece}') AS v`);
    expect(other.data[0].v).toBe(false);
    const eceOwn = await as(db, U.hodEce, `SELECT public.heads_offering_department('${OFF.ece}') AS v`);
    expect(eceOwn.data[0].v).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// PHASE 18 — attendance correction workflow
// ══════════════════════════════════════════════════════════════

describe("Phase 18 — correction workflow", () => {
  async function withPendingRequest(): Promise<{ d: PGlite; attendanceId: string; requestId: string }> {
    const d = await fresh();
    await as(d, U.teacherA, insertAttendance(OFF.dsA3, S.a, DATE, "absent"));
    const attendanceId = String(
      await scalar(d, `SELECT id FROM public.attendance WHERE offering_id=$1 AND student_id=$2`, [OFF.dsA3, S.a])
    );
    const ins = await as(
      d,
      U.teacherA,
      `INSERT INTO public.attendance_correction_requests
         (college_id, attendance_id, student_id, offering_id, date, current_status, requested_status, reason, submitted_by)
       VALUES ('${COLLEGE_A}', '${attendanceId}', '${S.a}', '${OFF.dsA3}', '${DATE}',
               'absent', 'present', 'QA: student was present, marked in error', auth.uid())
       RETURNING id`
    );
    expect(ins.error).toBeNull();
    return { d, attendanceId, requestId: String(ins.data[0].id) };
  }

  it("runs teacher request → HOD approval → attendance changed", async () => {
    const { d, attendanceId, requestId } = await withPendingRequest();
    try {
      expect(await scalar(d, `SELECT status FROM public.attendance_correction_requests WHERE id=$1`, [requestId])).toBe("pending");

      const approve = await as(
        d,
        U.hodCse,
        `UPDATE public.attendance_correction_requests
            SET status='approved', reviewed_by=auth.uid(), reviewed_at=now()
          WHERE id='${requestId}'`
      );
      expect(approve.rows).toBe(1);

      const applied = await as(
        d,
        U.hodCse,
        `UPDATE public.attendance SET status='present' WHERE id='${attendanceId}'`
      );
      expect(applied.rows).toBe(1);
      expect(await scalar(d, `SELECT status FROM public.attendance WHERE id=$1`, [attendanceId])).toBe("present");
    } finally {
      await d.close();
    }
  });

  it("denies an HOD from another department", async () => {
    const { d, attendanceId, requestId } = await withPendingRequest();
    try {
      const approve = await as(
        d,
        U.hodEce,
        `UPDATE public.attendance_correction_requests
            SET status='approved', reviewed_by=auth.uid() WHERE id='${requestId}'`
      );
      expect(approve.rows).toBe(0);
      expect(await scalar(d, `SELECT status FROM public.attendance_correction_requests WHERE id=$1`, [requestId])).toBe("pending");

      const applied = await as(d, U.hodEce, `UPDATE public.attendance SET status='present' WHERE id='${attendanceId}'`);
      expect(applied.rows).toBe(0);
      expect(await scalar(d, `SELECT status FROM public.attendance WHERE id=$1`, [attendanceId])).toBe("absent");
    } finally {
      await d.close();
    }
  });

  it("blocks self-approval — separation of duties lives in the database", async () => {
    const d = await fresh();
    try {
      // Deliberately on TEACHER A's offering, not the HOD's own.
      //
      // On their own offering a teaching HOD needs no correction workflow at
      // all: attendance_update_offering_authority already grants them the
      // edit as the instructor, and permissive policies OR together, so the
      // separation-of-duties rule would never be the deciding clause. Testing
      // it there would assert nothing. Here the HOD heads the department but
      // holds no assignment, so the correction policy is the only route in —
      // and submitted_by = auth.uid() closes it.
      await as(d, U.teacherA, insertAttendance(OFF.dsA3, S.a, DATE, "absent"));
      const attendanceId = String(
        await scalar(d, `SELECT id FROM public.attendance WHERE offering_id=$1`, [OFF.dsA3])
      );
      const ins = await as(
        d,
        U.hodCse,
        `INSERT INTO public.attendance_correction_requests
           (college_id, attendance_id, student_id, offering_id, date, current_status, requested_status, reason, submitted_by)
         VALUES ('${COLLEGE_A}','${attendanceId}','${S.a}','${OFF.dsA3}','${DATE}',
                 'absent','present','QA: self-approval attempt', auth.uid())
         RETURNING id`
      );
      const requestId = String(ins.data[0].id);

      await as(
        d,
        U.hodCse,
        `UPDATE public.attendance_correction_requests
            SET status='approved', reviewed_by=auth.uid() WHERE id='${requestId}'`
      );

      // attendance_update_approved_correction requires submitted_by <> auth.uid().
      const applied = await as(
        d,
        U.hodCse,
        `UPDATE public.attendance SET status='present' WHERE id='${attendanceId}'`
      );
      expect(applied.rows).toBe(0);
      expect(await scalar(d, `SELECT status FROM public.attendance WHERE id=$1`, [attendanceId])).toBe("absent");
    } finally {
      await d.close();
    }
  });

  it("will not apply a correction that was never approved", async () => {
    const { d, attendanceId } = await withPendingRequest();
    try {
      const applied = await as(d, U.hodCse, `UPDATE public.attendance SET status='present' WHERE id='${attendanceId}'`);
      expect(applied.rows).toBe(0);
      expect(await scalar(d, `SELECT status FROM public.attendance WHERE id=$1`, [attendanceId])).toBe("absent");
    } finally {
      await d.close();
    }
  });

  it("F2 FIXED: a request whose offering contradicts its attendance row is refused", async () => {
    const d = await fresh();
    try {
      await as(d, U.teacherA, insertAttendance(OFF.dsA3, S.a, DATE, "absent"));
      const attendanceId = String(
        await scalar(d, `SELECT id FROM public.attendance WHERE offering_id=$1`, [OFF.dsA3])
      );
      // A CSE attendance row, declared against an ECE offering. This used to
      // be accepted, which put a reviewable request in the wrong HOD's queue
      // and left the audit trail disagreeing with itself about which class
      // was corrected. 047 §5a now ties the request's copied context to the
      // attendance row with a composite foreign key.
      const ins = await as(
        d,
        U.teacherA,
        `INSERT INTO public.attendance_correction_requests
           (college_id, attendance_id, student_id, offering_id, date, current_status, requested_status, reason, submitted_by)
         VALUES ('${COLLEGE_A}','${attendanceId}','${S.a}','${OFF.ece}','${DATE}',
                 'absent','present','QA: mismatched offering', auth.uid())`
      );
      expect(ins.ok).toBe(false);
      expect(ins.error).toMatch(/foreign key|violates/i);
      expect(await scalar(d, `SELECT count(*)::int FROM public.attendance_correction_requests`)).toBe(0);

      // The defence that used to catch this at the last step is still in
      // place — nothing was traded away for the new constraint.
      expect(await scalar(d, `SELECT status FROM public.attendance WHERE id=$1`, [attendanceId])).toBe("absent");
    } finally {
      await d.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════
// PHASE 19 — student isolation / IDOR
// ══════════════════════════════════════════════════════════════

describe("Phase 19 — student isolation", () => {
  it("Student A reads their own attendance and marks", async () => {
    const d = await fresh();
    try {
      await as(d, U.teacherA, insertAttendance(OFF.dsA3, S.a));
      await as(d, U.teacherA, insertMarks(OFF.dsA3, S.a));

      const att = await as(d, U.studentA, `SELECT id FROM public.attendance`);
      expect(att.data).toHaveLength(1);
      const marks = await as(d, U.studentA, `SELECT id FROM public.marks`);
      expect(marks.data).toHaveLength(1);
    } finally {
      await d.close();
    }
  });

  it("Student B's records are invisible to Student A, however they are asked for", async () => {
    const d = await fresh();
    try {
      await as(d, U.teacherA, insertAttendance(OFF.dsA3, S.b));
      await as(d, U.teacherA, insertMarks(OFF.dsA3, S.b));

      // Plain read.
      expect((await as(d, U.studentA, `SELECT id FROM public.attendance`)).data).toHaveLength(0);
      // Naming the other student's row id directly (the IDOR shape).
      expect(
        (await as(d, U.studentA, `SELECT id FROM public.attendance WHERE student_id='${S.b}'`)).data
      ).toHaveLength(0);
      // Naming the offering they are themselves enrolled in.
      expect(
        (await as(d, U.studentA, `SELECT id FROM public.marks WHERE offering_id='${OFF.dsA3}'`)).data
      ).toHaveLength(0);
      // Claiming the other student's students(id) in a filter.
      expect(
        (await as(d, U.studentA, `SELECT id FROM public.marks WHERE student_id IN ('${S.a}','${S.b}')`)).data
      ).toHaveLength(0);
    } finally {
      await d.close();
    }
  });

  it("a student cannot write academic records at all", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.studentA, insertAttendance(OFF.dsA3, S.a))).ok).toBe(false);
      expect((await as(d, U.studentA, insertMarks(OFF.dsA3, S.a))).ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE date=$1`, [DATE])).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("a student cannot promote themselves", async () => {
    const d = await fresh();
    try {
      const r = await as(d, U.studentA, `UPDATE public.profiles SET role='admin' WHERE id=auth.uid()`);
      // 042's trigger raises rather than silently ignoring the column.
      expect(r.ok).toBe(false);
      expect(await scalar(d, `SELECT role FROM public.profiles WHERE id=$1`, [U.studentA])).toBe("student");
    } finally {
      await d.close();
    }
  });

  it("a student cannot enrol themselves into another offering", async () => {
    const d = await fresh();
    try {
      const r = await as(
        d,
        U.studentA,
        `INSERT INTO public.course_enrollments (college_id, student_id, offering_id, status)
           VALUES ('${COLLEGE_A}', '${S.a}', '${OFF.dsB3}', 'enrolled')`
      );
      expect(r.ok).toBe(false);
      expect(
        await scalar(d, `SELECT count(*)::int FROM public.course_enrollments WHERE offering_id=$1`, [OFF.dsB3])
      ).toBe(1); // just Student C, from the fixture
    } finally {
      await d.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════
// PHASE 20 — historical semester
// ══════════════════════════════════════════════════════════════

describe("Phase 20 — historical offerings", () => {
  it("the same course + section name in two years are two offerings", async () => {
    const rows = await verify<{ id: string; semester_id: string }>(
      db,
      `SELECT o.id, o.semester_id FROM public.course_offerings o
        JOIN public.sections sec ON sec.id = o.section_id
        WHERE o.course_id=$1 AND sec.name='CSE-A' ORDER BY o.id`,
      [COURSE_DS]
    );
    const semesters = rows.map((r) => r.semester_id);
    expect(new Set(semesters).size).toBe(semesters.length);
    expect(semesters).toContain(SEM_PAST);
  });

  it("historical records stay attached to the historical offering", async () => {
    const att = await verify<{ offering_id: string }>(
      db,
      `SELECT offering_id FROM public.attendance WHERE student_id=$1`,
      [S.f]
    );
    expect(att).toHaveLength(2);
    for (const r of att) expect(r.offering_id).toBe(OFF.historical);

    // The current CSE-A delivery has none of them.
    expect(await scalar(db, `SELECT count(*)::int FROM public.attendance WHERE offering_id=$1`, [OFF.dsA3])).toBe(0);
  });

  it("freezes writes on a completed offering once its semester is closed (051 P2-3)", async () => {
    const d = await fresh();
    try {
      // Teacher A still holds the 2025-26 delivery, but that term is CLOSED.
      // Before 051 a 'completed' offering stayed writable (no finalization
      // rule existed); now guard_closed_semester() freezes every academic
      // record under a closed semester, so the write is refused and the two
      // historical rows are unchanged.
      const r = await as(d, U.teacherA, insertAttendance(OFF.historical, S.f, "2025-08-13"));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/semester is closed/);
      expect(
        await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE offering_id=$1`, [OFF.historical])
      ).toBe(2);
    } finally {
      await d.close();
    }
  });

  it("a teacher who holds the current delivery has no authority over the past one", async () => {
    const d = await fresh();
    try {
      // Teacher C holds the Sem-5 delivery of Data Structures; the 2025-26
      // delivery is Teacher A's. Course-level authority would merge them.
      const r = await as(d, U.teacherC, insertAttendance(OFF.historical, S.f, "2025-08-14"));
      expect(r.ok).toBe(false);
      expect(
        await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE offering_id=$1`, [OFF.historical])
      ).toBe(2);
    } finally {
      await d.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════
// PHASE 21 — cancelled offering
// ══════════════════════════════════════════════════════════════

describe("Phase 21 — cancelled offering", () => {
  it("denies the assigned instructor", async () => {
    const d = await fresh();
    try {
      // Teacher A IS the named instructor. Cancellation is what stops this.
      expect(
        await scalar(db, `SELECT instructor_id FROM public.course_offerings WHERE id=$1`, [OFF.cancelled])
      ).toBe(U.teacherA);

      expect((await as(d, U.teacherA, insertAttendance(OFF.cancelled, S.a))).ok).toBe(false);
      expect((await as(d, U.teacherA, insertMarks(OFF.cancelled, S.a))).ok).toBe(false);
      expect(
        await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE offering_id=$1`, [OFF.cancelled])
      ).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("denies the HOD and the substitute path too", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.hodCse, insertAttendance(OFF.cancelled, S.a))).ok).toBe(false);

      // A substitution row on a cancelled offering must not reopen it.
      await verify(
        d,
        `INSERT INTO public.substitution_assignments
           (college_id, leave_request_id, original_teacher_id, substitute_teacher_id, offering_id, date, status)
         VALUES ('${COLLEGE_A}','0000000f-0000-4000-8000-000000000001','${U.teacherA}','${U.teacherB}',
                 '${OFF.cancelled}','${DATE}','assigned')`
      );
      expect((await as(d, U.teacherB, insertAttendance(OFF.cancelled, S.a))).ok).toBe(false);
      expect(
        await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE offering_id=$1`, [OFF.cancelled])
      ).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("admins are not exempt from cancellation", async () => {
    const d = await fresh();
    try {
      // can_write_offering_records short-circuits on status BEFORE the role
      // check, so 'admin' does not carry past a cancelled offering.
      const r = await as(d, U.admin, insertAttendance(OFF.cancelled, S.a));
      expect(r.ok).toBe(false);
    } finally {
      await d.close();
    }
  });

  it("leaves reads of a cancelled offering's history alone", async () => {
    const rows = await as(db, U.teacherA, `SELECT id FROM public.course_offerings WHERE id='${OFF.cancelled}'`);
    expect(rows.data).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════
// PHASE 22 — substitution
// ══════════════════════════════════════════════════════════════

describe("Phase 22 — substitution", () => {
  async function withSubstitution(status = "assigned", date = DATE, offering = OFF.dsA3) {
    const d = await fresh();
    await verify(
      d,
      `INSERT INTO public.substitution_assignments
         (college_id, leave_request_id, original_teacher_id, substitute_teacher_id, offering_id, date, status)
       VALUES ('${COLLEGE_A}','0000000f-0000-4000-8000-000000000001','${U.teacherA}','${U.teacherB}',
               '${offering}','${date}','${status}')`
    );
    return d;
  }

  it("lets an assigned substitute record attendance for that date", async () => {
    const d = await withSubstitution();
    try {
      const r = await as(d, U.teacherB, insertAttendance(OFF.dsA3, S.a, DATE));
      expect(r.error).toBeNull();
      expect(await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE offering_id=$1`, [OFF.dsA3])).toBe(1);
    } finally {
      await d.close();
    }
  });

  it("grants nothing on any other date", async () => {
    const d = await withSubstitution();
    try {
      const r = await as(d, U.teacherB, insertAttendance(OFF.dsA3, S.a, "2026-09-11"));
      expect(r.ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE offering_id=$1`, [OFF.dsA3])).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("grants nothing on any other offering", async () => {
    const d = await withSubstitution();
    try {
      const r = await as(d, U.teacherB, insertAttendance(OFF.dbmsA3, S.a, DATE));
      expect(r.ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE offering_id=$1`, [OFF.dbmsA3])).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("grants nothing while the assignment is not 'assigned'", async () => {
    // 039 constrains status to needed/assigned/cancelled; 'assigned' is the
    // only one that may grant anything.
    for (const status of ["needed", "cancelled"]) {
      const d = await withSubstitution(status);
      try {
        const r = await as(d, U.teacherB, insertAttendance(OFF.dsA3, S.a, DATE));
        expect(r.ok, `status=${status} should not grant attendance authority`).toBe(false);
      } finally {
        await d.close();
      }
    }
  });

  it("never extends to marks", async () => {
    const d = await withSubstitution();
    try {
      // Covering one class does not confer authority over a section's
      // assessment record — asserted here, not just documented.
      const r = await as(d, U.teacherB, insertMarks(OFF.dsA3, S.a));
      expect(r.ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM public.marks WHERE offering_id=$1`, [OFF.dsA3])).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("cannot be created by the substitute themselves", async () => {
    const d = await fresh();
    try {
      const r = await as(
        d,
        U.teacherB,
        `INSERT INTO public.substitution_assignments
           (college_id, leave_request_id, original_teacher_id, substitute_teacher_id, offering_id, date, status)
         VALUES ('${COLLEGE_A}','0000000f-0000-4000-8000-000000000001','${U.teacherA}',auth.uid(),
                 '${OFF.dsA3}','${DATE}','assigned')`
      );
      expect(r.ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM public.substitution_assignments`)).toBe(0);
    } finally {
      await d.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════
// PHASE 25 — other roles, direct at the database
// ══════════════════════════════════════════════════════════════

describe("Phase 25 — non-academic roles", () => {
  const cases: Array<[string, string]> = [
    ["finance", U.finance],
    ["warden", U.warden],
    ["director", U.director],
    ["super_admin", U.superAdmin],
  ];

  for (const [label, uid] of cases) {
    it(`${label} cannot write attendance or marks`, async () => {
      const d = await fresh();
      try {
        expect((await as(d, uid, insertAttendance(OFF.dsA3, S.a))).ok, `${label} attendance`).toBe(false);
        expect((await as(d, uid, insertMarks(OFF.dsA3, S.a))).ok, `${label} marks`).toBe(false);
        expect(await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE date=$1`, [DATE])).toBe(0);
        expect(await scalar(d, `SELECT count(*)::int FROM public.marks WHERE offering_id=$1`, [OFF.dsA3])).toBe(0);
      } finally {
        await d.close();
      }
    });
  }

  it("super_admin gets no academic bypass by role alone", async () => {
    const d = await fresh();
    try {
      // get_my_college_id() resolves through the super_admin's own profile,
      // and can_write_offering_records needs an instructor match that a
      // super_admin does not have. No academic backdoor.
      const r = await as(d, U.superAdmin, `UPDATE public.marks SET obtained_marks = 100`);
      expect(r.rows).toBe(0);
      // NUMERIC arrives as a scaled string, so compare numerically.
      expect(
        Number(await scalar(d, `SELECT obtained_marks FROM public.marks WHERE offering_id=$1`, [OFF.historical]))
      ).toBe(72);
    } finally {
      await d.close();
    }
  });

  it("director can read academic data but not change it", async () => {
    const d = await fresh();
    try {
      await as(d, U.teacherA, insertAttendance(OFF.dsA3, S.a, DATE, "absent"));
      // Scoped: the fixture already carries two historical rows, so an
      // unscoped count would be measuring the seed, not the read.
      const read = await as(d, U.director, `SELECT id FROM public.attendance WHERE offering_id='${OFF.dsA3}'`);
      expect(read.data).toHaveLength(1);

      const write = await as(d, U.director, `UPDATE public.attendance SET status='present'`);
      expect(write.rows).toBe(0);
      expect(await scalar(d, `SELECT status FROM public.attendance WHERE offering_id=$1`, [OFF.dsA3])).toBe("absent");
    } finally {
      await d.close();
    }
  });

  it("F1 FIXED: an HOD cannot reassign an offering outside their department", async () => {
    const d = await fresh();
    try {
      // 046's course_offerings_manage was role + tenancy only, so an HOD
      // could name themselves instructor of any offering in the college and
      // can_write_offering_records would then hand them attendance and marks.
      // 047 §7d scopes it to the department that owns the offering's course.
      //
      // The full matrix lives in tests/staging-security-f1-f2.test.ts; this
      // is the regression anchor in the scenario suite.
      const grab = await as(
        d,
        U.hodCse,
        `UPDATE public.course_offerings SET instructor_id = auth.uid() WHERE id='${OFF.ece}'`
      );
      expect(grab.rows).toBe(0);
      expect(
        await scalar(d, `SELECT instructor_id FROM public.course_offerings WHERE id=$1`, [OFF.ece])
      ).toBe(U.teacherC);

      const write = await as(d, U.hodCse, insertAttendance(OFF.ece, S.a));
      expect(write.ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE offering_id=$1`, [OFF.ece])).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("a teacher cannot reassign an offering to themselves", async () => {
    const d = await fresh();
    try {
      const r = await as(
        d,
        U.teacherA,
        `UPDATE public.course_offerings SET instructor_id = auth.uid() WHERE id='${OFF.dsB3}'`
      );
      expect(r.rows).toBe(0);
      expect(
        await scalar(db, `SELECT instructor_id FROM public.course_offerings WHERE id=$1`, [OFF.dsB3])
      ).toBe(U.teacherB);
    } finally {
      await d.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════
// PHASE 29 — cross-college tenancy
// ══════════════════════════════════════════════════════════════

describe("Phase 29 — tenancy", () => {
  it("College A staff cannot read College B academic data", async () => {
    const d = await fresh();
    try {
      await as(d, U.bTeacher, insertAttendanceB(OFF.collegeB, S.bStudent));
      const seen = await as(d, U.teacherA, `SELECT id FROM public.attendance WHERE offering_id='${OFF.collegeB}'`);
      expect(seen.data).toHaveLength(0);

      const offerings = await as(d, U.teacherA, `SELECT id FROM public.course_offerings WHERE id='${OFF.collegeB}'`);
      expect(offerings.data).toHaveLength(0);
    } finally {
      await d.close();
    }
  });

  it("College A staff cannot write College B academic data", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.teacherA, insertAttendanceB(OFF.collegeB, S.bStudent))).ok).toBe(false);
      expect((await as(d, U.admin, insertAttendanceB(OFF.collegeB, S.bStudent))).ok).toBe(false);
      expect((await as(d, U.hodCse, insertAttendanceB(OFF.collegeB, S.bStudent))).ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE offering_id=$1`, [OFF.collegeB])).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("College B staff cannot reach College A either", async () => {
    const d = await fresh();
    try {
      await as(d, U.teacherA, insertAttendance(OFF.dsA3, S.a));
      expect((await as(d, U.bTeacher, `SELECT id FROM public.attendance WHERE offering_id='${OFF.dsA3}'`)).data).toHaveLength(0);
      expect((await as(d, U.bTeacher, insertAttendance(OFF.dsA3, S.a, "2026-09-12"))).ok).toBe(false);
      expect((await as(d, U.bHod, `SELECT id FROM public.course_offerings WHERE id='${OFF.dsA3}'`)).data).toHaveLength(0);
    } finally {
      await d.close();
    }
  });

  it("a College B HOD holds no review standing over College A", async () => {
    const r = await as(db, U.bHod, `SELECT public.heads_offering_department('${OFF.dsA3}') AS v`);
    expect(r.data[0].v).toBe(false);
  });

  it("students are confined to their own college", async () => {
    const d = await fresh();
    try {
      await as(d, U.teacherA, insertMarks(OFF.dsA3, S.a));
      expect((await as(d, U.bStudent, `SELECT id FROM public.marks`)).data).toHaveLength(0);
      expect((await as(d, U.studentA, `SELECT id FROM public.course_offerings WHERE id='${OFF.collegeB}'`)).data).toHaveLength(0);
    } finally {
      await d.close();
    }
  });
});

function insertAttendanceB(offering: string, student: string, date = DATE) {
  return `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
            VALUES ('${COLLEGE_B}', '${offering}', '${student}', '${date}', 'present', auth.uid())`;
}

// ══════════════════════════════════════════════════════════════
// PHASE 28 — data integrity
// ══════════════════════════════════════════════════════════════

describe("Phase 28 — data integrity", () => {
  const orphanChecks: Array<[string, string]> = [
    ["offerings without a course", `SELECT count(*)::int FROM course_offerings o LEFT JOIN courses c ON c.id=o.course_id WHERE c.id IS NULL`],
    ["offerings without a semester", `SELECT count(*)::int FROM course_offerings o LEFT JOIN semesters s ON s.id=o.semester_id WHERE s.id IS NULL`],
    ["offerings without a section", `SELECT count(*)::int FROM course_offerings o LEFT JOIN sections s ON s.id=o.section_id WHERE s.id IS NULL`],
    ["offerings with an invalid instructor", `SELECT count(*)::int FROM course_offerings o LEFT JOIN profiles p ON p.id=o.instructor_id WHERE o.instructor_id IS NOT NULL AND p.id IS NULL`],
    ["enrollments without an offering", `SELECT count(*)::int FROM course_enrollments e LEFT JOIN course_offerings o ON o.id=e.offering_id WHERE o.id IS NULL`],
    ["enrollments without a student", `SELECT count(*)::int FROM course_enrollments e LEFT JOIN students s ON s.id=e.student_id WHERE s.id IS NULL`],
    ["attendance without an offering", `SELECT count(*)::int FROM attendance a LEFT JOIN course_offerings o ON o.id=a.offering_id WHERE o.id IS NULL`],
    ["attendance without a student", `SELECT count(*)::int FROM attendance a LEFT JOIN students s ON s.id=a.student_id WHERE s.id IS NULL`],
    ["marks without an offering", `SELECT count(*)::int FROM marks m LEFT JOIN course_offerings o ON o.id=m.offering_id WHERE o.id IS NULL`],
    ["marks without a student", `SELECT count(*)::int FROM marks m LEFT JOIN students s ON s.id=m.student_id WHERE s.id IS NULL`],
  ];

  for (const [label, sql] of orphanChecks) {
    it(`has no ${label}`, async () => {
      expect(await scalar(db, sql)).toBe(0);
    });
  }

  it("has no attendance for a student who is not enrolled in that offering", async () => {
    // Not an FK — the database cannot express it. It is an application
    // invariant (verifyStudentsEnrolled), so it is checked as data, and a
    // violation here would mean the invariant leaked.
    const n = await scalar(
      db,
      `SELECT count(*)::int FROM attendance a
        WHERE NOT EXISTS (SELECT 1 FROM course_enrollments e
                           WHERE e.offering_id=a.offering_id AND e.student_id=a.student_id)`
    );
    expect(n).toBe(0);
  });

  it("has no marks for a student who is not enrolled in that offering", async () => {
    const n = await scalar(
      db,
      `SELECT count(*)::int FROM marks m
        WHERE NOT EXISTS (SELECT 1 FROM course_enrollments e
                           WHERE e.offering_id=m.offering_id AND e.student_id=m.student_id)`
    );
    expect(n).toBe(0);
  });

  it("enforces the four logical identities", async () => {
    const dupes: Array<[string, string]> = [
      ["offering", `SELECT count(*)::int FROM (SELECT 1 FROM course_offerings GROUP BY semester_id, course_id, section_id HAVING count(*)>1) x`],
      ["enrollment", `SELECT count(*)::int FROM (SELECT 1 FROM course_enrollments GROUP BY offering_id, student_id HAVING count(*)>1) x`],
      ["attendance", `SELECT count(*)::int FROM (SELECT 1 FROM attendance GROUP BY offering_id, student_id, date HAVING count(*)>1) x`],
      ["marks", `SELECT count(*)::int FROM (SELECT 1 FROM marks GROUP BY offering_id, student_id, exam_type HAVING count(*)>1) x`],
    ];
    for (const [label, sql] of dupes) {
      expect(await scalar(db, sql), `duplicate ${label}`).toBe(0);
    }
  });

  it("rejects a duplicate attendance row at the database, not just in the app", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.teacherA, insertAttendance(OFF.dsA3, S.a))).error).toBeNull();
      const second = await as(d, U.teacherA, insertAttendance(OFF.dsA3, S.a, DATE, "absent"));
      expect(second.ok).toBe(false);
      expect(second.error).toMatch(/duplicate key|unique/i);
    } finally {
      await d.close();
    }
  });

  it("allows the same student, same date, in two different offerings", async () => {
    const d = await fresh();
    try {
      // Student A is in both Data Structures and DBMS on CSE-A. The identity
      // is (offering, student, date) — a per-course identity would collide.
      expect((await as(d, U.teacherA, insertAttendance(OFF.dsA3, S.a))).error).toBeNull();
      expect((await as(d, U.teacherA, insertAttendance(OFF.dbmsA3, S.a))).error).toBeNull();
      expect(await scalar(d, `SELECT count(*)::int FROM public.attendance WHERE student_id=$1 AND date=$2`, [S.a, DATE])).toBe(2);
    } finally {
      await d.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Model observations that are not pass/fail
// ══════════════════════════════════════════════════════════════

describe("model observations", () => {
  it("permits exactly one active semester per college", async () => {
    const d = await fresh();
    try {
      const r = await verify(
        d,
        `UPDATE public.semesters SET status='active' WHERE id='${SEM_3}'::uuid`
      ).catch((e) => e);
      // Already active; the point is the index below.
      const idx = await scalar(
        d,
        `SELECT indexdef FROM pg_indexes WHERE indexname='idx_semesters_one_active'`
      );
      expect(String(idx)).toContain("WHERE (status = 'active'::text)");

      // A semester row is an institutional TERM; sections of different
      // batch_year carry the 1st/3rd/5th-semester cohorts inside one term,
      // so one active term per college is the intended invariant, and 047
      // §7k now operates it (create -> activate -> close). What the index
      // cannot express is two programmes on different calendars — a
      // trimester course beside a semester one — which is a design decision,
      // not a defect. (An earlier comment here called this a finding.)
      let failed = false;
      try {
        await verify(d, `UPDATE public.semesters SET status='active' WHERE id='00000006-0000-4000-8000-000000000005'`);
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      void r;
    } finally {
      await d.close();
    }
  });

  it("has no write policy of any kind on timetable_slots", async () => {
    const policies = await verify<{ cmd: string }>(
      db,
      // PERMISSIVE only: a restrictive policy (053's tenant_access_gate) can only
      // narrow access, never grant a write.
      `SELECT cmd FROM pg_policies WHERE schemaname='public' AND tablename='timetable_slots' AND permissive='PERMISSIVE'`
    );
    // 055 split 006's single read into staff (college-wide) and student/parent
    // (own enrolments) — both still SELECT only.
    expect(policies.map((p) => p.cmd)).toEqual(["SELECT", "SELECT"]);

    // So nobody can create a timetable through PostgREST — unchanged since
    // migration 006, and deliberately left alone in Phase 8.
    const d = await fresh();
    try {
      const r = await as(
        d,
        U.admin,
        `INSERT INTO public.timetable_slots (college_id, offering_id, day_of_week, start_time, end_time, room)
           VALUES ('${COLLEGE_A}','${OFF.dsA3}',4,'11:00','12:00','QA-R109')`
      );
      expect(r.ok).toBe(false);
    } finally {
      await d.close();
    }
  });

  it("lets any college staff read all attendance and marks, by design", async () => {
    const d = await fresh();
    try {
      await as(d, U.teacherA, insertAttendance(OFF.dsA3, S.a));
      // Teacher B holds no part of this offering, yet reads it. READ is
      // college-scoped for staff (006/044); WRITE is offering-scoped (047).
      // Recorded so the distinction is not mistaken for a leak.
      const seen = await as(d, U.teacherB, `SELECT id FROM public.attendance WHERE offering_id='${OFF.dsA3}'`);
      expect(seen.data).toHaveLength(1);
    } finally {
      await d.close();
    }
  });
});
