"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import type { Database } from "@/types/database";

type PaymentMethod = Database["public"]["Tables"]["payments"]["Row"]["method"];

export async function recordPayment(
  feeId: string,
  amount: number,
  method: PaymentMethod,
  transactionRef?: string,
  notes?: string
) {
  const actor = await requireRole(["finance", "admin"]);
  const supabase = await createClient();

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

  revalidatePath("/finance/transactions");
  revalidatePath("/finance/dashboard");
  revalidatePath("/finance/reports");
}
