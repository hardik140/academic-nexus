"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { PERMISSIONS } from "@/lib/permissions";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { dbError } from "@/lib/internal-error";
import { assertRead } from "@/lib/read-result-server";

async function resolveStudentId(supabase: SupabaseClient<Database>, actor: AuthorizedActor): Promise<string> {
  const { data: student, error: studentError } = await supabase.from("students").select("id").eq("user_id", actor.userId).single();
  assertRead(studentError);
  if (!student) throw new Error("No student record found for this account.");
  return student.id;
}

// ─── Refund Requests ──────────────────────────────────────────────

const RequestRefundSchema = z.object({
  paymentId: z.string().guid(),
  amount: z.number().positive({ message: "Refund amount must be greater than zero." }),
  reason: z.string().trim().min(1).max(1000),
});

export async function requestRefund(paymentIdRaw: string, amountRaw: number, reasonRaw: string) {
  const actor = await requireRole(PERMISSIONS.refund_request);
  const { paymentId, amount, reason } = RequestRefundSchema.parse({ paymentId: paymentIdRaw, amount: amountRaw, reason: reasonRaw });
  await checkRateLimit(`requestRefund:${actor.userId}`, 10, 3600);
  const supabase = await createClient();
  const studentId = await resolveStudentId(supabase, actor);

  const { data: payment } = await supabase
    .from("payments")
    .select("id, student_id, amount, status, college_id")
    .eq("id", paymentId)
    .single();
  if (!payment || payment.student_id !== studentId || payment.college_id !== actor.collegeId) {
    throw new Error("Payment not found.");
  }
  if (payment.status !== "cleared") {
    throw new Error("Only a cleared payment can be refunded.");
  }

  const { data: existingPending } = await supabase
    .from("refund_requests")
    .select("id")
    .eq("payment_id", paymentId)
    .eq("status", "pending")
    .maybeSingle();
  if (existingPending) {
    throw new Error("You already have a pending refund request for this payment.");
  }

  const { data: approvedRefunds } = await supabase
    .from("refund_requests")
    .select("amount")
    .eq("payment_id", paymentId)
    .eq("status", "approved");
  const alreadyRefunded = (approvedRefunds || []).reduce((s, r) => s + r.amount, 0);
  const refundable = payment.amount - alreadyRefunded;
  if (amount > refundable) {
    throw new Error(`Refund amount exceeds the refundable balance of ${refundable.toFixed(2)}.`);
  }

  const { error } = await supabase.from("refund_requests").insert({
    college_id: actor.collegeId,
    student_id: studentId,
    payment_id: paymentId,
    amount,
    reason,
  });
  if (error) throw dbError(error);

  revalidatePath("/student/fees");
}

export async function listMyRefundRequests() {
  const actor = await requireRole(PERMISSIONS.refund_request);
  const supabase = await createClient();
  const studentId = await resolveStudentId(supabase, actor);

  const { data, error: dataError } = await supabase
    .from("refund_requests")
    .select("*, payments:payment_id(amount, method, created_at)")
    .eq("student_id", studentId)
    .order("created_at", { ascending: false });
  assertRead(dataError);
  return data || [];
}

// ─── Financial Disputes ───────────────────────────────────────────

const SubmitDisputeSchema = z.object({
  feeId: z.string().guid().nullable(),
  paymentId: z.string().guid().nullable(),
  description: z.string().trim().min(1).max(1000),
});

export async function submitDispute(feeIdRaw: string | null, paymentIdRaw: string | null, descriptionRaw: string) {
  const actor = await requireRole(PERMISSIONS.dispute_submit);
  const { feeId, paymentId, description } = SubmitDisputeSchema.parse({
    feeId: feeIdRaw || null,
    paymentId: paymentIdRaw || null,
    description: descriptionRaw,
  });
  await checkRateLimit(`submitDispute:${actor.userId}`, 10, 3600);
  const supabase = await createClient();
  const studentId = await resolveStudentId(supabase, actor);

  if (feeId) {
    const { data: fee } = await supabase.from("fees").select("id, student_id").eq("id", feeId).single();
    if (!fee || fee.student_id !== studentId) throw new Error("Fee not found.");
  }
  if (paymentId) {
    const { data: payment } = await supabase.from("payments").select("id, student_id").eq("id", paymentId).single();
    if (!payment || payment.student_id !== studentId) throw new Error("Payment not found.");
  }

  const { error } = await supabase.from("financial_disputes").insert({
    college_id: actor.collegeId,
    student_id: studentId,
    fee_id: feeId,
    payment_id: paymentId,
    description,
  });
  if (error) throw dbError(error);

  revalidatePath("/student/fees");
}

export async function listMyDisputes() {
  const actor = await requireRole(PERMISSIONS.dispute_submit);
  const supabase = await createClient();
  const studentId = await resolveStudentId(supabase, actor);

  const { data, error: dataError } = await supabase
    .from("financial_disputes")
    .select("*")
    .eq("student_id", studentId)
    .order("created_at", { ascending: false });
  assertRead(dataError);
  return data || [];
}
