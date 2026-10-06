"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCacheFamily, versionedKey } from "@/lib/cache";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import { logAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { feeTotals } from "@/lib/finance/fee-totals";
import { listInvoices } from "../invoices/actions";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { DataTableQuery } from "@/components/ui/data-table";
import { dbError } from "@/lib/internal-error";
import { assertRead } from "@/lib/read-result-server";

const PAYMENTS_PAGE_SIZE = 10;
const PAYMENTS_SORT_COLUMNS = ["amount", "created_at"] as const;
const PAYMENTS_CACHE_PREFIX = "list:payments";
// invoices tab reuses finance/invoices' listInvoices — same table, same
// select, same search field; not worth a second near-identical query.
const FEES_CACHE_PREFIX = "list:fees";
const FEE_STATS_FAMILY = "stats:fees";
const FEES_SORT_COLUMNS = ["type", "amount", "due_date"] as const;

export { listInvoices };

export async function listPayments(q: DataTableQuery) {
  const actor = await requireRole(PERMISSIONS.payment_read);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(PAYMENTS_SORT_COLUMNS, "created_at", false, q);
  const cacheKey = versionedKey(listCacheKey(PAYMENTS_CACHE_PREFIX, actor.collegeId, q, column), PAYMENTS_CACHE_PREFIX, actor.collegeId);

  return getCached(cacheKey, 30, async () => {
    let dbQuery = supabase
      .from("payments")
      .select("*, students(enrollment_number, profiles:user_id(full_name))", { count: "exact" })
      .eq("college_id", actor.collegeId);

    if (q.search) dbQuery = dbQuery.ilike("method", `%${q.search}%`);
    dbQuery = dbQuery.order(column, { ascending });

    const from = q.page * PAYMENTS_PAGE_SIZE;
    const { data, count, error: dataError } = await dbQuery.range(from, from + PAYMENTS_PAGE_SIZE - 1);
    assertRead(dataError);
    return { data: data || [], count: count ?? 0 };
  });
}

/**
 * KPI-card stats over EVERY fee of the college, summed in PostgreSQL
 * (migration 057, lib/finance/fee-totals.ts). This used to select every fee
 * row and sum in JavaScript, which PostgREST's row cap (1,000 by default)
 * silently truncated on a large college. "Pending" and "overdue" follow
 * lib/finance-status.ts computeEffectiveFeeStatus exactly; a parity test
 * (tests/staging-fee-totals.test.ts) holds the two together. Short TTL
 * (30s), invalidated on every payment write: this is money the finance team
 * is actively reconciling.
 */
export async function getFeeStats() {
  const actor = await requireRole(PERMISSIONS.payment_read);
  const supabase = await createClient();

  return getCached(versionedKey(`stats:fees:${actor.collegeId}`, FEE_STATS_FAMILY, actor.collegeId), 30, async () => {
    const t = await feeTotals(supabase, actor.collegeId);
    return { total: t.billed, collected: t.collected, pending: t.pending, overdue: t.overdue };
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

  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string,
    params: Record<string, unknown>
  ) => PromiseLike<{
    data: Array<{ payment_id: string; fee_id: string; amount: number }> | null;
    error: { message: string; code?: string } | null;
  }>;
  const { data, error } = await rpc("record_payment", {
    p_fee_id: feeId,
    p_amount: amount,
    p_method: method,
    p_transaction_ref: transactionRef || null,
    p_notes: notes || null,
  });
  const payment = data?.[0];

  if (error || !payment) {
    throw dbError(error ?? { message: "Failed to record payment." });
  }

  await logAudit(supabase, actor, "payment_recorded", "payments", payment.payment_id, {
    newValue: { fee_id: payment.fee_id, amount, method },
  });
}

export async function recordPayment(
  feeId: string,
  amount: number,
  method: PaymentMethod,
  transactionRef?: string,
  notes?: string) {
  const actor = await requireRole(PERMISSIONS.payment_record);
  const supabase = await createClient();
  await recordPaymentCore(supabase, actor, { feeId, amount, method, transactionRef, notes });
  revalidatePath("/finance/transactions");
  revalidatePath("/finance/dashboard");
  revalidatePath("/finance/reports");

  // A payment touches all three cached reads on this page: the fee's own
  // row (status/paid_amount), a new payments row, and the KPI sums.
  await invalidateCacheFamily(FEE_STATS_FAMILY, actor.collegeId);
  await invalidateCacheFamily(FEES_CACHE_PREFIX, actor.collegeId);
  await invalidateCacheFamily(PAYMENTS_CACHE_PREFIX, actor.collegeId);
}

/** Called by app/api/mobile/finance/payment/route.ts. */
export async function recordPaymentViaRequest(request: Request, params: RecordPaymentParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, PERMISSIONS.payment_record);
  await recordPaymentCore(supabase, actor, params);
}
