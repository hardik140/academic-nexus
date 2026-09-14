"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { assertClaimed } from "@/lib/concurrent-claim";
import { PERMISSIONS } from "@/lib/permissions";
import { dbError } from "@/lib/internal-error";

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

  const { data: rejected, error } = await supabase
    .from("refund_requests")
    .update({ status: "rejected", reviewed_by: actor.userId, reviewed_at: new Date().toISOString(), review_notes: reviewNotes })
    .eq("id", requestId)
    .eq("status", "pending")
    .select("id");
  if (error) throw dbError(error);
  assertClaimed(rejected, "refund request");

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

type ApproveRefundRow = {
  fee_id: string;
  payment_id: string;
  refund_amount: number;
  fee_paid_before: number;
  fee_paid_after: number;
  fee_status_before: string;
  fee_status_after: string;
  payment_fully_refunded: boolean;
  student_id: string;
};

/**
 * One call, one transaction: approve_refund() (migration 047 §7o) locks the
 * request and the payment, re-checks the refundable balance against every
 * refund already approved on that payment, reduces fees.paid_amount, marks
 * the payment refunded once its refunds reach its amount, and claims the
 * request — or does none of it.
 *
 * This replaced three separate statements (fee compare-and-swap, payment
 * flag, request claim) whose documented "balance just changed — retry"
 * path let a second approver's retry debit the fee a second time before
 * losing the claim. tests/staging-refund-atomicity.test.ts replays that
 * interleaving against the old sequence and drives the function directly.
 *
 * SECURITY INVOKER: the same RLS that governed the three statements governs
 * the function; requireRole above is the application gate, exactly as before.
 * Audit and notification stay here, after the money has moved, where a
 * failure in either cannot undo a legitimate refund.
 */
export async function approveRefund(requestIdRaw: string) {
  const actor = await requireRole(PERMISSIONS.refund_review);
  const { requestId } = ApproveSchema.parse({ requestId: requestIdRaw });
  await checkRateLimit(`approveRefund:${actor.userId}`, 30, 60);
  const supabase = await createClient();

  // The hand-maintained Database type declares no Functions, so the row
  // shape is stated here; it mirrors the RETURNS TABLE in 047 §7o.
  const { data, error } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>)(
    "approve_refund",
    { p_request_id: requestId }
  );
  if (error) throw dbError(error);
  const result = (data as unknown as ApproveRefundRow[] | null)?.[0];
  if (!result) throw new Error("Refund request not found or already processed.");

  await logAudit(supabase, actor, "refund_approved", "refund_requests", requestId, {
    oldValue: { fee_paid_amount: result.fee_paid_before, fee_status: result.fee_status_before },
    newValue: {
      fee_paid_amount: result.fee_paid_after,
      fee_status: result.fee_status_after,
      refund_amount: result.refund_amount,
      payment_fully_refunded: result.payment_fully_refunded,
    },
  });

  const { data: student } = await supabase
    .from("students")
    .select("user_id")
    .eq("id", result.student_id)
    .single();
  if (student?.user_id) {
    await supabase.from("notifications").insert({
      college_id: actor.collegeId,
      title: "Refund approved",
      message: `Your refund of ${Number(result.refund_amount).toFixed(2)} has been approved and processed.`,
      receiver_id: student.user_id,
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
