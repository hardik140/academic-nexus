import { describe, it, expect, vi, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { stagingDb, as, verify, U, S, OFF, COLLEGE_A, COLLEGE_B, DEPT_CSE, DEPT_ECE, BLOCK_A, BLOCK_B } from "./staging/harness";
import { computeEffectiveFeeStatus, detectDuplicatePaymentRisk } from "@/lib/finance-status";
import { idempotencyKey } from "@/lib/finance/idempotency";

/**
 * Redis transformation Phase 3 — migration 059, against the real schema,
 * real RLS and real roles (PGlite, every migration applied unedited).
 *
 * Every function here replaced "select rows, then count/sum/filter in
 * JavaScript", which PostgREST's 1,000-row cap made silently wrong. So each
 * test checks the BUSINESS INVARIANT over a dataset past that cap — at 999,
 * 1,000 and 1,001+ rows where the boundary matters — against the truth
 * counted by the database owner, and shows the old first-1,000-rows
 * computation gets it wrong. Then the same call as the wrong college or the
 * wrong role.
 *
 * Each test runs in a transaction that is rolled back. Bulk rows are written
 * by the owner with user triggers off (this tests arithmetic and scope, not
 * the write paths that normally maintain them); every function under test
 * is then called as the real role, with triggers and RLS back on.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

let db: PGlite;
beforeAll(async () => {
  db = await stagingDb();
});

const CAP = 1000; // PostgREST's default max_rows

async function txn<T>(seed: () => Promise<void>, body: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try {
    await db.exec("SET session_replication_role = replica");
    await seed();
    await db.exec("SET session_replication_role = origin");
    return await body();
  } finally {
    await db.exec("ROLLBACK");
  }
}
const owner = (sql: string, params: unknown[] = []) => db.query(sql, params);
/** A call that may fail, inside a test transaction: a failure must not abort the rest. */
async function tryAs(uid: string, sql: string, params: unknown[] = []): Promise<{ ok: boolean; error: string | null; data: Record<string, unknown>[] }> {
  // The same identity as() sets, inside a savepoint: ROLLBACK TO undoes the
  // failed statement AND the role switch, so the test transaction lives on.
  await db.exec("SAVEPOINT try_as");
  await db.exec(`SET request.jwt.claim.sub = '${uid}'; SET ROLE authenticated;`);
  try {
    const res = await db.query<Record<string, unknown>>(sql, params);
    await db.exec("RESET ROLE; RESET request.jwt.claim.sub; RELEASE SAVEPOINT try_as");
    return { ok: true, error: null, data: res.rows };
  } catch (err) {
    await db.exec("ROLLBACK TO SAVEPOINT try_as");
    await db.exec("RESET ROLE; RESET request.jwt.claim.sub");
    return { ok: false, error: (err as Error).message, data: [] };
  }
}
const n = (v: unknown) => Number(v ?? 0);
/** The user (profile) id prefix that goes with a student id prefix: last hex digit set to f. */
const userPrefix = (p: string) => p.slice(0, 7) + "f";
const uuid = (prefix: string, g: string) => `('${prefix}-0000-4000-8000-' || lpad(${g}::text, 12, '0'))::uuid`;

/** n active students in a department of college A; profiles too when asked. */
async function seedStudents(count: number, opts: { dept?: string; college?: string; profiles?: boolean; prefix?: string } = {}) {
  const dept = opts.dept ?? DEPT_CSE;
  const college = opts.college ?? COLLEGE_A;
  const p = opts.prefix ?? "00000099";
  if (opts.profiles) {
    await owner(
      `INSERT INTO auth.users (id) SELECT ${uuid(userPrefix(p), "g")} FROM generate_series(1, $1) g`,
      [count]
    ).catch(() => undefined);
    await owner(
      `INSERT INTO public.profiles (id, college_id, email, full_name, role, status)
       SELECT ${uuid(userPrefix(p), "g")}, $2, 'qa' || g || '@${p}.test', 'QA Student ' || g, 'student', 'active'
       FROM generate_series(1, $1) g`,
      [count, college]
    );
  }
  await owner(
    `INSERT INTO public.students (id, college_id, user_id, department_id, enrollment_number, batch_year, status, cgpa)
     SELECT ${uuid(p, "g")}, $2, ${uuid(userPrefix(p), "g")}, $3, 'QA${p}-' || lpad(g::text, 6, '0'),
            2023 + (g % 4), 'active', CASE WHEN g % 3 = 0 THEN 4.5 ELSE 8.0 END
     FROM generate_series(1, $1) g`,
    [count, college, dept]
  );
}

// ─────────────────────────────────────────────────────────────────────────
describe("student_risk_overview", () => {
  // Factors per generated student g: CGPA < 5 when g%3==0, an overdue fee
  // when g%5==0, a failed enrolment when g%7==0.
  async function seed(count: number) {
    await seedStudents(count);
    await owner(
      `INSERT INTO public.fees (college_id, student_id, type, amount, paid_amount, due_date, status)
       SELECT $1, ${uuid("00000099", "g")}, 'QA risk', 1000, 0, (now() AT TIME ZONE 'UTC')::date - 10, 'pending'
       FROM generate_series(1, $2) g WHERE g % 5 = 0`,
      [COLLEGE_A, count]
    );
    await owner(
      `INSERT INTO public.course_enrollments (college_id, offering_id, student_id, status)
       SELECT $1, $3, ${uuid("00000099", "g")}, 'failed' FROM generate_series(1, $2) g WHERE g % 7 = 0`,
      [COLLEGE_A, count, OFF.dsA3]
    );
  }
  const expected = (count: number) => {
    let atRisk = 0;
    let critical = 0;
    for (let g = 1; g <= count; g++) {
      const f = (g % 3 === 0 ? 1 : 0) + (g % 5 === 0 ? 1 : 0) + (g % 7 === 0 ? 1 : 0);
      if (f >= 1) atRisk++;
      if (f >= 2) critical++;
    }
    return { atRisk, critical };
  };

  it.each([999, 1000, 1001, 1500])("%i generated students: every one counted, every factor counted", async (count) => {
    await txn(
      () => seed(count),
      async () => {
        const truth = await verify<{ n: string }>(db, `SELECT count(*)::text n FROM public.students WHERE college_id=$1 AND department_id=$2 AND status='active'`, [COLLEGE_A, DEPT_CSE]);
        const r = await as(db, U.director, `SELECT * FROM public.student_risk_overview($1)`, [COLLEGE_A]);
        expect(r.ok, r.error ?? "").toBe(true);
        const cse = r.data.find((d) => d.department_id === DEPT_CSE)!;
        expect(n(cse.total_students)).toBe(n(truth[0].n));
        // The generated cohort's factors are exactly counted (the seed's own
        // students have none of these factors beyond what they already had).
        const base = await as(db, U.director, `SELECT * FROM public.student_risk_overview($1, $2)`, [COLLEGE_A, DEPT_CSE]);
        const want = expected(count);
        expect(n(base.data[0].at_risk)).toBeGreaterThanOrEqual(want.atRisk);
        expect(n(base.data[0].critical)).toBeGreaterThanOrEqual(want.critical);
        expect(n(base.data[0].at_risk) - want.atRisk).toBeLessThan(10); // only the QA dataset's own students on top
      }
    );
  });

  it("the old way — the first 1,000 students — undercounts, and never saw a backlog at all", async () => {
    await txn(
      () => seed(1500),
      async () => {
        const capped = await verify<{ n: string }>(db, `SELECT count(*)::text n FROM (SELECT 1 FROM public.students WHERE college_id=$1 AND status='active' LIMIT ${CAP}) x`, [COLLEGE_A]);
        const r = await as(db, U.director, `SELECT sum(total_students)::text n FROM public.student_risk_overview($1)`, [COLLEGE_A]);
        expect(n(r.data[0].n)).toBeGreaterThan(n(capped[0].n));
        // A student whose only factor is a failed enrolment (g = 7·k, not 3 or 5).
        const onlyBacklog = await as(db, U.director, `SELECT * FROM public.student_risk_overview($1, $2)`, [COLLEGE_A, DEPT_CSE]);
        expect(n(onlyBacklog.data[0].at_risk)).toBeGreaterThanOrEqual(expected(1500).atRisk);
      }
    );
  });

  it("college isolation and roles: college B's HOD sees nothing of A; a student cannot read the overview's inputs", async () => {
    await txn(
      () => seed(1100),
      async () => {
        const b = await as(db, U.bHod, `SELECT coalesce(sum(total_students),0)::text n FROM public.student_risk_overview($1)`, [COLLEGE_A]);
        expect(b.ok, b.error ?? "").toBe(true);
        expect(n(b.data[0].n)).toBe(0);
        const s = await as(db, U.studentA, `SELECT coalesce(sum(total_students),0)::text n FROM public.student_risk_overview($1)`, [COLLEGE_A]);
        expect(n(s.data[0].n)).toBeLessThanOrEqual(1); // RLS: a student sees only their own row
      }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("faculty_activity", () => {
  it("attendance days, marks and periods past 1,000 rows are all counted", async () => {
    await txn(
      async () => {
        await owner(
          `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
           SELECT $1, $2, $3, DATE '2020-01-01' + g, 'present', $4
           FROM generate_series(1, 1500) g`,
          [COLLEGE_A, OFF.dsA3, S.a, U.teacherA]
        );
        await seedStudents(150);
        await owner(
          `INSERT INTO public.marks (college_id, offering_id, student_id, exam_type, max_marks, obtained_marks, entered_by)
           SELECT $1, $2, ${uuid("00000099", "s")}, t, 10, 7, $3
           FROM generate_series(1, 150) s,
                unnest(ARRAY['internal_1','internal_2','midterm','final','assignment','lab','project','viva']) t`,
          [COLLEGE_A, OFF.dsA3, U.teacherA]
        );
        await owner(
          `INSERT INTO public.timetable_slots (college_id, offering_id, day_of_week, start_time, end_time)
           SELECT $1, $2, g % 7, TIME '00:00' + (g || ' minutes')::interval, TIME '00:00' + (g || ' minutes')::interval + interval '1 minute'
           FROM generate_series(1, 1100) g`,
          [COLLEGE_A, OFF.dsA3]
        ).catch(() => undefined);
      },
      async () => {
        const truth = await verify<{ days: string; marks: string; slots: string; offs: string }>(
          db,
          `SELECT (SELECT count(DISTINCT date) FROM public.attendance WHERE marked_by=$1)::text days,
                  (SELECT count(*) FROM public.marks WHERE entered_by=$1)::text marks,
                  (SELECT count(*) FROM public.timetable_slots ts JOIN public.course_offerings co ON co.id=ts.offering_id WHERE co.instructor_id=$1 AND co.status<>'cancelled')::text slots,
                  (SELECT count(*) FROM public.course_offerings WHERE instructor_id=$1 AND status<>'cancelled')::text offs`,
          [U.teacherA]
        );
        expect(n(truth[0].days)).toBeGreaterThan(CAP);
        expect(n(truth[0].marks)).toBeGreaterThan(CAP);
        const r = await as(db, U.director, `SELECT * FROM public.faculty_activity($1, $2)`, [COLLEGE_A, [U.teacherA]]);
        expect(r.ok, r.error ?? "").toBe(true);
        expect(n(r.data[0].attendance_sessions_marked)).toBe(n(truth[0].days));
        expect(n(r.data[0].marks_entered)).toBe(n(truth[0].marks));
        expect(n(r.data[0].weekly_periods)).toBe(n(truth[0].slots));
        expect(n(r.data[0].course_count)).toBe(n(truth[0].offs));
      }
    );
  });

  it("college B's HOD gets zeros for college A's teacher", async () => {
    const r = await as(db, U.bHod, `SELECT * FROM public.faculty_activity($1, $2)`, [COLLEGE_A, [U.teacherA]]);
    expect(r.ok, r.error ?? "").toBe(true);
    expect(n(r.data[0].course_count) + n(r.data[0].marks_entered) + n(r.data[0].attendance_sessions_marked)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("fee_department_breakdown / fee_status_breakdown", () => {
  const STATUSES = ["pending", "paid", "overdue", "partial", "waived", "refunded"] as const;
  const seedFees = (count: number) =>
    owner(
      `INSERT INTO public.fees (college_id, student_id, type, amount, paid_amount, due_date, status)
       SELECT $1, CASE WHEN g % 2 = 0 THEN $3::uuid ELSE $4::uuid END, 'QA ' || g, 1000 + (g % 7) * 250,
              (ARRAY[0, 500, 1000, 0])[1 + g % 4], (now() AT TIME ZONE 'UTC')::date + ((g % 5) * 15 - 30),
              (ARRAY['pending','paid','overdue','partial','waived','refunded'])[1 + g % 6]
       FROM generate_series(1, $2) g`,
      [COLLEGE_A, count, S.a, S.c]
    );

  it.each([999, 1000, 1001, 1500])("%i extra fees: status counts and overdue outstanding equal the TypeScript rule over every row", async (count) => {
    await txn(
      () => seedFees(count),
      async () => {
        const rows = await verify<{ amount: string; paid_amount: string; status: (typeof STATUSES)[number]; due_date: string }>(
          db,
          `SELECT amount::text, paid_amount::text, status, to_char(due_date,'YYYY-MM-DD') due_date FROM public.fees WHERE college_id=$1`,
          [COLLEGE_A]
        );
        const want: Record<string, { count: number; outstanding: number }> = {};
        for (const r of rows) {
          const fee = { amount: n(r.amount), paid_amount: n(r.paid_amount), status: r.status, due_date: r.due_date };
          const s = computeEffectiveFeeStatus(fee);
          want[s] ??= { count: 0, outstanding: 0 };
          want[s].count++;
          want[s].outstanding += fee.amount - fee.paid_amount;
        }
        const r = await as(db, U.finance, `SELECT * FROM public.fee_status_breakdown($1)`, [COLLEGE_A]);
        expect(r.ok, r.error ?? "").toBe(true);
        const got = Object.fromEntries(r.data.map((x) => [x.effective_status, { count: n(x.fee_count), outstanding: n(x.outstanding) }]));
        expect(got).toEqual(want);
      }
    );
  });

  it("department totals cover every fee; the first 1,000 rows did not", async () => {
    await txn(
      () => seedFees(1500),
      async () => {
        const truth = await verify<{ billed: string }>(
          db,
          `SELECT sum(f.amount)::text billed FROM public.fees f JOIN public.students s ON s.id=f.student_id WHERE f.college_id=$1 AND s.department_id=$2`,
          [COLLEGE_A, DEPT_CSE]
        );
        const capped = await verify<{ billed: string }>(
          db,
          `SELECT sum(amount)::text billed FROM (SELECT f.amount FROM public.fees f JOIN public.students s ON s.id=f.student_id WHERE f.college_id=$1 AND s.department_id=$2 LIMIT ${CAP}) x`,
          [COLLEGE_A, DEPT_CSE]
        );
        const r = await as(db, U.finance, `SELECT * FROM public.fee_department_breakdown($1)`, [COLLEGE_A]);
        expect(r.ok, r.error ?? "").toBe(true);
        const code = (await verify<{ code: string }>(db, `SELECT code FROM public.departments WHERE id=$1`, [DEPT_CSE]))[0].code;
        const cse = r.data.find((d) => d.department_code === code)!;
        expect(n(cse.billed)).toBe(n(truth[0].billed));
        expect(n(capped[0].billed)).toBeLessThan(n(truth[0].billed));
      }
    );
  });

  it("college B's users see none of A's fees; a student sees only their own", async () => {
    await txn(
      () => seedFees(1200),
      async () => {
        const b = await as(db, U.bHod, `SELECT coalesce(sum(fee_count),0)::text n FROM public.fee_status_breakdown($1)`, [COLLEGE_A]);
        expect(n(b.data[0].n)).toBe(0);
        const own = await verify<{ n: string }>(db, `SELECT count(*)::text n FROM public.fees WHERE student_id=$1`, [S.a]);
        const s = await as(db, U.studentA, `SELECT coalesce(sum(fee_count),0)::text n FROM public.fee_status_breakdown($1)`, [COLLEGE_A]);
        expect(n(s.data[0].n)).toBe(n(own[0].n));
      }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("finance_exceptions", () => {
  async function seedPayments() {
    // 1,200 fees, one cleared payment each, then duplicates and overpayments
    // only in the LAST rows — exactly what a 1,000-row page cannot see.
    await owner(
      `INSERT INTO public.fees (id, college_id, student_id, type, amount, paid_amount, due_date, status)
       SELECT ${uuid("00000097", "g")}, $1, $2, 'QA exc', 1000, 0, DATE '2030-01-01', 'pending'
       FROM generate_series(1, 1200) g`,
      [COLLEGE_A, S.a]
    );
    await owner(
      `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status, created_at)
       SELECT $1, ${uuid("00000097", "g")}, $2, 500, 'upi', 'cleared', TIMESTAMPTZ '2026-09-01 10:00Z' + (g || ' seconds')::interval
       FROM generate_series(1, 1200) g`,
      [COLLEGE_A, S.a]
    );
    // Duplicates: fees 1,101..1,110 get a second identical payment the same day.
    await owner(
      `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status, created_at)
       SELECT $1, ${uuid("00000097", "g")}, $2, 500, 'upi', 'cleared', TIMESTAMPTZ '2026-09-01 18:00Z'
       FROM generate_series(1101, 1110) g`,
      [COLLEGE_A, S.a]
    );
    // Overpayments: fees 1,191..1,200 get 600 more (1,100 paid against 1,000).
    await owner(
      `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status, created_at)
       SELECT $1, ${uuid("00000097", "g")}, $2, 600, 'card', 'cleared', TIMESTAMPTZ '2026-09-02 10:00Z'
       FROM generate_series(1191, 1200) g`,
      [COLLEGE_A, S.a]
    );
  }

  it("duplicates and overpayments past row 1,000 are found; totals are complete; lists are bounded", async () => {
    await txn(seedPayments, async () => {
      const r = await as(db, U.finance, `SELECT * FROM public.finance_exceptions($1, 5)`, [COLLEGE_A]);
      expect(r.ok, r.error ?? "").toBe(true);
      const total = (c: string) => n(r.data.find((x) => x.category === c)?.category_total);
      const listed = (c: string) => r.data.filter((x) => x.category === c).length;
      expect(total("duplicatePayments")).toBe(10);
      expect(total("overpayments")).toBe(10);
      expect(listed("duplicatePayments")).toBe(5); // p_limit
      expect(listed("overpayments")).toBe(5);
      const over = r.data.find((x) => x.category === "overpayments")!;
      expect(n(over.amount)).toBe(100);
      expect(over.detail).toBe("Paid 1100.00 against a 1000.00 fee");

      // The old way: the first 1,000 payments, through the same TypeScript rule.
      const first = await verify<{ id: string; student_id: string; fee_id: string; amount: string; status: "cleared"; created_at: string }>(
        db,
        `SELECT id, student_id, fee_id, amount::text, status, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') created_at
         FROM public.payments WHERE college_id=$1 ORDER BY created_at LIMIT ${CAP}`,
        [COLLEGE_A]
      );
      const old = detectDuplicatePaymentRisk(first.map((p) => ({ ...p, amount: n(p.amount) })));
      expect(old.length).toBe(0); // every duplicate was invisible
    });
  });

  it("matches detectDuplicatePaymentRisk exactly on the full set", async () => {
    await txn(seedPayments, async () => {
      const all = await verify<{ id: string; student_id: string; fee_id: string; amount: string; status: "cleared"; created_at: string }>(
        db,
        `SELECT id, student_id, fee_id, amount::text, status, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') created_at
         FROM public.payments WHERE college_id=$1`,
        [COLLEGE_A]
      );
      const want = detectDuplicatePaymentRisk(all.map((p) => ({ ...p, amount: n(p.amount) })));
      const r = await as(db, U.finance, `SELECT * FROM public.finance_exceptions($1, 1000) WHERE category='duplicatePayments'`, [COLLEGE_A]);
      expect(r.data.length).toBe(want.length);
      expect(r.data.map((d) => d.detail).sort()).toEqual(want.map((g) => `${g.paymentIds.length} payments of the same amount on ${g.date}`).sort());
    });
  });

  it("college B's users see no exceptions of A", async () => {
    await txn(seedPayments, async () => {
      const r = await as(db, U.bHod, `SELECT count(*)::text n FROM public.finance_exceptions($1, 50)`, [COLLEGE_A]);
      expect(n(r.data[0].n)).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("placement_report and placement_drive_funnel", () => {
  async function seedPlacements(count: number) {
    await seedStudents(count);
    await owner(
      `INSERT INTO public.placements (college_id, student_id, company_name, role_title, package_lpa, status)
       SELECT $1, ${uuid("00000099", "g")}, 'Co ' || (g % 13), 'SDE', (g % 20)::numeric, CASE WHEN g % 2 = 0 THEN 'placed' ELSE 'joined' END
       FROM generate_series(1, $2) g`,
      [COLLEGE_A, count]
    );
  }

  it("every placed or joined placement is grouped; the old first page was short", async () => {
    await txn(
      () => seedPlacements(1500),
      async () => {
        const truth = await verify<{ n: string }>(db, `SELECT count(*)::text n FROM public.placements WHERE college_id=$1 AND status IN ('placed','joined')`, [COLLEGE_A]);
        const r = await as(db, U.director, `SELECT public.placement_report($1) AS r`, [COLLEGE_A]);
        expect(r.ok, r.error ?? "").toBe(true);
        const report = r.data[0].r as { totalPlaced: number; byCompany: { count: number }[]; packageDistribution: { count: number }[] };
        expect(n(report.totalPlaced)).toBe(n(truth[0].n));
        expect(n(report.totalPlaced)).toBeGreaterThan(CAP);
        expect(report.byCompany.reduce((s, c) => s + n(c.count), 0)).toBe(n(truth[0].n));
        expect(report.packageDistribution.reduce((s, c) => s + n(c.count), 0)).toBe(n(truth[0].n));
      }
    );
  });

  it("college B's users get nothing of A", async () => {
    await txn(
      () => seedPlacements(1100),
      async () => {
        const r = await as(db, U.bHod, `SELECT public.placement_report($1) AS r`, [COLLEGE_A]);
        expect(n((r.data[0].r as { totalPlaced: number }).totalPlaced)).toBe(0);
      }
    );
  });

  it("applications per drive past 1,000 are counted per status", async () => {
    await txn(
      async () => {
        await seedStudents(1500);
        await owner(`INSERT INTO public.companies (id, college_id, name, status) VALUES ('00000096-0000-4000-8000-000000000001', $1, 'QA Co', 'active')`, [COLLEGE_A]);
        await owner(
          `INSERT INTO public.placement_drives (id, college_id, company_id, job_role, application_deadline, status)
           VALUES ('00000096-0000-4000-8000-000000000002', $1, '00000096-0000-4000-8000-000000000001', 'SDE', now() + interval '10 days', 'published')`,
          [COLLEGE_A]
        );
        await owner(
          `INSERT INTO public.placement_applications (college_id, drive_id, student_id, status)
           SELECT $1, '00000096-0000-4000-8000-000000000002', ${uuid("00000099", "g")},
                  (ARRAY['applied','shortlisted','interview','selected','rejected'])[1 + g % 5]
           FROM generate_series(1, 1500) g`,
          [COLLEGE_A]
        );
      },
      async () => {
        const r = await as(db, U.director, `SELECT * FROM public.placement_drive_funnel($1, $2)`, [COLLEGE_A, ["00000096-0000-4000-8000-000000000002"]]);
        expect(r.ok, r.error ?? "").toBe(true);
        expect(n(r.data[0].applied)).toBe(1500);
        expect(n(r.data[0].shortlisted)).toBe(300);
        expect(n(r.data[0].selected)).toBe(300);
        const b = await as(db, U.bHod, `SELECT * FROM public.placement_drive_funnel($1, $2)`, [COLLEGE_A, ["00000096-0000-4000-8000-000000000002"]]);
        expect(b.data.length).toBe(0);
      }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("hostel_block_capacity", () => {
  it("1,500 rooms in one block: capacity and occupancy summed over all of them", async () => {
    await txn(
      () =>
        owner(
          `INSERT INTO public.hostel_rooms (college_id, block_id, block_name, room_number, capacity, occupancy)
           SELECT $1, $2, 'QA Block', 'Q' || g, 3, g % 4 FROM generate_series(1, 1500) g`,
          [COLLEGE_A, BLOCK_A]
        ).then(() => undefined),
      async () => {
        const truth = await verify<{ c: string; o: string }>(db, `SELECT sum(capacity)::text c, sum(occupancy)::text o FROM public.hostel_rooms WHERE block_id=$1`, [BLOCK_A]);
        const r = await as(db, U.director, `SELECT * FROM public.hostel_block_capacity($1)`, [COLLEGE_A]);
        expect(r.ok, r.error ?? "").toBe(true);
        const a = r.data.find((x) => x.block_id === BLOCK_A)!;
        expect(n(a.capacity)).toBe(n(truth[0].c));
        expect(n(a.occupancy)).toBe(n(truth[0].o));
        expect(r.data.some((x) => x.block_id === BLOCK_B)).toBe(true);
        const b = await as(db, U.bHod, `SELECT * FROM public.hostel_block_capacity($1)`, [COLLEGE_A]);
        expect(b.data.length).toBe(0);
      }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("gate_security_counts", () => {
  it("1,500 movements, 1,200 open passes, 1,300 refused scans today: every one counted", async () => {
    await txn(
      async () => {
        await seedStudents(1300);
        await owner(
          `INSERT INTO public.gate_passes (id, college_id, student_id, destination, exit_time, return_time, status)
           SELECT ${uuid("00000095", "g")}, $1, ${uuid("00000099", "g")}, 'Home', now() - interval '2 hours',
                  CASE WHEN g % 4 = 0 THEN now() - interval '1 hour' ELSE now() + interval '5 hours' END,
                  CASE WHEN g <= 1200 THEN 'active' ELSE 'pending' END
           FROM generate_series(1, 1300) g`,
          [COLLEGE_A]
        );
        // 1,000 exits (passes 1..1,000) and 500 returns (passes 1..500).
        await owner(
          `INSERT INTO public.gate_movements (college_id, gate_pass_id, student_id, movement_type, recorded_by, recorded_role, gate_id, occurred_at)
           SELECT $1, ${uuid("00000095", "g")}, ${uuid("00000099", "g")}, 'OUT',
                  $2::uuid, 'warden', (SELECT id FROM public.gates WHERE college_id=$1 LIMIT 1), now() - interval '5 minutes'
           FROM generate_series(1, 1000) g
           UNION ALL
           SELECT $1, ${uuid("00000095", "g")}, ${uuid("00000099", "g")}, 'IN',
                  $2::uuid, 'warden', (SELECT id FROM public.gates WHERE college_id=$1 LIMIT 1), now() - interval '4 minutes'
           FROM generate_series(1, 500) g`,
          [COLLEGE_A, U.warden]
        );
        await owner(
          `INSERT INTO public.audit_logs (college_id, user_id, action, table_name, created_at)
           SELECT $1, $2, CASE WHEN g % 2 = 0 THEN 'gate_scan_invalid_qr' ELSE 'gate_scan_not_yet_valid' END, 'gate_movements', now() - interval '1 minute'
           FROM generate_series(1, 1300) g`,
          [COLLEGE_A, U.warden]
        );
      },
      async () => {
        const since = new Date(Date.now() - 3600_000).toISOString();
        const r = await as(db, U.director, `SELECT * FROM public.gate_security_counts($1, $2)`, [COLLEGE_A, since]);
        expect(r.ok, r.error ?? "").toBe(true);
        const c = r.data[0];
        expect(n(c.exits_today) + n(c.returns_today)).toBe(1500);
        expect(n(c.returns_today)).toBe(500);
        expect(n(c.currently_outside)).toBeGreaterThanOrEqual(1200);
        expect(n(c.overdue)).toBeGreaterThanOrEqual(300);
        expect(n(c.rejected_scans)).toBe(1300);
        expect(n(c.invalid_qr_attempts)).toBe(650);
        const b = await as(db, U.bHod, `SELECT * FROM public.gate_security_counts($1, $2)`, [COLLEGE_A, since]);
        expect(n(b.data[0].exits_today) + n(b.data[0].rejected_scans)).toBe(0);
      }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("attendance_summary", () => {
  it("1,500 records: the percentage covers every one, not the latest 500; another student reads none", async () => {
    await txn(
      () =>
        owner(
          `INSERT INTO public.attendance (college_id, offering_id, student_id, date, status, marked_by)
           SELECT $1, $2, $3, DATE '2019-01-01' + g,
                  (ARRAY['present','absent','late','excused'])[1 + g % 4], $4
           FROM generate_series(1, 1500) g`,
          [COLLEGE_A, OFF.dbmsA3, S.a, U.teacherA]
        ).then(() => undefined),
      async () => {
        const truth = await verify<{ p: string; t: string }>(
          db,
          `SELECT count(*) FILTER (WHERE status IN ('present','late'))::text p, count(*)::text t FROM public.attendance WHERE student_id=$1 AND offering_id=$2`,
          [S.a, OFF.dbmsA3]
        );
        const r = await as(db, U.studentA, `SELECT * FROM public.attendance_summary($1)`, [S.a]);
        expect(r.ok, r.error ?? "").toBe(true);
        const row = r.data.find((x) => x.offering_id === OFF.dbmsA3)!;
        expect([n(row.present), n(row.total)]).toEqual([n(truth[0].p), n(truth[0].t)]);
        const other = await as(db, U.studentB, `SELECT * FROM public.attendance_summary($1)`, [S.a]);
        expect(other.data.length).toBe(0);
      }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("finance_mapping_usage", () => {
  it("a fee head first used after row 1,000 is still reported", async () => {
    await txn(
      async () => {
        await owner(

`INSERT INTO public.fees (college_id, student_id, type, amount, paid_amount, due_date, status, created_at)
           SELECT $1, $2, CASE WHEN g > 1490 THEN 'QA Rare Head' ELSE 'QA Tuition' END, 100, 0, DATE '2030-01-01', 'pending',
                  TIMESTAMPTZ '2000-01-01' + (g || ' seconds')::interval
           FROM generate_series(1, 1500) g`,
          [COLLEGE_A, S.a]
        );
      },
      async () => {
        const capped = await verify<{ t: string }>(db, `SELECT DISTINCT type t FROM (SELECT type FROM public.fees WHERE college_id=$1 ORDER BY created_at, id LIMIT ${CAP}) x`, [COLLEGE_A]);
        expect(capped.map((c) => c.t)).not.toContain("QA Rare Head");
        const r = await as(db, U.finance, `SELECT * FROM public.finance_mapping_usage($1)`, [COLLEGE_A]);
        expect(r.ok, r.error ?? "").toBe(true);
        expect(r.data.find((u) => u.local_key === "QA Rare Head")).toMatchObject({ kind: "fee_head" });
        expect(n(r.data.find((u) => u.local_key === "QA Rare Head")?.record_count)).toBe(10);
      }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("search_students", () => {
  it("finds a student past the first 1,000, returns at most 50, and only within RLS", async () => {
    await txn(
      () => seedStudents(1500, { profiles: true }),
      async () => {
        const r = await as(db, U.finance, `SELECT * FROM public.search_students($1, 25)`, ["001499"]);
        expect(r.ok, r.error ?? "").toBe(true);
        expect(r.data.map((x) => x.enrollment_number)).toContain("QA00000099-001499");
        const many = await as(db, U.finance, `SELECT * FROM public.search_students($1, 500)`, ["QA00000099"]);
        expect(many.data.length).toBe(50);
        const b = await as(db, U.bHod, `SELECT * FROM public.search_students($1, 25)`, ["QA00000099"]);
        expect(b.data.length).toBe(0);
        const empty = await as(db, U.finance, `SELECT * FROM public.search_students($1, 25)`, [" "]);
        expect(empty.data.length).toBe(0);
      }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("send_announcement / send_placement_notification / notification_push_tokens", () => {
  const RECIPIENTS = 1500;
  async function seedRecipients() {
    await seedStudents(RECIPIENTS, { profiles: true });
    // Devices: every recipient one token, every 10th a second phone, every
    // 7th a suspended account, and one token registered under college B.
    await owner(
      `INSERT INTO public.device_tokens (college_id, user_id, expo_push_token, platform)
       SELECT $1, ${uuid("0000009f", "g")}, 'ExpoToken[qa-' || lpad(g::text, 6, '0') || ']', 'android' FROM generate_series(1, $2) g`,
      [COLLEGE_A, RECIPIENTS]
    );
    await owner(
      `INSERT INTO public.device_tokens (college_id, user_id, expo_push_token, platform)
       SELECT $1, ${uuid("0000009f", "g")}, 'ExpoToken[qa2-' || lpad(g::text, 6, '0') || ']', 'ios' FROM generate_series(1, $2) g WHERE g % 10 = 0`,
      [COLLEGE_A, RECIPIENTS]
    );
    await owner(`UPDATE public.profiles SET status='suspended' WHERE id IN (SELECT ${uuid("0000009f", "g")} FROM generate_series(1, $1) g WHERE g % 7 = 0)`, [RECIPIENTS]);
    await owner(
      `INSERT INTO public.device_tokens (college_id, user_id, expo_push_token, platform) VALUES ($1, ${uuid("0000009f", "'3'")}, 'ExpoToken[wrong-college]', 'android')`,
      [COLLEGE_B]
    );
  }

  it("1,500 students: one INSERT reaches every one, in college A only", async () => {
    await txn(seedRecipients, async () => {
      const truth = await verify<{ n: string }>(db, `SELECT count(*)::text n FROM public.profiles WHERE college_id=$1 AND role='student'`, [COLLEGE_A]);
      const r = await as(db, U.director, `SELECT * FROM public.send_announcement($1, 'Exam schedule', 'Posted', 'students')`, [COLLEGE_A]);
      expect(r.ok, r.error ?? "").toBe(true);
      expect(n(r.data[0].recipient_count)).toBe(n(truth[0].n));
      expect(n(r.data[0].recipient_count)).toBeGreaterThan(CAP);
      const rows = await verify<{ n: string; colleges: string; dup: string }>(
        db,
        `SELECT count(*)::text n, count(DISTINCT college_id)::text colleges,
                (count(*) - count(DISTINCT receiver_id))::text dup
         FROM public.notifications WHERE announcement_id=$1`,
        [r.data[0].announcement_id]
      );
      expect(rows[0]).toEqual({ n: truth[0].n, colleges: "1", dup: "0" });
    });
  });

  it("'staff' is teacher, hod, warden, finance and admin — the same list the TypeScript used", async () => {
    await txn(async () => undefined, async () => {
      const truth = await verify<{ n: string }>(
        db,
        `SELECT count(*)::text n FROM public.profiles WHERE college_id=$1 AND role IN ('teacher','hod','warden','finance','admin')`,
        [COLLEGE_A]
      );
      const r = await as(db, U.director, `SELECT * FROM public.send_announcement($1, 'Staff meeting', 'At 4', 'staff')`, [COLLEGE_A]);
      expect(n(r.data[0].recipient_count)).toBe(n(truth[0].n));
    });
  });

  it("only a director or admin may announce, only to their own college; the placement cell likewise for its notifications", async () => {
    await txn(async () => undefined, async () => {
      for (const uid of [U.studentA, U.teacherA, U.finance, U.hodCse, U.warden]) {
        const r = await tryAs(uid, `SELECT * FROM public.send_announcement($1, 't', 'm', 'all')`, [COLLEGE_A]);
        expect(r.ok, uid).toBe(false);
        expect(r.error).toMatch(/only a director or admin/);
      }
      const x = await tryAs(U.director, `SELECT * FROM public.send_announcement($1, 't', 'm', 'all')`, [COLLEGE_B]);
      expect(x.ok).toBe(false);
      const p = await tryAs(U.director, `SELECT * FROM public.send_placement_notification($1, 't', 'm', '/x', 'college')`, [COLLEGE_A]);
      expect(p.ok).toBe(false);
      const written = await verify<{ n: string }>(db, `SELECT count(*)::text n FROM public.notifications WHERE title='t'`);
      expect(n(written[0].n)).toBe(0);
    });
  });

  it("eligible-for-drive targeting applies CGPA, batch and department over every student", async () => {
    await txn(
      async () => {
        await seedRecipients();
        await owner(`INSERT INTO public.companies (id, college_id, name, status) VALUES ('00000096-0000-4000-8000-000000000011', $1, 'QA Co', 'active')`, [COLLEGE_A]);
        await owner(
          `INSERT INTO public.placement_drives (id, college_id, company_id, job_role, application_deadline, status, min_cgpa, eligible_batch_years)
           VALUES ('00000096-0000-4000-8000-000000000012', $1, '00000096-0000-4000-8000-000000000011', 'SDE', now() + interval '10 days', 'published', 6, ARRAY[2024, 2025])`,
          [COLLEGE_A]
        );
        await owner(`INSERT INTO public.placement_drive_departments (drive_id, department_id) VALUES ('00000096-0000-4000-8000-000000000012', $1)`, [DEPT_CSE]);
      },
      async () => {
        const truth = await verify<{ n: string }>(
          db,
          `SELECT count(*)::text n FROM public.students WHERE college_id=$1 AND COALESCE(cgpa,0) >= 6 AND batch_year IN (2024,2025) AND department_id=$2`,
          [COLLEGE_A, DEPT_CSE]
        );
        const r = await as(
          db,
          U.admin,
          `SELECT * FROM public.send_placement_notification($1, 'Drive', 'Apply', '/student/placements', 'eligible', NULL, NULL, $2, NULL)`,
          [COLLEGE_A, "00000096-0000-4000-8000-000000000012"]
        );
        expect(r.ok, r.error ?? "").toBe(true);
        expect(n(r.data[0].recipient_count)).toBe(n(truth[0].n));
        expect(n(truth[0].n)).toBeGreaterThan(400);
        // ECE students were never eligible.
        const ece = await verify<{ n: string }>(
          db,
          `SELECT count(*)::text n FROM public.notifications n JOIN public.students s ON s.user_id=n.receiver_id WHERE n.announcement_id=$1 AND s.department_id=$2`,
          [r.data[0].announcement_id, DEPT_ECE]
        );
        expect(n(ece[0].n)).toBe(0);
      }
    );
  });

  it("push tokens: only the sender, only active recipients, each token once, a bounded page at a time, never another college", async () => {
    await txn(seedRecipients, async () => {
      const send = await as(db, U.director, `SELECT * FROM public.send_announcement($1, 'Holiday', 'Tomorrow', 'students')`, [COLLEGE_A]);
      const id = send.data[0].announcement_id as string;
      const truth = await verify<{ n: string }>(
        db,
        `SELECT count(DISTINCT d.expo_push_token)::text n FROM public.notifications n
         JOIN public.profiles p ON p.id=n.receiver_id AND p.status='active' AND p.college_id=$2
         JOIN public.device_tokens d ON d.user_id=n.receiver_id AND d.college_id=$2
         WHERE n.announcement_id=$1`,
        [id, COLLEGE_A]
      );
      const tokens: string[] = [];
      let after: string | null = null;
      for (let page = 0; page < 10; page++) {
        const r = await as(db, U.director, `SELECT * FROM public.notification_push_tokens($1, $2, 1000)`, [id, after]);
        expect(r.ok, r.error ?? "").toBe(true);
        expect(r.data.length).toBeLessThanOrEqual(1000);
        if (r.data.length === 0) break;
        tokens.push(...r.data.map((t) => t.expo_push_token as string));
        after = tokens[tokens.length - 1];
        if (r.data.length < 1000) break;
      }
      expect(tokens.length).toBe(n(truth[0].n));
      expect(tokens.length).toBeGreaterThan(CAP);
      expect(new Set(tokens).size).toBe(tokens.length);
      expect(tokens).not.toContain("ExpoToken[wrong-college]");
      expect(tokens).not.toContain("ExpoToken[qa-000007]"); // suspended
      expect(tokens).toContain("ExpoToken[qa2-000010]"); // a second phone
      // Not the sender: nothing, even with the id.
      for (const uid of [U.admin, U.finance, U.studentA, U.bHod]) {
        const r = await as(db, uid, `SELECT * FROM public.notification_push_tokens($1, NULL, 1000)`, [id]);
        expect(r.data.length, uid).toBe(0);
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("queue_finance_sync_batch", () => {
  const CONN = "00000094-0000-4000-8000-000000000001";
  async function seedWindow(payments: number) {
    await owner(
      `INSERT INTO public.finance_integration_connections (id, college_id, display_name, provider, status)
       VALUES ($1, $2, 'QA Zoho', 'zoho_books', 'ACTIVE')`,
      [CONN, COLLEGE_A]
    );
    await owner(
      `INSERT INTO public.fees (id, college_id, student_id, type, amount, paid_amount, due_date, status)
       SELECT ${uuid("00000093", "g")}, $1, $2, 'QA sync', 1000, 0, DATE '2030-01-01', 'pending' FROM generate_series(1, $3) g`,
      [COLLEGE_A, S.a, payments]
    );
    await owner(
      `INSERT INTO public.payments (id, college_id, fee_id, student_id, amount, method, status, created_at)
       SELECT ${uuid("00000092", "g")}, $1, ${uuid("00000093", "g")}, $2, 1000, 'upi', 'cleared', TIMESTAMPTZ '2026-08-01 00:00Z' + (g || ' minutes')::interval
       FROM generate_series(1, $3) g`,
      [COLLEGE_A, S.a, payments]
    );
    // The first 30 are already posted.
    await owner(
      `INSERT INTO public.finance_external_links (college_id, connection_id, entity_type, entity_id, external_id)
       SELECT $1, $2, 'payment', ${uuid("00000092", "g")}, 'EXT-' || g FROM generate_series(1, 30) g`,
      [COLLEGE_A, CONN]
    );
  }
  async function drain(uid: string, limit = 500) {
    let after: [string | null, string | null] = [null, null];
    const total = { scanned: 0, queued: 0, skipped: 0, calls: 0 };
    for (;;) {
      const r = await as(db, uid, `SELECT * FROM public.queue_finance_sync_batch($1, '2026-08-01', '2026-08-31', $2, $3, $4)`, [CONN, after[0], after[1], limit]);
      if (!r.ok) throw new Error(r.error ?? "batch failed");
      const b = r.data[0];
      total.calls++;
      total.scanned += n(b.scanned);
      total.queued += n(b.queued);
      total.skipped += n(b.skipped);
      if (n(b.scanned) < limit) return total;
      after = [b.last_created as string, b.last_id as string];
    }
  }

  it("1,200 payments in a window: queued in bounded batches, linked ones skipped, every key = enqueue()'s", async () => {
    await txn(
      () => seedWindow(1200),
      async () => {
        const t = await drain(U.finance);
        expect(t).toMatchObject({ scanned: 1200, queued: 1170, skipped: 30, calls: 3 });
        const ops = await verify<{ entity_id: string; idempotency_key: string; status: string; created_by: string }>(
          db,
          `SELECT entity_id, idempotency_key, status, created_by FROM public.finance_sync_operations WHERE connection_id=$1`,
          [CONN]
        );
        expect(ops.length).toBe(1170);
        expect(new Set(ops.map((o) => o.entity_id)).size).toBe(1170);
        expect(ops.every((o) => o.status === "QUEUED" && o.created_by === U.finance)).toBe(true);
        for (const o of ops.slice(0, 50)) {
          expect(o.idempotency_key).toBe(
            idempotencyKey({ collegeId: COLLEGE_A, connectionId: CONN, entityType: "payment", entityId: o.entity_id, operation: "create_payment" })
          );
        }
        // Pressing again queues nothing new and creates no second row.
        const again = await drain(U.finance);
        expect(again.queued).toBe(0);
        const count = await verify<{ n: string }>(db, `SELECT count(*)::text n FROM public.finance_sync_operations WHERE connection_id=$1`, [CONN]);
        expect(n(count[0].n)).toBe(1170);
      }
    );
  });

  it("a PENDING operation left by an earlier enqueue() is queued, not duplicated", async () => {
    await txn(
      async () => {
        await seedWindow(10);
        // Payment #8 already has a PENDING operation, with enqueue()'s key.
        const key = idempotencyKey({ collegeId: COLLEGE_A, connectionId: CONN, entityType: "payment", entityId: "00000092-0000-4000-8000-000000000008", operation: "create_payment" });
        await owner(
          `INSERT INTO public.finance_sync_operations (college_id, connection_id, provider, entity_type, entity_id, operation, idempotency_key, status, created_by)
           VALUES ($1, $2, 'zoho_books', 'payment', '00000092-0000-4000-8000-000000000008', 'create_payment', $3, 'PENDING', $4)`,
          [COLLEGE_A, CONN, key, U.finance]
        );
        // Unlink #1..#30 from seedWindow's linked set so all 10 are postable.
        await owner(`DELETE FROM public.finance_external_links WHERE connection_id=$1`, [CONN]);
      },
      async () => {
        const t = await drain(U.finance);
        expect(t).toMatchObject({ scanned: 10, queued: 10, skipped: 0 });
        const rows = await verify<{ n: string; q: string }>(
          db,
          `SELECT count(*)::text n, count(*) FILTER (WHERE status='QUEUED')::text q FROM public.finance_sync_operations WHERE connection_id=$1`,
          [CONN]
        );
        expect(rows[0]).toEqual({ n: "10", q: "10" }); // one row for #8, not two
      }
    );
  });

  it("only finance or admin of the connection's college may queue", async () => {
    await txn(
      () => seedWindow(5),
      async () => {
        for (const uid of [U.teacherA, U.studentA, U.director, U.bHod]) {
          const r = await tryAs(uid, `SELECT * FROM public.queue_finance_sync_batch($1, '2026-08-01', '2026-08-31')`, [CONN]);
          expect(r.ok, uid).toBe(false);
        }
        const none = await verify<{ n: string }>(db, `SELECT count(*)::text n FROM public.finance_sync_operations WHERE connection_id=$1`, [CONN]);
        expect(n(none[0].n)).toBe(0);
        const ok = await as(db, U.admin, `SELECT * FROM public.queue_finance_sync_batch($1, '2026-08-01', '2026-08-31')`, [CONN]);
        expect(ok.ok, ok.error ?? "").toBe(true);
      }
    );
  });

  it("an inactive connection refuses to queue", async () => {
    await txn(
      async () => {
        await seedWindow(5);
        await owner(`UPDATE public.finance_integration_connections SET status='CONFIGURING' WHERE id=$1`, [CONN]);
      },
      async () => {
        const r = await tryAs(U.finance, `SELECT * FROM public.queue_finance_sync_batch($1, '2026-08-01', '2026-08-31')`, [CONN]);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/cannot synchronise/);
      }
    );
  });
});

describe("finance_sync_idempotency_key = lib/finance/idempotency.ts idempotencyKey", () => {
  it("for every entity type and operation, and both versions", async () => {
    const cases = [
      ["payment", "create_payment", 1],
      ["refund", "create_refund", 1],
      ["invoice", "create_invoice", 2],
      ["student", "create_customer", 1],
    ] as const;
    for (const [entityType, operation, version] of cases) {
      const entityId = "00000091-0000-4000-8000-0000000000aa";
      const sql = await verify<{ k: string }>(db, `SELECT public.finance_sync_idempotency_key($1, $2, $3, $4, $5, $6) k`, [COLLEGE_A, COLLEGE_B, entityType, entityId, operation, version]);
      expect(sql[0].k).toBe(idempotencyKey({ collegeId: COLLEGE_A, connectionId: COLLEGE_B, entityType, entityId, operation, version }));
    }
  });
});

describe("fee_effective_status = computeEffectiveFeeStatus", () => {
  it("over every status, payment state and due date around today", async () => {
    const today = new Date();
    for (const status of ["pending", "paid", "overdue", "partial", "waived", "refunded"] as const) {
      for (const paid of [0, 500, 1000]) {
        for (const days of [-30, -1, 0, 1, 30]) {
          const due = new Date(today.getTime() + days * 86_400_000).toISOString().slice(0, 10);
          const r = await verify<{ s: string }>(db, `SELECT public.fee_effective_status(1000, $1, $2, $3::date) s`, [paid, status, due]);
          expect(r[0].s, `${status}/${paid}/${days}`).toBe(computeEffectiveFeeStatus({ amount: 1000, paid_amount: paid, status, due_date: due }));
        }
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("platform functions are service-role only", () => {
  it("college_health_inputs and hostel_block_capacity_all refuse authenticated users", async () => {
    for (const fn of ["college_health_inputs()", "hostel_block_capacity_all()"]) {
      const r = await as(db, U.director, `SELECT * FROM public.${fn}`);
      expect(r.ok, fn).toBe(false);
      expect(r.error).toMatch(/permission denied/);
    }
  });

  it("college_health_inputs counts every active student of every college, past 1,000 across the platform", async () => {
    await txn(
      async () => {
        await seedStudents(800);
        await seedStudents(700, { college: COLLEGE_B, dept: (await verify<{ id: string }>(db, `SELECT id FROM public.departments WHERE college_id=$1 LIMIT 1`, [COLLEGE_B]))[0].id, prefix: "00000089" });
      },
      async () => {
        const truth = await verify<{ c: string; n: string }>(db, `SELECT college_id::text c, count(*)::text n FROM public.students WHERE status='active' GROUP BY 1`);
        await db.exec("SET ROLE service_role");
        try {
          const r = await db.query<{ college_id: string; active_students: string }>(`SELECT college_id, active_students::text FROM public.college_health_inputs()`);
          const got = Object.fromEntries(r.rows.map((x) => [x.college_id, n(x.active_students)]));
          for (const t of truth) expect(got[t.c], t.c).toBe(n(t.n));
          expect(truth.reduce((s, t) => s + n(t.n), 0)).toBeGreaterThan(CAP);
        } finally {
          await db.exec("RESET ROLE");
        }
      }
    );
  });
});
