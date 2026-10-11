import { it, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { stagingDb, as, verify, U, S, COLLEGE_A, DEPT_CSE } from "../tests/staging/harness";
import { computeEffectiveFeeStatus, detectDuplicatePaymentRisk } from "@/lib/finance-status";

/**
 * Redis transformation Phase 3 — before/after, LOCAL.
 *
 *   npx vitest run -c vitest.bench.config.ts bench/phase3.bench.ts
 *
 * PGlite (PostgreSQL compiled to WASM, in this process): timings compare
 * the two shapes on one machine and are NOT server or network figures.
 * Query and row counts are exact.
 *
 * "Before" runs the old reads as they were written — each select capped at
 * PostgREST's 1,000 rows — and the old JavaScript over their rows. "After"
 * calls the 059 function as the real role. Writes
 * bench/results/phase3-local.json.
 */

const CAP = 1000;
let db: PGlite;
const out: Record<string, unknown> = {
  note: "LOCAL (PGlite, in-process WASM). Query and row counts exact; times comparative only, not server or network latency.",
};

beforeAll(async () => {
  db = await stagingDb();
}, 300_000);
afterAll(() => {
  mkdirSync("bench/results", { recursive: true });
  writeFileSync("bench/results/phase3-local.json", JSON.stringify(out, null, 2) + "\n");
});

const ms = async <T>(fn: () => Promise<T>) => {
  const t = performance.now();
  const value = await fn();
  return { value, ms: Math.round((performance.now() - t) * 10) / 10 };
};

async function seed(n: number) {
  await db.exec("BEGIN");
  await db.exec("SET session_replication_role = replica");
  await db.query(
    `INSERT INTO public.students (id, college_id, user_id, department_id, enrollment_number, batch_year, status, cgpa)
     SELECT ('00000099-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, $1, ('0000009f-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, $2,
            'B-' || g, 2025, 'active', CASE WHEN g % 3 = 0 THEN 4.5 ELSE 8 END FROM generate_series(1, $3) g`,
    [COLLEGE_A, DEPT_CSE, n]
  );
  await db.query(
    `INSERT INTO public.fees (id, college_id, student_id, type, amount, paid_amount, due_date, status)
     SELECT ('00000097-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, $1, ('00000099-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
            'B', 1000, (ARRAY[0,500,1000])[1 + g % 3], (now() AT TIME ZONE 'UTC')::date + (g % 5) * 15 - 30, 'pending'
     FROM generate_series(1, $2) g`,
    [COLLEGE_A, n]
  );
  await db.query(
    `INSERT INTO public.payments (college_id, fee_id, student_id, amount, method, status, created_at)
     SELECT $1, ('00000097-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, $2, 500, 'upi', 'cleared', TIMESTAMPTZ '2026-08-01' + (g || ' seconds')::interval
     FROM generate_series(1, $3) g`,
    [COLLEGE_A, S.a, n]
  );
  await db.exec("SET session_replication_role = origin");
}

it("risk overview, fee breakdowns, finance exceptions, Sync Now queueing — before vs after", async () => {
  for (const n of [1000, 20_000]) {
    await seed(n);
    const truth = await verify<{ s: string; f: string; p: string }>(
      db,
      `SELECT (SELECT count(*) FROM public.students WHERE college_id=$1 AND status='active')::text s,
              (SELECT count(*) FROM public.fees WHERE college_id=$1)::text f,
              (SELECT count(*) FROM public.payments WHERE college_id=$1)::text p`,
      [COLLEGE_A]
    );
    const total = { students: Number(truth[0].s), fees: Number(truth[0].f), payments: Number(truth[0].p) };

    // Risk overview. Before: three selects (students, fees, failed enrolments), each capped.
    const riskBefore = await ms(async () => {
      const st = await db.query(`SELECT id, department_id, cgpa FROM public.students WHERE college_id=$1 AND status='active' LIMIT ${CAP}`, [COLLEGE_A]);
      const fe = await db.query<{ student_id: string; status: "pending"; due_date: string; amount: string; paid_amount: string }>(
        `SELECT student_id, status, to_char(due_date,'YYYY-MM-DD') due_date, amount::text, paid_amount::text FROM public.fees WHERE college_id=$1 LIMIT ${CAP}`,
        [COLLEGE_A]
      );
      const en = await db.query(`SELECT student_id FROM public.course_enrollments WHERE college_id=$1 AND status='failed' LIMIT ${CAP}`, [COLLEGE_A]);
      const overdue = new Set(fe.rows.filter((f) => computeEffectiveFeeStatus({ ...f, amount: +f.amount, paid_amount: +f.paid_amount }) === "overdue").map((f) => f.student_id));
      return { rows: st.rows.length + fe.rows.length + en.rows.length, students: st.rows.length, overdue: overdue.size };
    });
    const riskAfter = await ms(() => as(db, U.director, `SELECT * FROM public.student_risk_overview($1)`, [COLLEGE_A]));
    const studentsCounted = riskAfter.value.data.reduce((s, r) => s + Number(r.total_students), 0);

    // Fee status breakdown. Before: every fee (capped), effective status in JS.
    const feeBefore = await ms(async () => {
      const fe = await db.query<{ status: "pending"; due_date: string; amount: string; paid_amount: string }>(
        `SELECT status, to_char(due_date,'YYYY-MM-DD') due_date, amount::text, paid_amount::text FROM public.fees WHERE college_id=$1 LIMIT ${CAP}`,
        [COLLEGE_A]
      );
      const counts: Record<string, number> = {};
      for (const f of fe.rows) {
        const s = computeEffectiveFeeStatus({ ...f, amount: +f.amount, paid_amount: +f.paid_amount });
        counts[s] = (counts[s] ?? 0) + 1;
      }
      return { rows: fe.rows.length, counted: Object.values(counts).reduce((a, b) => a + b, 0) };
    });
    const feeAfter = await ms(() => as(db, U.finance, `SELECT * FROM public.fee_status_breakdown($1)`, [COLLEGE_A]));

    // Finance exceptions. Before: every fee and every payment (capped), rules in JS.
    const excBefore = await ms(async () => {
      const fe = await db.query(`SELECT id, amount, paid_amount, status, due_date, student_id FROM public.fees WHERE college_id=$1 LIMIT ${CAP}`, [COLLEGE_A]);
      const pa = await db.query<{ id: string; fee_id: string; student_id: string; amount: string; status: "cleared"; created_at: string }>(
        `SELECT id, fee_id, student_id, amount::text, status, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') created_at FROM public.payments WHERE college_id=$1 LIMIT ${CAP}`,
        [COLLEGE_A]
      );
      detectDuplicatePaymentRisk(pa.rows.map((p) => ({ ...p, amount: +p.amount })));
      return { rows: fe.rows.length + pa.rows.length, paymentsSeen: pa.rows.length };
    });
    const excAfter = await ms(() => as(db, U.finance, `SELECT * FROM public.finance_exceptions($1, 200)`, [COLLEGE_A]));

    out[`rows_${n}`] = {
      dataset: total,
      riskOverview: {
        before: { queries: 3, rowsToApp: riskBefore.value.rows, studentsSeen: riskBefore.value.students, ms: riskBefore.ms },
        after: { queries: 1, rowsToApp: riskAfter.value.data.length, studentsCounted, ms: riskAfter.ms },
      },
      feeStatusBreakdown: {
        before: { queries: 1, rowsToApp: feeBefore.value.rows, feesCounted: feeBefore.value.counted, ms: feeBefore.ms },
        after: { queries: 1, rowsToApp: feeAfter.value.data.length, feesCounted: feeAfter.value.data.reduce((s, r) => s + Number(r.fee_count), 0), ms: feeAfter.ms },
      },
      financeExceptions: {
        before: { queries: 4, rowsToApp: excBefore.value.rows, paymentsSeen: excBefore.value.paymentsSeen, ms: excBefore.ms },
        after: { queries: 1, rowsToApp: excAfter.value.data.length, ms: excAfter.ms },
      },
      // Sync Now, by construction of the code (not timed here; see realpg-phase3-concurrency):
      // before = 1 select + 1 link lookup + 2–3 requests per payment, capped at 1,000 payments;
      // after = ceil(payments / 500) calls, every payment.
      syncNowRequests: {
        before: { requests: `2 + (2 to 3) × min(${total.payments}, 1000)`, paymentsConsidered: Math.min(total.payments, CAP) },
        after: { requests: Math.max(1, Math.ceil(total.payments / 500)), paymentsConsidered: total.payments },
      },
    };
    await db.exec("ROLLBACK");
  }
}, 900_000);
