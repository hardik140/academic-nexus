import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { stagingDb, as, verify, scalar, U, S, OFF, COLLEGE_A, COLLEGE_B, DEPT_CSE, DATE } from "./staging/harness";

/**
 * The authority graph, tested as a graph.
 *
 * Migration 047 §7b makes academic write depend on the offering's instructor.
 * That is only as strong as the records the predicate reads, and there are
 * three of them, on three different tables:
 *
 *     departments.hod_id
 *          |
 *          v
 *     courses.department_id ........... decides heads_course_department()
 *          |
 *          v
 *     course_offerings.instructor_id .. decides can_write_offering_records()
 *          |
 *          v
 *     substitution_assignments ........ decides can_record_attendance()
 *          |
 *          v
 *     attendance / marks
 *
 * Scoping any one node while leaving its neighbours writable at role +
 * tenancy moves the hole instead of closing it. Each test below walks a
 * complete path from "edit a master-data row" to "write someone else's
 * academic records" and asserts it terminates at the first step.
 *
 * These are regression anchors for defects that were live: every one of them
 * succeeded end to end before the fixes in §7d–§7f.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

let db: PGlite;

beforeAll(async () => {
  db = await stagingDb();
});
afterAll(async () => {
  await db?.close();
});

const fresh = () => stagingDb();

const writeAttendance = (offering: string, student = S.a, date = DATE) =>
  `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
     VALUES ('${COLLEGE_A}','${offering}','${student}','${date}','present',auth.uid())`;

// ══════════════════════════════════════════════════════════════
// Node: substitution_assignments
// ══════════════════════════════════════════════════════════════

describe("substitution cannot be self-granted", () => {
  it("a HOD cannot mint an assigned substitution naming themselves", async () => {
    const d = await fresh();
    try {
      // This was the widest of the three escalations: no master-data edit
      // needed at all, and it reached any offering in the institution.
      const ins = await as(
        d,
        U.hodCse,
        `INSERT INTO public.substitution_assignments
           (college_id, leave_request_id, original_teacher_id, substitute_teacher_id, offering_id, date, status)
         VALUES ('${COLLEGE_A}','0000000f-0000-4000-8000-000000000001','${U.teacherC}',auth.uid(),
                 '${OFF.ece}','${DATE}','assigned')`
      );
      expect(ins.ok).toBe(false);
      expect(ins.error).toMatch(/row-level security/i);
      expect((await as(d, U.hodCse, `SELECT public.can_record_attendance('${OFF.ece}','${DATE}') AS v`)).data[0].v).toBe(false);
      expect((await as(d, U.hodCse, writeAttendance(OFF.ece))).ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM attendance WHERE offering_id=$1`, [OFF.ece])).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("nor in their OWN department — the row must start unassigned", async () => {
    const d = await fresh();
    try {
      // OFF.dsA3 is a CSE offering and HOD-CSE heads CSE, so scope alone
      // would allow this. What refuses it is that a substitution has to be a
      // consequence of an approved absence, not a self-service grant.
      const ins = await as(
        d,
        U.hodCse,
        `INSERT INTO public.substitution_assignments
           (college_id, leave_request_id, original_teacher_id, substitute_teacher_id, offering_id, date, status)
         VALUES ('${COLLEGE_A}','0000000f-0000-4000-8000-000000000001','${U.teacherA}',auth.uid(),
                 '${OFF.dsA3}','${DATE}','assigned')`
      );
      expect(ins.ok).toBe(false);
    } finally {
      await d.close();
    }
  });

  it("the legitimate workflow still works: create needed, then assign", async () => {
    const d = await fresh();
    try {
      // Exactly what createSubstitutionNeeds + assignSubstitute do.
      const create = await as(
        d,
        U.hodCse,
        `INSERT INTO public.substitution_assignments
           (college_id, leave_request_id, original_teacher_id, offering_id, date, status)
         VALUES ('${COLLEGE_A}','0000000f-0000-4000-8000-000000000001','${U.teacherA}',
                 '${OFF.dsA3}','${DATE}','needed')`
      );
      expect(create.error).toBeNull();

      const assign = await as(
        d,
        U.hodCse,
        `UPDATE public.substitution_assignments
            SET status='assigned', substitute_teacher_id='${U.teacherB}', assigned_by=auth.uid()
          WHERE offering_id='${OFF.dsA3}' AND status='needed'`
      );
      expect(assign.rows).toBe(1);

      // and the substitute can now record attendance for that date only
      expect((await as(d, U.teacherB, writeAttendance(OFF.dsA3))).error).toBeNull();
      expect((await as(d, U.teacherB, writeAttendance(OFF.dsA3, S.a, "2026-09-11"))).ok).toBe(false);
    } finally {
      await d.close();
    }
  });

  it("a HOD cannot create a substitution outside their department", async () => {
    const d = await fresh();
    try {
      const create = await as(
        d,
        U.hodCse,
        `INSERT INTO public.substitution_assignments
           (college_id, leave_request_id, original_teacher_id, offering_id, date, status)
         VALUES ('${COLLEGE_A}','0000000f-0000-4000-8000-000000000001','${U.teacherC}',
                 '${OFF.ece}','${DATE}','needed')`
      );
      expect(create.ok).toBe(false);
    } finally {
      await d.close();
    }
  });

  it("a teacher cannot create one at all", async () => {
    const d = await fresh();
    try {
      const r = await as(
        d,
        U.teacherA,
        `INSERT INTO public.substitution_assignments
           (college_id, leave_request_id, original_teacher_id, offering_id, date, status)
         VALUES ('${COLLEGE_A}','0000000f-0000-4000-8000-000000000001','${U.teacherB}',
                 '${OFF.dsB3}','${DATE}','needed')`
      );
      expect(r.ok).toBe(false);
    } finally {
      await d.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Node: courses.department_id
// ══════════════════════════════════════════════════════════════

describe("the department pointer cannot be moved to move authority", () => {
  it("a HOD cannot pull another department's course into their own", async () => {
    const d = await fresh();
    try {
      const eceCourse = String(
        await scalar(d, `SELECT course_id FROM course_offerings WHERE id=$1`, [OFF.ece])
      );
      const mv = await as(d, U.hodCse, `UPDATE public.courses SET department_id='${DEPT_CSE}' WHERE id='${eceCourse}'`);
      expect(mv.rows).toBe(0);

      // the pointer is untouched, so the predicate still says no
      expect((await as(d, U.hodCse, `SELECT public.heads_offering_department('${OFF.ece}') AS v`)).data[0].v).toBe(false);
      expect((await as(d, U.hodCse, `UPDATE public.course_offerings SET instructor_id=auth.uid() WHERE id='${OFF.ece}'`)).rows).toBe(0);
      expect((await as(d, U.hodCse, writeAttendance(OFF.ece))).ok).toBe(false);
    } finally {
      await d.close();
    }
  });

  it("nor push one of their own out", async () => {
    const d = await fresh();
    try {
      const r = await as(
        d,
        U.hodCse,
        `UPDATE public.courses SET department_id='00000002-0000-4000-8000-000000000003'
          WHERE id='00000009-0000-4000-8000-000000000001'`
      );
      expect(r.ok).toBe(false);
      expect(
        await scalar(d, `SELECT department_id FROM courses WHERE id='00000009-0000-4000-8000-000000000001'`)
      ).toBe(DEPT_CSE);
    } finally {
      await d.close();
    }
  });

  it("a HOD can still edit their own department's catalog", async () => {
    const d = await fresh();
    try {
      // 006 granted HODs course management; the fix scopes it rather than
      // removing it.
      const r = await as(
        d,
        U.hodCse,
        `UPDATE public.courses SET credits=5 WHERE id='00000009-0000-4000-8000-000000000001'`
      );
      expect(r.rows).toBe(1);
    } finally {
      await d.close();
    }
  });

  it("a HOD cannot create a course in another department", async () => {
    const d = await fresh();
    try {
      const r = await as(
        d,
        U.hodCse,
        `INSERT INTO public.courses (college_id, department_id, name, code, credits)
           VALUES ('${COLLEGE_A}','00000002-0000-4000-8000-000000000002','X','QA-X9',3)`
      );
      expect(r.ok).toBe(false);
    } finally {
      await d.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Node: leave approval (reaches academic tables via substitutions)
// ══════════════════════════════════════════════════════════════

describe("leave approval authority is enforced by the database too", () => {
  async function pendingLeave(d: PGlite, requester: string, id: string) {
    await verify(
      d,
      `INSERT INTO public.leave_requests (id, college_id, requested_by, leave_type, start_date, end_date, reason, status)
         VALUES ('${id}','${COLLEGE_A}','${requester}','casual','2026-09-20','2026-09-20','QA','pending')`
    );
  }

  it("a HOD cannot approve leave for another department's staff", async () => {
    const d = await fresh();
    const id = "0000000f-0000-4000-8000-0000000000c1";
    try {
      await pendingLeave(d, U.teacherC, id); // Teacher C sits in ECE-facing work
      // Teacher C's profile department is CSE in the fixture, so use the ECE
      // HOD as the negative: they head neither.
      const r = await as(d, U.hodEce, `UPDATE public.leave_requests SET status='approved', approved_by=auth.uid() WHERE id='${id}'`);
      expect(r.rows).toBe(0);
      expect(await scalar(d, `SELECT status FROM leave_requests WHERE id=$1`, [id])).toBe("pending");
    } finally {
      await d.close();
    }
  });

  it("a HOD cannot approve their own leave — separation of duties", async () => {
    const d = await fresh();
    const id = "0000000f-0000-4000-8000-0000000000c2";
    try {
      await pendingLeave(d, U.hodCse, id);
      const r = await as(d, U.hodCse, `UPDATE public.leave_requests SET status='approved', approved_by=auth.uid() WHERE id='${id}'`);
      expect(r.rows).toBe(0);
      expect(await scalar(d, `SELECT status FROM leave_requests WHERE id=$1`, [id])).toBe("pending");
    } finally {
      await d.close();
    }
  });

  it("an admin cannot approve their own leave either", async () => {
    const d = await fresh();
    const id = "0000000f-0000-4000-8000-0000000000c3";
    try {
      await pendingLeave(d, U.admin, id);
      const r = await as(d, U.admin, `UPDATE public.leave_requests SET status='approved', approved_by=auth.uid() WHERE id='${id}'`);
      expect(r.rows).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("the HOD of the requester's own department still can", async () => {
    const d = await fresh();
    const id = "0000000f-0000-4000-8000-0000000000c4";
    try {
      await pendingLeave(d, U.teacherA, id); // Teacher A is in CSE
      const r = await as(d, U.hodCse, `UPDATE public.leave_requests SET status='approved', approved_by=auth.uid() WHERE id='${id}'`);
      expect(r.rows).toBe(1);
      expect(await scalar(d, `SELECT status FROM leave_requests WHERE id=$1`, [id])).toBe("approved");
    } finally {
      await d.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Notification attribution
// ══════════════════════════════════════════════════════════════

describe("notifications cannot be attributed to someone else", () => {
  it("a teacher cannot send one as the Director", async () => {
    const d = await fresh();
    try {
      const r = await as(
        d,
        U.teacherA,
        `INSERT INTO public.notifications (college_id, receiver_id, sender_id, title, message, type)
           VALUES ('${COLLEGE_A}','${U.studentA}','${U.director}','Official','From the Director','info')`
      );
      expect(r.ok).toBe(false);
      expect(await scalar(d, `SELECT count(*)::int FROM notifications WHERE sender_id=$1`, [U.director])).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("but can still send one as themselves", async () => {
    const d = await fresh();
    try {
      const r = await as(
        d,
        U.teacherA,
        `INSERT INTO public.notifications (college_id, receiver_id, sender_id, title, message, type)
           VALUES ('${COLLEGE_A}','${U.studentA}',auth.uid(),'Class moved','Room change','info')`
      );
      expect(r.error).toBeNull();
    } finally {
      await d.close();
    }
  });

  it("a student cannot send notifications at all", async () => {
    const d = await fresh();
    try {
      const r = await as(
        d,
        U.studentA,
        `INSERT INTO public.notifications (college_id, receiver_id, sender_id, title, message, type)
           VALUES ('${COLLEGE_A}','${U.director}',auth.uid(),'x','x','info')`
      );
      expect(r.ok).toBe(false);
    } finally {
      await d.close();
    }
  });

  it("a notification is readable only by its receiver", async () => {
    const d = await fresh();
    try {
      await as(
        d,
        U.teacherA,
        `INSERT INTO public.notifications (college_id, receiver_id, sender_id, title, message, type)
           VALUES ('${COLLEGE_A}','${U.studentA}',auth.uid(),'private','private','info')`
      );
      expect((await as(d, U.studentB, `SELECT id FROM notifications`)).data).toHaveLength(0);
      expect((await as(d, U.studentA, `SELECT id FROM notifications`)).data).toHaveLength(1);
    } finally {
      await d.close();
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Boundaries that were already sound — pinned so they stay that way
// ══════════════════════════════════════════════════════════════

describe("boundaries verified intact", () => {
  it("no role can promote itself", async () => {
    const d = await fresh();
    try {
      for (const [label, uid] of [["student", U.studentA], ["teacher", U.teacherA], ["hod", U.hodCse], ["admin", U.admin]] as const) {
        const r = await as(d, uid, `UPDATE public.profiles SET role='super_admin' WHERE id=auth.uid()`);
        expect(r.ok, `${label} self-promotion`).toBe(false);
      }
      expect(await scalar(d, `SELECT count(*)::int FROM profiles WHERE role='super_admin'`)).toBe(1);
    } finally {
      await d.close();
    }
  });

  it("nobody can move themselves to another college", async () => {
    const d = await fresh();
    try {
      for (const uid of [U.studentA, U.teacherA, U.hodCse, U.admin]) {
        expect((await as(d, uid, `UPDATE public.profiles SET college_id='${COLLEGE_B}' WHERE id=auth.uid()`)).ok).toBe(false);
      }
    } finally {
      await d.close();
    }
  });

  it("a student cannot edit their own academic standing", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.studentA, `UPDATE public.students SET cgpa=10.0 WHERE user_id=auth.uid()`)).rows).toBe(0);
      expect((await as(d, U.studentA, `UPDATE public.students SET status='graduated' WHERE user_id=auth.uid()`)).rows).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("a student cannot settle their own fees", async () => {
    const d = await fresh();
    try {
      const r = await as(d, U.studentA, `UPDATE public.fees SET status='paid'`);
      expect(r.rows).toBe(0);
    } finally {
      await d.close();
    }
  });

  it("finance and warden cannot read academic records", async () => {
    const d = await fresh();
    try {
      await as(d, U.teacherA, writeAttendance(OFF.dsA3));
      // marks_read_staff / attendance_read_staff list teacher|hod|director|admin.
      expect((await as(d, U.finance, `SELECT id FROM marks`)).data).toHaveLength(0);
      expect((await as(d, U.warden, `SELECT id FROM attendance`)).data).toHaveLength(0);
    } finally {
      await d.close();
    }
  });

  it("an admin cannot reach another college", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.admin, `UPDATE public.colleges SET name='x' WHERE id='${COLLEGE_B}'`)).rows).toBe(0);
      expect((await as(d, U.admin, `SELECT id FROM course_offerings WHERE id='${OFF.collegeB}'`)).data).toHaveLength(0);
      expect((await as(d, U.admin, `SELECT id FROM profiles WHERE college_id='${COLLEGE_B}'`)).data).toHaveLength(0);
    } finally {
      await d.close();
    }
  });

  it("super_admin holds no academic bypass", async () => {
    const d = await fresh();
    try {
      expect((await as(d, U.superAdmin, writeAttendance(OFF.dsA3))).ok).toBe(false);
      expect((await as(d, U.superAdmin, `SELECT id FROM marks`)).data).toHaveLength(0);
    } finally {
      await d.close();
    }
  });
});
