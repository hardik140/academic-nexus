import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { assertRead } from "@/lib/read-result-server";
import { isMissingFunction } from "@/lib/college-access";
import { computeEffectiveFeeStatus } from "@/lib/finance-status";

/**
 * A college's fee totals, summed in PostgreSQL (migration 057, fee_totals()).
 *
 * Replaces "select every fee row, sum in JavaScript", which PostgREST's
 * row cap (1,000 by default) silently truncated. RLS still decides which
 * fees count: the function runs as the caller.
 *
 * DEPLOY ORDER. Until 057 is applied to a database, the function does not
 * exist there; the previous computation is used instead (with its row cap)
 * and a warning is logged, so deploying the code first cannot break the
 * finance pages. Apply 057, and the warning stops.
 */
export interface FeeTotals {
  billed: number;
  collected: number;
  pending: number;
  overdue: number;
  feeCount: number;
}

interface FeeTotalsRow {
  total_billed: number | string | null;
  total_collected: number | string | null;
  total_pending: number | string | null;
  total_overdue: number | string | null;
  fee_count: number | string | null;
}

let warnedMissing = false;

export async function feeTotals(supabase: SupabaseClient<Database>, collegeId: string): Promise<FeeTotals> {
  // Database["public"]["Functions"] is not modelled in the hand-written types.
  // Bound: SupabaseClient.rpc uses `this`; a detached reference throws on every call.
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string,
    params: Record<string, unknown>
  ) => PromiseLike<{ data: FeeTotalsRow[] | null; error: { message: string; code?: string } | null }>;
  const { data, error } = await rpc("fee_totals", { p_college_id: collegeId });
  if (isMissingFunction(error)) return legacyTotals(supabase, collegeId);
  assertRead(error);
  const row = data?.[0];
  const n = (v: number | string | null | undefined) => Number(v ?? 0) || 0;
  return {
    billed: n(row?.total_billed),
    collected: n(row?.total_collected),
    pending: n(row?.total_pending),
    overdue: n(row?.total_overdue),
    feeCount: n(row?.fee_count),
  };
}

/** The pre-057 computation, kept only for a database 057 has not reached yet. */
async function legacyTotals(supabase: SupabaseClient<Database>, collegeId: string): Promise<FeeTotals> {
  if (!warnedMissing) {
    warnedMissing = true;
    console.warn({ event: "finance.fee_totals", outcome: "function_missing", note: "migration 057 not applied; totals are capped at PostgREST max_rows" });
  }
  const { data, error } = await supabase.from("fees").select("amount, paid_amount, status, due_date").eq("college_id", collegeId);
  assertRead(error);
  const totals: FeeTotals = { billed: 0, collected: 0, pending: 0, overdue: 0, feeCount: 0 };
  for (const f of data ?? []) {
    totals.billed += f.amount || 0;
    totals.collected += f.paid_amount || 0;
    totals.feeCount += 1;
    const effective = computeEffectiveFeeStatus(f);
    if (effective === "pending") totals.pending += f.amount - f.paid_amount;
    if (effective === "overdue") totals.overdue += f.amount - f.paid_amount;
  }
  return totals;
}
