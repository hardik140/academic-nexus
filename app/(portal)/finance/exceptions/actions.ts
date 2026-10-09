"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCached } from "@/lib/cache";
import { PERMISSIONS } from "@/lib/permissions";
import { businessRpc, num } from "@/lib/business-rpc";

export interface ExceptionEntry {
  id: string;
  studentName: string;
  enrollmentNumber: string;
  amount: number;
  detail: string;
}

export type ExceptionCategory =
  | "overdueFees"
  | "duplicatePayments"
  | "overpayments"
  | "refundsAwaitingApproval"
  | "disputesNeedingAttention";

export type FinanceExceptions = Record<ExceptionCategory, ExceptionEntry[]> & {
  /** How many there are in all, per category; each list holds at most EXCEPTION_LIST_LIMIT. */
  totals: Record<ExceptionCategory, number>;
};

/** Entries listed per category. The totals are always complete. */
const EXCEPTION_LIST_LIMIT = 200;

const CATEGORIES: ExceptionCategory[] = ["overdueFees", "duplicatePayments", "overpayments", "refundsAwaitingApproval", "disputesNeedingAttention"];

/**
 * Finance Exception Center — computed live from real data only, cached 30s
 * (money being actively managed, same short TTL rationale as
 * transactions/actions.ts's getFeeStats). Deliberately does NOT include a
 * "stuck/unreconciled payment" category: recordPaymentCore hardcodes every
 * insert to status 'cleared', so nothing anywhere ever produces a
 * pending/failed payment row — that check would always read zero, the same
 * dead-code mistake this module fixes for `overdue` (see
 * lib/finance-status.ts).
 */
export async function getFinanceExceptions(): Promise<FinanceExceptions> {
  const actor = await requireRole(PERMISSIONS.finance_exceptions_read);
  const supabase = await createClient();

  return getCached(`finance:exceptions:${actor.collegeId}`, 30, async () => {
    // Computed in PostgreSQL (migration 059, finance_exceptions) over EVERY
    // fee and payment of the college. This used to read every fee and every
    // payment row — each capped at PostgREST's 1,000 rows — and find
    // overdue fees, duplicate payments and overpayments here, so past the
    // cap they were silently missed (a duplicate whose second payment was
    // row 1,001 was invisible). Same rules: lib/finance-status.ts's
    // effective status and detectDuplicatePaymentRisk, in SQL (parity-tested).
    const rows = await businessRpc<{
      category: ExceptionCategory;
      item_id: string;
      student_name: string;
      enrollment_number: string;
      amount: number | string;
      detail: string;
      category_total: number | string;
    }>(supabase, "finance_exceptions", { p_college_id: actor.collegeId, p_limit: EXCEPTION_LIST_LIMIT });

    const result = Object.fromEntries(CATEGORIES.map((c) => [c, [] as ExceptionEntry[]])) as Record<ExceptionCategory, ExceptionEntry[]>;
    const totals = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<ExceptionCategory, number>;
    for (const r of rows) {
      if (!(r.category in result)) continue;
      result[r.category].push({
        id: r.item_id,
        studentName: r.student_name,
        enrollmentNumber: r.enrollment_number,
        amount: num(r.amount),
        detail: r.detail,
      });
      totals[r.category] = num(r.category_total);
    }
    return { ...result, totals };
  });
}
