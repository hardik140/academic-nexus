import { describe, it, expect, vi, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { stagingDb, as, verify, U, S, COLLEGE_A, COLLEGE_B } from "./staging/harness";
import { computeEffectiveFeeStatus } from "@/lib/finance-status";

/**
 * Migration 057, fee_totals(): the finance KPIs computed in PostgreSQL over
 * EVERY fee, instead of in JavaScript over whatever page of rows PostgREST
 * returned (1,000 by default).
 *
 * The parity test is the contract: for 1,500 fees spanning every status,
 * due date and payment state, the SQL totals equal what
 * computeEffectiveFeeStatus (lib/finance-status.ts) says, row by row. If
 * either side's definition of "overdue" or "pending" changes, this fails.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const STATUSES = ["pending", "paid", "overdue", "partial", "waived", "refunded"] as const;
const today = new Date().toISOString().slice(0, 10);
const shift = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

let db: PGlite;
const N = 1500;

beforeAll(async () => {
  db = await stagingDb();
  // Rows written directly by the owner: this tests arithmetic over rows, not
  // the ledger that normally maintains paid_amount.
  await db.exec("ALTER TABLE public.fees DISABLE TRIGGER USER");
  const values: string[] = [];
  for (let i = 0; i < N; i++) {
    const status = STATUSES[i % STATUSES.length];
    const amount = 1000 + (i % 7) * 250;
    const paid = [0, amount / 2, amount, amount + 0][i % 4];
    const due = shift([-30, -1, 0, 1, 30][i % 5]);
    values.push(`('${COLLEGE_A}','${S.a}','QA ${i}',${amount},'${due}','${status}',${paid})`);
  }
  await db.exec(`INSERT INTO public.fees (college_id, student_id, type, amount, due_date, status, paid_amount) VALUES ${values.join(",")}`);
  await db.exec("ALTER TABLE public.fees ENABLE TRIGGER USER");
});

/** The TypeScript definition, applied to every row (no row cap). */
async function expected(collegeId: string) {
  const rows = await verify<{ amount: string; paid_amount: string; status: (typeof STATUSES)[number]; due_date: string }>(
    db,
    `SELECT amount::text, paid_amount::text, status, to_char(due_date, 'YYYY-MM-DD') AS due_date FROM public.fees WHERE college_id = $1`,
    [collegeId]
  );
  let billed = 0, collected = 0, pending = 0, overdue = 0;
  for (const r of rows) {
    const fee = { amount: Number(r.amount), paid_amount: Number(r.paid_amount), status: r.status, due_date: r.due_date };
    billed += fee.amount;
    collected += fee.paid_amount;
    const effective = computeEffectiveFeeStatus(fee);
    if (effective === "pending") pending += fee.amount - fee.paid_amount;
    if (effective === "overdue") overdue += fee.amount - fee.paid_amount;
  }
  return { billed, collected, pending, overdue, count: rows.length };
}

const asNumbers = (row: Record<string, unknown>) => ({
  billed: Number(row.total_billed),
  collected: Number(row.total_collected),
  pending: Number(row.total_pending),
  overdue: Number(row.total_overdue),
  count: Number(row.fee_count),
});

describe("fee_totals() (057)", () => {
  it("equals computeEffectiveFeeStatus over every row — more rows than PostgREST's default cap", async () => {
    const want = await expected(COLLEGE_A);
    expect(want.count).toBeGreaterThan(1000);
    const r = await as(db, U.finance, `SELECT * FROM public.fee_totals($1)`, [COLLEGE_A]);
    expect(r.ok, r.error ?? "").toBe(true);
    expect(asNumbers(r.data[0])).toEqual(want);
  });

  it("the old way — the first 1,000 rows — gives a different, wrong total", async () => {
    const want = await expected(COLLEGE_A);
    const capped = await verify<{ s: string }>(db, `SELECT sum(amount)::text AS s FROM (SELECT amount FROM public.fees WHERE college_id = $1 LIMIT 1000) x`, [COLLEGE_A]);
    expect(Number(capped[0].s)).toBeLessThan(want.billed);
  });

  it("runs as the caller: RLS decides which fees are summed", async () => {
    // A student sees only their own fees.
    const student = await as(db, U.studentA, `SELECT * FROM public.fee_totals($1)`, [COLLEGE_A]);
    expect(student.ok, student.error ?? "").toBe(true);
    const own = await verify<{ n: string }>(db, `SELECT count(*)::text AS n FROM public.fees WHERE college_id = $1 AND student_id = $2`, [COLLEGE_A, S.a]);
    expect(asNumbers(student.data[0]).count).toBe(Number(own[0].n));
    // Finance of college A asking about college B gets nothing from B.
    const cross = await as(db, U.finance, `SELECT * FROM public.fee_totals($1)`, [COLLEGE_B]);
    expect(cross.ok, cross.error ?? "").toBe(true);
    expect(asNumbers(cross.data[0]).count).toBe(0);
  });

  it("an empty college is all zeros, not nulls", async () => {
    const r = await as(db, U.finance, `SELECT * FROM public.fee_totals($1)`, ["00000000-0000-4000-8000-00000000dead"]);
    expect(asNumbers(r.data[0])).toEqual({ billed: 0, collected: 0, pending: 0, overdue: 0, count: 0 });
  });

  it("is not callable by anonymous clients", async () => {
    await db.exec("SET ROLE anon");
    try {
      await expect(db.query(`SELECT * FROM public.fee_totals($1)`, [COLLEGE_A])).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("RESET ROLE");
    }
  });

  it("today's boundary matches the TypeScript (due today is not overdue)", async () => {
    expect(computeEffectiveFeeStatus({ amount: 10, paid_amount: 0, status: "pending", due_date: today })).toBe("pending");
  });
});
