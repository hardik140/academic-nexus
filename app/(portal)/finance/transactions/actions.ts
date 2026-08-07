"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type PaymentMethod = Database["public"]["Tables"]["payments"]["Row"]["method"];

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
  const { feeId, amount, method, transactionRef, notes } = params;

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
  if (amount <= 0) {
    throw new Error("Payment amount must be greater than zero.");
  }
  if (amount > outstanding) {
    throw new Error(`Payment amount exceeds the outstanding balance of ${outstanding.toFixed(2)}.`);
  }

  const { error } = await supabase.from("payments").insert({
    college_id: actor.collegeId,
    fee_id: fee.id,
    student_id: fee.student_id,
    amount,
    method,
    transaction_ref: transactionRef || null,
    notes: notes || null,
    status: "cleared",
    processed_by: actor.userId,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function recordPayment(
  feeId: string,
  amount: number,
  method: PaymentMethod,
  transactionRef?: string,
  notes?: string
) {
  const actor = await requireRole(["finance", "admin"]);
  const supabase = await createClient();
  await recordPaymentCore(supabase, actor, { feeId, amount, method, transactionRef, notes });
  revalidatePath("/finance/transactions");
  revalidatePath("/finance/dashboard");
  revalidatePath("/finance/reports");
}

/** Called by app/api/mobile/finance/payment/route.ts. */
export async function recordPaymentViaRequest(request: Request, params: RecordPaymentParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["finance", "admin"]);
  await recordPaymentCore(supabase, actor, params);
}
