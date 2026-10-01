"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { assertClaimed } from "@/lib/concurrent-claim";
import { PERMISSIONS } from "@/lib/permissions";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { dbError } from "@/lib/internal-error";
import { assertRead } from "@/lib/read-result-server";

function disputesCacheKey(collegeId: string) {
  return `finance-disputes:${collegeId}`;
}

const SELECT_COLS =
  "*, students:student_id(enrollment_number, profiles:user_id(id, full_name)), fees:fee_id(type, amount, due_date), payments:payment_id(amount, method, created_at)";

export async function listFinancialDisputes() {
  const actor = await requireRole(PERMISSIONS.dispute_manage);
  const supabase = await createClient();

  return getCached(disputesCacheKey(actor.collegeId), 30, async () => {
    const { data, error: dataError } = await supabase
      .from("financial_disputes")
      .select(SELECT_COLS)
      .eq("college_id", actor.collegeId)
      .order("created_at", { ascending: false });
    assertRead(dataError);
    return data || [];
  });
}

async function loadDispute(supabase: SupabaseClient<Database>, actor: AuthorizedActor, disputeId: string) {
  const { data } = await supabase
    .from("financial_disputes")
    .select("status, students:student_id(profiles:user_id(id))")
    .eq("id", disputeId)
    .eq("college_id", actor.collegeId)
    .single();
  return data as unknown as { status: string; students: { profiles: { id: string } | null } | null } | null;
}

const IdSchema = z.object({ disputeId: z.string().guid() });

/** submitted -> under_investigation, self-assigned — any finance user can pick up a ticket. */
export async function claimDispute(disputeIdRaw: string) {
  const actor = await requireRole(PERMISSIONS.dispute_manage);
  const { disputeId } = IdSchema.parse({ disputeId: disputeIdRaw });
  const supabase = await createClient();

  const dispute = await loadDispute(supabase, actor, disputeId);
  if (!dispute || dispute.status !== "submitted") {
    throw new Error("Dispute not found or already claimed.");
  }

  const { data: claimedRows, error } = await supabase
    .from("financial_disputes")
    .update({ status: "under_investigation", assigned_to: actor.userId })
    .eq("id", disputeId)
    .eq("status", "submitted")
    .select("id");
  if (error) throw dbError(error);
  assertClaimed(claimedRows, "dispute");

  await logAudit(supabase, actor, "dispute_claimed", "financial_disputes", disputeId, {
    oldValue: { status: "submitted" },
    newValue: { status: "under_investigation", assigned_to: actor.userId },
  });

  await invalidateCache(disputesCacheKey(actor.collegeId));
  revalidatePath("/finance/disputes");
}

const ResolveSchema = z.object({
  disputeId: z.string().guid(),
  resolutionNotes: z.string().trim().min(1).max(2000),
});

async function finalizeDispute(status: "resolved" | "rejected", disputeIdRaw: string, resolutionNotesRaw: string) {
  const actor = await requireRole(PERMISSIONS.dispute_manage);
  const { disputeId, resolutionNotes } = ResolveSchema.parse({ disputeId: disputeIdRaw, resolutionNotes: resolutionNotesRaw });
  await checkRateLimit(`finalizeDispute:${actor.userId}`, 30, 60);
  const supabase = await createClient();

  const dispute = await loadDispute(supabase, actor, disputeId);
  if (!dispute || (dispute.status !== "submitted" && dispute.status !== "under_investigation")) {
    throw new Error("Dispute not found or already finalized.");
  }

  const { data: resolvedRows, error } = await supabase
    .from("financial_disputes")
    .update({ status, resolved_by: actor.userId, resolved_at: new Date().toISOString(), resolution_notes: resolutionNotes })
    .eq("id", disputeId)
    .eq("status", dispute.status)
    .select("id");
  if (error) throw dbError(error);
  assertClaimed(resolvedRows, "dispute");

  await logAudit(supabase, actor, `dispute_${status}`, "financial_disputes", disputeId, {
    oldValue: { status: dispute.status },
    newValue: { status, resolution_notes: resolutionNotes },
  });

  const studentUserId = dispute.students?.profiles?.id;
  if (studentUserId) {
    await supabase.from("notifications").insert({
      college_id: actor.collegeId,
      title: status === "resolved" ? "Your dispute has been resolved" : "Your dispute was not upheld",
      message: resolutionNotes,
      receiver_id: studentUserId,
      sender_id: actor.userId,
      type: status === "resolved" ? "success" : "info",
      link: "/student/fees",
    });
  }

  await invalidateCache(disputesCacheKey(actor.collegeId));
  revalidatePath("/finance/disputes");
  revalidatePath("/finance/dashboard");
}

/**
 * Resolution is notes-only — it does not mutate payments/fees directly. If
 * a resolution requires a corrective payment, Finance records it through
 * the existing recordPayment action, not a second write path into the same
 * tables.
 */
export async function resolveDispute(disputeId: string, resolutionNotes: string) {
  await finalizeDispute("resolved", disputeId, resolutionNotes);
}

export async function rejectDispute(disputeId: string, resolutionNotes: string) {
  await finalizeDispute("rejected", disputeId, resolutionNotes);
}
