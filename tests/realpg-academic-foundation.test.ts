import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { startCluster, session, concurrently, owner, REAL_PG_AVAILABLE, type Cluster } from "./realpg/harness";
import { U, S, OFF, COLLEGE_A, SEM_3 } from "./staging/harness";

/**
 * Migration 055 under REAL concurrency: separate PostgreSQL sessions, real
 * row and advisory locks, real interleaving (PGlite has one connection and
 * cannot show any of this).
 *
 * Ordering inside a race is made deterministic: the side that must be first
 * holds its transaction open with pg_sleep; the side that must be second
 * starts after a short pg_sleep. The two lock-based controls are then
 * removed — by redefining the trigger function in that one database, with
 * the lock line deleted — to show that the race they close is real.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

const maybe = REAL_PG_AVAILABLE ? describe : describe.skip;
if (!REAL_PG_AVAILABLE) {
  describe("real-PostgreSQL academic foundation", () => {
    it.skip("BLOCKED: no PostgreSQL binary (initdb/pg_ctl/psql) on this machine", () => {});
  });
}

const SEC_CSE_A = "00000008-0000-4000-8000-000000000001";
const SEC_CSE_B = "00000008-0000-4000-8000-000000000002";
const SEC_CSE_A_2023 = "00000008-0000-4000-8000-000000000005";
const DEPT_CSE = "00000002-0000-4000-8000-000000000001";

function as(uid: string): string {
  return `SET request.jwt.claim.sub = '${uid}';\nSET request.jwt.claims = '${JSON.stringify({ sub: uid, role: "authenticated" })}';\nSET ROLE authenticated;\n`;
}

/** One statement as `uid`, optionally delayed, optionally holding its transaction open after. */
function txn(uid: string, sql: string, opts: { delay?: number; hold?: number } = {}): string {
  return (opts.delay ? `SELECT pg_sleep(${opts.delay});\n` : "") +
    as(uid) + `BEGIN;\n${sql};\n` + (opts.hold ? `SELECT pg_sleep(${opts.hold});\n` : "") + `COMMIT;`;
}

/** A 055 trigger function, redefined without one control. */
function functionWithout(name: string, control: string): string {
  const sql = readFileSync("supabase/migrations/055_academic_foundation.sql", "utf8").replace(/\r\n/g, "\n");
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = sql.indexOf("\n$$ LANGUAGE", start);
  const tail = sql.indexOf("\n", end + 1);
  const fn = sql.slice(start, tail);
  if (start < 0 || !fn.includes(control)) throw new Error(`control not found in ${name}: ${control}`);
  // psql -c on Windows passes the command through the ANSI code page, which
  // mangles the en dash in two messages; the mutated copy uses a hyphen.
  return fn.replace(control, "-- removed by mutation").replace(/–/g, "-");
}

const slot = (room: string, start: string, end: string) =>
  `SELECT public.create_timetable_slot('${OFF.dsA3}', 4, '${start}'::time, '${end}'::time, '${room}')`;
const slotB = (room: string, start: string, end: string) =>
  `SELECT public.create_timetable_slot('${OFF.dsB3}', 4, '${start}'::time, '${end}'::time, '${room}')`;

