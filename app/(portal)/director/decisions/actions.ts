"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { assertClaimed } from "@/lib/concurrent-claim";
import { assertNotSelfApproval } from "@/lib/segregation-of-duties";
import { PERMISSIONS } from "@/lib/permissions";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { dbError } from "@/lib/internal-error";
import { assertRead } from "@/lib/read-result-server";

const DECISION_CATEGORIES = [
  "department_change",
  "hod_assignment",
  "financial_exception",
  "policy_exception",
  "placement_drive_approval",
  "scholarship_exception",
  "risk_escalation_decision",
  "other",
] as const;

const SubmitDecisionSchema = z.object({
  category: z.enum(DECISION_CATEGORIES),
  title: z.string().trim().min(1, { message: "Title is required." }).max(200),
  description: z.string().trim().min(1, { message: "Description is required." }).max(4000),
  urgency: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  financialImpact: z.number().nonnegative().nullable().optional(),
  studentImpactCount: z.number().int().nonnegative().nullable().optional(),
  institutionalImpactSummary: z.string().trim().max(2000).nullable().optional(),
  recommendation: z.string().trim().max(2000).nullable().optional(),
  deadline: z.string().nullable().optional(),
});

export type SubmitDecisionParams = z.infer<typeof SubmitDecisionSchema>;

function decisionsCacheKey(collegeId: string) {
  return `decisions:${collegeId}`;
}

/**
 * Requester is always hod/warden/placement_cell (decision_submit) — a
 * requesting HOD's department is resolved via departments.hod_id, same as
 * hod/approvals, not profiles.department_id (assigning HOD doesn't set that).
 */
export async function submitDecisionCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: SubmitDecisionParams
) {
  const parsed = SubmitDecisionSchema.parse(params);

  let departmentId: string | null = null;
  if (actor.role === "hod") {
    const { data: department } = await supabase
      .from("departments")
      .select("id")
      .eq("hod_id", actor.userId)
      .single();
    departmentId = department?.id ?? null;
  }

  const { data, error } = await supabase
    .from("decisions")
    .insert({
      college_id: actor.collegeId,
      category: parsed.category,
      title: parsed.title,
      description: parsed.description,
      requested_by: actor.userId,
      department_id: departmentId,
      urgency: parsed.urgency,
      financial_impact: parsed.financialImpact ?? null,
      student_impact_count: parsed.studentImpactCount ?? null,
      institutional_impact_summary: parsed.institutionalImpactSummary ?? null,
      recommendation: parsed.recommendation ?? null,
      deadline: parsed.deadline ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw dbError({ ...error, message: error?.message || "Failed to submit decision." });
  }

  // Decisions have no single owner — notify every Director in the college.
  const { data: directors } = await supabase
    .from("profiles")
    .select("id")
    .eq("college_id", actor.collegeId)
    .eq("role", "director");

  if (directors && directors.length > 0) {
    await supabase.from("notifications").insert(
      directors.map((d) => ({
        college_id: actor.collegeId,
        title: "New decision required",
        message: `${parsed.title} (${parsed.urgency} urgency)`,
        receiver_id: d.id,
        sender_id: actor.userId,
        type: "action_required" as const,
        link: `/director/decisions/${data.id}`,
      }))
    );
  }

  await logAudit(supabase, actor, "decision_submitted", "decisions", data.id, {
    newValue: { status: "pending", category: parsed.category, urgency: parsed.urgency },
  });

  return { id: data.id as string };
}

export async function submitDecision(params: SubmitDecisionParams) {
  const actor = await requireRole(PERMISSIONS.decision_submit);
  await checkRateLimit(`submitDecision:${actor.userId}`, 10, 3600);
  const supabase = await createClient();
  const result = await submitDecisionCore(supabase, actor, params);
  await invalidateCache(decisionsCacheKey(actor.collegeId));
  revalidatePath("/director/decisions");
  return result;
}

/**
 * Institution-wide, not department-scoped (unlike hod/approvals) — Director
 * decides for the whole college, so this returns {pending, processed}
 * together in one cache entry, same "simpler than coordinating two caches"
 * call as director/faculty and hod/approvals.
 */
export async function listDecisions() {
  const actor = await requireRole(["director"]);
  const supabase = await createClient();

  return getCached(decisionsCacheKey(actor.collegeId), 30, async () => {
    const baseQuery = () =>
      supabase
        .from("decisions")
        .select("*, requester:requested_by(full_name, email, role), department:department_id(name, code)")
        .eq("college_id", actor.collegeId);

    const [pendingRes, processedRes] = await Promise.all([
      baseQuery().eq("status", "pending").order("created_at", { ascending: false }),
      baseQuery().neq("status", "pending").order("updated_at", { ascending: false }).limit(30),
    ]);
    assertRead(pendingRes.error);
    assertRead(processedRes.error);
    return { pending: pendingRes.data || [], processed: processedRes.data || [] };
  });
}

export async function getDecision(decisionId: string) {
  const actor = await requireRole(["director"]);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("decisions")
    .select(
      "*, requester:requested_by(full_name, email, role), department:department_id(name, code), decider:decided_by(full_name), delegate:delegated_to(full_name, role)"
    )
    .eq("id", decisionId)
    .eq("college_id", actor.collegeId)
    .single();
  if (error || !data) {
    throw new Error("Decision not found.");
  }
  return data;
}

const DecideSchema = z.object({
  decisionId: z.string().guid(),
  action: z.enum(["approved", "rejected", "sent_back", "info_requested", "delegated", "withdrawn"]),
  reason: z.string().trim().max(2000).optional(),
  delegateTo: z.string().guid().optional(),
});

export type DecideParams = z.infer<typeof DecideSchema>;

const DECIDE_MESSAGES: Record<string, (title: string, reason?: string) => string> = {
  approved: (title) => `Your request "${title}" was approved.`,
  rejected: (title, reason) => `Your request "${title}" was declined.${reason ? ` Reason: ${reason}` : ""}`,
  sent_back: (title, reason) => `"${title}" needs more information before it can be decided.${reason ? ` ${reason}` : ""}`,
  info_requested: (title, reason) => `More information was requested for "${title}".${reason ? ` ${reason}` : ""}`,
  delegated: (title) => `"${title}" has been delegated for review.`,
  withdrawn: (title) => `"${title}" was withdrawn.`,
};

export async function decideOnDecisionCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: DecideParams
) {
  const { decisionId, action, reason, delegateTo } = DecideSchema.parse(params);

  const { data: existing } = await supabase
    .from("decisions")
    .select("status, requested_by, delegated_to, title")
    .eq("id", decisionId)
    .eq("college_id", actor.collegeId)
    .single();

  if (!existing) {
    throw new Error("Decision not found.");
  }
  if (!["pending", "info_requested", "sent_back"].includes(existing.status)) {
    throw new Error("This decision has already been decided.");
  }
  assertNotSelfApproval(actor, existing.requested_by, "decision request");

  const update: Database["public"]["Tables"]["decisions"]["Update"] = {
    status: action,
    decision_reason: reason ?? null,
  };
  if (action === "approved" || action === "rejected") {
    update.decided_by = actor.userId;
    update.decided_at = new Date().toISOString();
  }
  if (action === "delegated") {
    if (!delegateTo) {
      throw new Error("A delegate is required.");
    }
    update.delegated_to = delegateTo;
  }

  // Compare-and-swap on the exact status read above, so two directors (or
  // one double-click) can't both record a decision and both notify the
  // requester. See lib/concurrent-claim.ts.
  const { data: claimed, error } = await supabase
    .from("decisions")
    .update(update)
    .eq("id", decisionId)
    .eq("college_id", actor.collegeId)
    .eq("status", existing.status)
    .select("id");

  if (error) {
    throw dbError(error);
  }
  assertClaimed(claimed, "decision");

  await logAudit(supabase, actor, `decision_${action}`, "decisions", decisionId, {
    oldValue: { status: existing.status },
    newValue: { status: action, decision_reason: reason ?? null, delegated_to: delegateTo ?? null },
  });

  // Requester always gets notified. The delegate, if any, gets a separate,
  // differently-worded row — no accessible screen exists yet for either
  // outside the Director portal (route-prefix-restricted, see proxy.ts), so
  // neither notification carries a link.
  const recipients = [existing.requested_by];
  if (action === "delegated" && delegateTo) {
    recipients.push(delegateTo);
  }

  let notificationType: "success" | "error" | "action_required" = "action_required";
  if (action === "approved") notificationType = "success";
  else if (action === "rejected") notificationType = "error";

  await supabase.from("notifications").insert(
    recipients.map((receiverId) => ({
      college_id: actor.collegeId,
      title: action === "delegated" && receiverId === delegateTo ? "Decision delegated to you" : "Decision update",
      message:
        action === "delegated" && receiverId === delegateTo
          ? `"${existing.title}" has been delegated to you for review.`
          : DECIDE_MESSAGES[action](existing.title, reason),
      receiver_id: receiverId,
      sender_id: actor.userId,
      type: notificationType,
    }))
  );
}

