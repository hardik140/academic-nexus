"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";

function refundsCacheKey(collegeId: string) {
  return `finance-refunds:${collegeId}`;
}

const SELECT_COLS =
  "*, students:student_id(enrollment_number, profiles:user_id(id, full_name)), payments:payment_id(amount, method, transaction_ref, created_at)";

export async function listRefundRequests() {
  const actor = await requireRole(PERMISSIONS.refund_review);
  const supabase = await createClient();

  return getCached(refundsCacheKey(actor.collegeId), 30, async () => {
    const baseQuery = () => supabase.from("refund_requests").select(SELECT_COLS).eq("college_id", actor.collegeId);
    const [pendingRes, processedRes] = await Promise.all([
      baseQuery().eq("status", "pending").order("created_at", { ascending: false }),
      baseQuery().neq("status", "pending").order("created_at", { ascending: false }).limit(20),
    ]);
    return { pending: pendingRes.data || [], processed: processedRes.data || [] };
  });
}

const RejectSchema = z.object({
  requestId: z.string().guid(),
  reviewNotes: z.string().trim().min(1).max(1000),
});

export async function rejectRefund(requestIdRaw: string, reviewNotesRaw: string) {
  const actor = await requireRole(PERMISSIONS.refund_review);
  const { requestId, reviewNotes } = RejectSchema.parse({ requestId: requestIdRaw, reviewNotes: reviewNotesRaw });
  await checkRateLimit(`rejectRefund:${actor.userId}`, 30, 60);
  const supabase = await createClient();

  const { data: request } = await supabase
    .from("refund_requests")
    .select("status, students:student_id(profiles:user_id(id))")
    .eq("id", requestId)
    .eq("college_id", actor.collegeId)
    .single();
  const req = request as unknown as { status: string; students: { profiles: { id: string } | null } | null } | null;
  if (!req || req.status !== "pending") {
    throw new Error("Refund request not found or already processed.");
  }

  const { error } = await supabase
    .from("refund_requests")
    .update({ status: "rejected", reviewed_by: actor.userId, reviewed_at: new Date().toISOString(), review_notes: reviewNotes })
    .eq("id", requestId);
  if (error) throw new Error(error.message);

  await logAudit(supabase, actor, "refund_rejected", "refund_requests", requestId, {
    oldValue: { status: "pending" },
    newValue: { status: "rejected", review_notes: reviewNotes },
  });

  const studentUserId = req.students?.profiles?.id;
  if (studentUserId) {
    await supabase.from("notifications").insert({
      college_id: actor.collegeId,
      title: "Refund request rejected",
      message: reviewNotes,
      receiver_id: studentUserId,
      sender_id: actor.userId,
      type: "error",
      link: "/student/fees",
    });
  }

  await invalidateCache(refundsCacheKey(actor.collegeId));
  revalidatePath("/finance/refunds");
  revalidatePath("/finance/dashboard");
}

const ApproveSchema = z.object({ requestId: z.string().guid() });

/**
 * Deliberately does NOT insert a negative-amount row into `payments` to let
 * update_fee_on_payment() (migration 003) do the arithmetic — that trigger's
 * status branch leaves a fully-zeroed fee's status incorrectly as 'paid'
 * (see migration 041's header comment). Instead this directly and safely
 * adjusts fees.paid_amount/status via a concurrency-safe compare-and-swap
 * (same optimistic-locking shape as the Warden increment's room-occupancy
 * check), and the refund_requests row itself is the reversal ledger.
 */
export async function approveRefund(requestIdRaw: string) {
  const actor = await requireRole(PERMISSIONS.refund_review);
  const { requestId } = ApproveSchema.parse({ requestId: requestIdRaw });
  await checkRateLimit(`approveRefund:${actor.userId}`, 30, 60);
  const supabase = await createClient();

  const { data: request } = await supabase
    .from("refund_requests")
    .select("status, amount, payment_id, students:student_id(profiles:user_id(id))")
    .eq("id", requestId)
    .eq("college_id", actor.collegeId)
    .single();
  const req = request as unknown as {
    status: string;
    amount: number;
    payment_id: string;
    students: { profiles: { id: string } | null } | null;
  } | null;
  if (!req || req.status !== "pending") {
    throw new Error("Refund request not found or already processed.");
  }

  const { data: payment } = await supabase
    .from("payments")
    .select("id, fee_id, amount, status")
    .eq("id", req.payment_id)
    .single();
  if (!payment) {
    throw new Error("Original payment not found.");
  }

  // Re-validate refundable amount — another refund could have been approved
  // against the same payment since this request was submitted.
  const { data: approvedRefunds } = await supabase
    .from("refund_requests")
    .select("amount")
    .eq("payment_id", req.payment_id)
    .eq("status", "approved");
  const alreadyRefunded = (approvedRefunds || []).reduce((s, r) => s + r.amount, 0);
  const refundable = payment.amount - alreadyRefunded;
  if (req.amount > refundable) {
    throw new Error(`This refund (${req.amount.toFixed(2)}) now exceeds the refundable balance of ${refundable.toFixed(2)}.`);
  }

  const { data: fee } = await supabase.from("fees").select("id, amount, paid_amount, status").eq("id", payment.fee_id).single();
  if (!fee) {
    throw new Error("Original fee not found.");
  }

  const newPaidAmount = Math.max(fee.paid_amount - req.amount, 0);
  const newStatus = newPaidAmount <= 0 ? "refunded" : newPaidAmount < fee.amount ? "partial" : fee.status;

  // Concurrency-safe compare-and-swap on the exact paid_amount just read —
  // if a concurrent payment/refund raced it, zero rows match and .select()
  // returns nothing, caught below instead of silently corrupting the
  // balance (same pattern as the Warden increment's room-occupancy check).
  const { data: casResult, error: casError } = await supabase
    .from("fees")
    .update({ paid_amount: newPaidAmount, status: newStatus })
    .eq("id", fee.id)
    .eq("paid_amount", fee.paid_amount)
    .select("id");
  if (casError) throw new Error(casError.message);
  if (!casResult || casResult.length === 0) {
    throw new Error("This fee's balance just changed — please retry the refund.");
  }

  // If the refunded amount now fully covers the original payment, mark that
  // payment itself as refunded (a queryable, real signal — not the same
  // thing as the fee's own status, since a fee can have multiple payments).
  if (alreadyRefunded + req.amount >= payment.amount) {
    await supabase.from("payments").update({ status: "refunded" }).eq("id", payment.id);
  }

  const { error: updateRequestError } = await supabase
    .from("refund_requests")
    .update({ status: "approved", reviewed_by: actor.userId, reviewed_at: new Date().toISOString() })
    .eq("id", requestId);
  if (updateRequestError) throw new Error(updateRequestError.message);

  await logAudit(supabase, actor, "refund_approved", "refund_requests", requestId, {
    oldValue: { fee_paid_amount: fee.paid_amount, fee_status: fee.status },
    newValue: { fee_paid_amount: newPaidAmount, fee_status: newStatus, refund_amount: req.amount },
  });

  const studentUserId = req.students?.profiles?.id;
  if (studentUserId) {
    await supabase.from("notifications").insert({
      college_id: actor.collegeId,
      title: "Refund approved",
      message: `Your refund of ${req.amount.toFixed(2)} has been approved and processed.`,
      receiver_id: studentUserId,
      sender_id: actor.userId,
      type: "success",
      link: "/student/fees",
    });
  }

  await invalidateCache(refundsCacheKey(actor.collegeId));
  revalidatePath("/finance/refunds");
  revalidatePath("/finance/dashboard");
  revalidatePath("/finance/transactions");
}