maybe("real-PostgreSQL academic foundation", () => {
  let cluster: Cluster;
  beforeAll(() => { cluster = startCluster(); });
  afterAll(() => cluster?.stop());

  const count = (db: string, sql: string) => Number(owner(cluster, db, sql));

  it("two HOD sessions booking the same room at the same time: exactly one class lands", async () => {
    const db = cluster.fork();
    try {
      const [first, second] = await concurrently(
        session(cluster, db, txn(U.hodCse, slot("QA-R777", "09:00", "10:00"), { hold: 1.5 })),
        session(cluster, db, txn(U.hodCse, slotB("qa-r777", "09:30", "10:30"), { delay: 0.3 })),
      );
      expect(first.code, first.stderr).toBe(0);
      expect(second.stderr).toMatch(/Room conflict/);
      expect(count(db, `SELECT count(*) FROM timetable_slots WHERE lower(room) = 'qa-r777'`)).toBe(1);
    } finally { cluster.drop(db); }
  });

  it("MUTATION: without the term lock in guard_timetable_slot, both overlapping bookings land", async () => {
    const db = cluster.fork();
    try {
      owner(cluster, db, functionWithout("guard_timetable_slot",
        "PERFORM pg_advisory_xact_lock(hashtextextended('timetable:' || v_off.semester_id::text, 0));"));
      const [first, second] = await concurrently(
        session(cluster, db, txn(U.hodCse, slot("QA-R778", "09:00", "10:00"), { hold: 1.5 })),
        session(cluster, db, txn(U.hodCse, slotB("qa-r778", "09:30", "10:30"), { delay: 0.3 })),
      );
      expect(first.code, first.stderr).toBe(0);
      expect(second.code, second.stderr).toBe(0);
      expect(count(db, `SELECT count(*) FROM timetable_slots WHERE lower(room) = 'qa-r778'`), "the race is not reproducible").toBe(2);
    } finally { cluster.drop(db); }
  });

  // Student D is enrolled only in DBMS (CSE-A). Two admin sessions try to
  // put D into Data Structures through BOTH sections at once.
  const enrol = (offering: string) =>
    `INSERT INTO public.course_enrollments (college_id, student_id, offering_id) VALUES ('${COLLEGE_A}', '${S.d}', '${offering}')`;

  it("two sessions enrolling one student in the same course twice: exactly one active enrolment", async () => {
    const db = cluster.fork();
    try {
      const [first, second] = await concurrently(
        session(cluster, db, txn(U.admin, enrol(OFF.dsA3), { hold: 1.5 })),
        session(cluster, db, txn(U.admin, enrol(OFF.dsB3), { delay: 0.3 })),
      );
      expect(first.code, first.stderr).toBe(0);
      expect(second.stderr).toMatch(/already enrolled in this course for this term/);
      expect(count(db, `SELECT count(*) FROM course_enrollments e JOIN course_offerings o ON o.id = e.offering_id
        WHERE e.student_id = '${S.d}' AND o.course_id = (SELECT course_id FROM course_offerings WHERE id = '${OFF.dsA3}') AND e.status = 'enrolled'`)).toBe(1);
    } finally { cluster.drop(db); }
  });

  it("MUTATION: without the per-student lock, the duplicate enrolment lands", async () => {
    const db = cluster.fork();
    try {
      owner(cluster, db, functionWithout("guard_enrollment_unique_course",
        "PERFORM pg_advisory_xact_lock(hashtextextended('student_academic:' || NEW.student_id::text, 0));"));
      const [first, second] = await concurrently(
        session(cluster, db, txn(U.admin, enrol(OFF.dsA3), { hold: 1.5 })),
        session(cluster, db, txn(U.admin, enrol(OFF.dsB3), { delay: 0.3 })),
      );
      expect(first.code, first.stderr).toBe(0);
      expect(second.code, second.stderr).toBe(0);
      expect(count(db, `SELECT count(*) FROM course_enrollments e JOIN course_offerings o ON o.id = e.offering_id
        WHERE e.student_id = '${S.d}' AND o.course_id = (SELECT course_id FROM course_offerings WHERE id = '${OFF.dsA3}') AND e.status = 'enrolled'`),
        "the race is not reproducible").toBe(2);
    } finally { cluster.drop(db); }
  });

  it("two HOD sessions assigning a section's Class In-Charge at once: one current In-Charge, the other kept as history", async () => {
    const db = cluster.fork();
    try {
      const assign = (teacher: string) => `SELECT public.assign_class_incharge('${SEC_CSE_A}', '${teacher}', 'Concurrent assignment test')`;
      const [first, second] = await concurrently(
        session(cluster, db, txn(U.hodCse, assign(U.teacherA), { hold: 1.5 })),
        session(cluster, db, txn(U.hodCse, assign(U.teacherB), { delay: 0.3 })),
      );
      expect(first.code, first.stderr).toBe(0);
      expect(second.code, second.stderr).toBe(0);
      expect(count(db, `SELECT count(*) FROM section_class_incharges WHERE section_id = '${SEC_CSE_A}' AND ended_at IS NULL`)).toBe(1);
      expect(owner(cluster, db, `SELECT teacher_id FROM section_class_incharges WHERE section_id = '${SEC_CSE_A}' AND ended_at IS NULL`)).toBe(U.teacherB);
      expect(count(db, `SELECT count(*) FROM section_class_incharges WHERE section_id = '${SEC_CSE_A}'`)).toBe(2);
    } finally { cluster.drop(db); }
  });

  it("two sessions starting the department's term at once: it starts exactly once", async () => {
    const db = cluster.fork();
    try {
      // Make CSE ready: an In-Charge per active section, and the 2023 cohort
      // (no classes this term) retired.
      owner(cluster, db, `UPDATE sections SET status = 'inactive' WHERE id = '${SEC_CSE_A_2023}'`);
      owner(cluster, db, `INSERT INTO section_class_incharges (college_id, semester_id, section_id, teacher_id) VALUES
        ('${COLLEGE_A}', '${SEM_3}', '${SEC_CSE_A}', '${U.teacherA}'), ('${COLLEGE_A}', '${SEM_3}', '${SEC_CSE_B}', '${U.teacherB}')`);
      const start = `SELECT public.start_department_term('${DEPT_CSE}')`;
      const [first, second] = await concurrently(
        session(cluster, db, txn(U.hodCse, start, { hold: 1.5 })),
        session(cluster, db, txn(U.hodCse, start, { delay: 0.3 })),
      );
      expect(first.code, first.stderr).toBe(0);
      expect(second.stderr).toMatch(/already been started/);
      expect(count(db, `SELECT count(*) FROM department_terms WHERE department_id = '${DEPT_CSE}' AND semester_id = '${SEM_3}'`)).toBe(1);
      expect(count(db, `SELECT count(*) FROM audit_logs WHERE action = 'department_term.started'`)).toBe(1);
    } finally { cluster.drop(db); }
  });
});