export async function decideOnDecision(params: DecideParams) {
  const actor = await requireRole(PERMISSIONS.decision_decide);
  await checkRateLimit(`decideOnDecision:${actor.userId}`, 30, 3600);
  const supabase = await createClient();
  await decideOnDecisionCore(supabase, actor, params);
  await invalidateCache(decisionsCacheKey(actor.collegeId));
  revalidatePath("/director/decisions");
  revalidatePath(`/director/decisions/${params.decisionId}`);
}

/** Populates the "Delegate to" select on the decision detail page. */
export async function listDelegateCandidates() {
  const actor = await requireRole(["director"]);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .eq("college_id", actor.collegeId)
    .in("role", ["admin", "director", "hod", "warden", "placement_cell", "finance"])
    .neq("id", actor.userId)
    .order("full_name");
  if (error) {
    throw dbError(error);
  }
  return data || [];
}

/**
 * Narrow, purpose-built audit read for Director — deliberately not widening
 * admin/audit (would expose unrelated admin/system actions Director has no
 * business seeing). Gated by decision_audit_read, not decision_decide,
 * since read access is conceptually separate from deciding.
 */
export async function listDecisionAuditTrail(recordId?: string) {
  const actor = await requireRole(PERMISSIONS.decision_audit_read);
  const supabase = await createClient();

  let query = supabase
    .from("audit_logs")
    .select("*, actor:user_id(full_name, role)")
    .eq("college_id", actor.collegeId)
    .in("table_name", ["decisions", "risk_flags"])
    .order("created_at", { ascending: false })
    .limit(100);

  if (recordId) {
    query = query.eq("record_id", recordId);
  }

  const { data, error } = await query;
  if (error) {
    throw dbError(error);
  }
  return data || [];
}
