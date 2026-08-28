"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import { logAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { computeEffectiveFeeStatus } from "@/lib/finance-status";
import { listInvoices } from "../invoices/actions";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { DataTableQuery } from "@/components/ui/data-table";

const PAYMENTS_PAGE_SIZE = 10;
const PAYMENTS_SORT_COLUMNS = ["amount", "created_at"] as const;
const PAYMENTS_CACHE_PREFIX = "list:payments";
// invoices tab reuses finance/invoices' listInvoices — same table, same
// select, same search field; not worth a second near-identical query.
const FEES_CACHE_PREFIX = "list:fees";
const FEES_SORT_COLUMNS = ["type", "amount", "due_date"] as const;

export { listInvoices };

export async function listPayments(q: DataTableQuery) {
  const actor = await requireRole(PERMISSIONS.payment_read);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(PAYMENTS_SORT_COLUMNS, "created_at", false, q);
  const cacheKey = listCacheKey(PAYMENTS_CACHE_PREFIX, actor.collegeId, q, column);

  return getCached(cacheKey, 30, async () => {
    let dbQuery = supabase
      .from("payments")
      .select("*, students(enrollment_number, profiles:user_id(full_name))", { count: "exact" })
      .eq("college_id", actor.collegeId);

    if (q.search) dbQuery = dbQuery.ilike("method", `%${q.search}%`);
    dbQuery = dbQuery.order(column, { ascending });

    const from = q.page * PAYMENTS_PAGE_SIZE;
    const { data, count } = await dbQuery.range(from, from + PAYMENTS_PAGE_SIZE - 1);
    return { data: data || [], count: count ?? 0 };
  });
}

/**
 * KPI-card stats — still unbounded (sums over the *entire* fees table, not
 * one page of it, so .range() doesn't apply the way it does above), but now
 * at least cached rather than re-summed on every load. Short TTL (30s):
 * this is money the finance team is actively reconciling, unlike the
 * dashboards' 60s stat counts. The real fix — extending mv_fee_summary
 * (migration 007) with a "pending" aggregate so this becomes an indexed
 * materialized-view read instead of a live SUM — is a schema change, a
 * different and larger scope than caching the existing query.
 */
export async function getFeeStats() {
  const actor = await requireRole(PERMISSIONS.payment_read);
  const supabase = await createClient();

  return getCached(`stats:fees:${actor.collegeId}`, 30, async () => {
    const { data } = await supabase.from("fees").select("amount, paid_amount, status, due_date").eq("college_id", actor.collegeId);
    const f = data || [];
    // "overdue" is computed live (computeEffectiveFeeStatus), not the stored
    // status column — nothing anywhere ever sets fees.status = 'overdue'
    // (no cron, no trigger), so a raw status === "overdue" filter here
    // always read zero. See lib/finance-status.ts.
    const withEffectiveStatus = f.map((i) => ({ ...i, effectiveStatus: computeEffectiveFeeStatus(i) }));
    return {
      total: f.reduce((s, i) => s + (i.amount || 0), 0),
      collected: f.reduce((s, i) => s + (i.paid_amount || 0), 0),
      pending: withEffectiveStatus.filter((i) => i.effectiveStatus === "pending").reduce((s, i) => s + (i.amount - i.paid_amount), 0),
      overdue: withEffectiveStatus.filter((i) => i.effectiveStatus === "overdue").reduce((s, i) => s + (i.amount - i.paid_amount), 0),
    };
  });
}

type PaymentMethod = Database["public"]["Tables"]["payments"]["Row"]["method"];

const PAYMENT_METHODS = [
  "cash", "card", "upi", "netbanking", "cheque", "dd", "scholarship", "other",
] as const;

const RecordPaymentSchema = z.object({
  feeId: z.string().guid(),
  amount: z.number().positive({ message: "Payment amount must be greater than zero." }),
  method: z.enum(PAYMENT_METHODS),
  transactionRef: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export interface RecordPaymentParams {
  feeId: string;
  amount: number;
  method: PaymentMethod;
  transactionRef?: string;
  notes?: string;
}

/**
 * Shared by the web Server Action below and app/api/mobile/finance/payment's
 * Route Handler — same guarded logic either way, just a different transport.
 */
export async function recordPaymentCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: RecordPaymentParams
) {
  const { feeId, amount, method, transactionRef, notes } = RecordPaymentSchema.parse(params);
  await checkRateLimit(`recordPayment:${actor.userId}`, 15, 60);

  const { data: fee, error: feeError } = await supabase
    .from("fees")
    .select("id, college_id, student_id, amount, paid_amount")
    .eq("id", feeId)
    .single();

  if (feeError || !fee) {
    throw new Error("Invoice not found.");
  }
  if (fee.college_id !== actor.collegeId) {
    throw new Error("Invoice not found in your college.");
  }

  const outstanding = fee.amount - fee.paid_amount;
  if (amount > outstanding) {
    throw new Error(`Payment amount exceeds the outstanding balance of ${outstanding.toFixed(2)}.`);
  }

  const { data: payment, error } = await supabase
    .from("payments")
    .insert({
      college_id: actor.collegeId,
      fee_id: fee.id,
      student_id: fee.student_id,
      amount,
      method,
      transaction_ref: transactionRef || null,
      notes: notes || null,
      status: "cleared",
      processed_by: actor.userId,
    })
    .select("id")
    .single();

  if (error || !payment) {
    throw new Error(error?.message || "Failed to record payment.");
  }

  await logAudit(supabase, actor, "payment_recorded", "payments", payment.id, {
    newValue: { fee_id: fee.id, amount, method },
  });
}

export async function recordPayment(
  feeId: string,
  amount: number,
  method: PaymentMethod,
  transactionRef?: string,
  notes?: string,
  feesViewQuery?: DataTableQuery,
  paymentsViewQuery?: DataTableQuery
) {
  const actor = await requireRole(PERMISSIONS.payment_record);
  const supabase = await createClient();
  await recordPaymentCore(supabase, actor, { feeId, amount, method, transactionRef, notes });
  revalidatePath("/finance/transactions");
  revalidatePath("/finance/dashboard");
  revalidatePath("/finance/reports");

  // A payment touches all three cached reads on this page: the fee's own
  // row (status/paid_amount), a new payments row, and the KPI sums.
  await invalidateCache(`stats:fees:${actor.collegeId}`);
  if (feesViewQuery) {
    const { column } = resolveListSort(FEES_SORT_COLUMNS, "due_date", false, feesViewQuery);
    await invalidateCache(listCacheKey(FEES_CACHE_PREFIX, actor.collegeId, feesViewQuery, column));
  }
  if (paymentsViewQuery) {
    const { column } = resolveListSort(PAYMENTS_SORT_COLUMNS, "created_at", false, paymentsViewQuery);
    await invalidateCache(listCacheKey(PAYMENTS_CACHE_PREFIX, actor.collegeId, paymentsViewQuery, column));
  }
}

/** Called by app/api/mobile/finance/payment/route.ts. */
export async function recordPaymentViaRequest(request: Request, params: RecordPaymentParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, PERMISSIONS.payment_record);
  await recordPaymentCore(supabase, actor, params);
}
