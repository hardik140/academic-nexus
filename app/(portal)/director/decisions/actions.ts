"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCacheFamily, versionedKey } from "@/lib/cache";
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

const DECISIONS_CACHE_FAMILY = "decisions";

function decisionsCacheKey(collegeId: string) {
  return versionedKey(`decisions:${collegeId}`, DECISIONS_CACHE_FAMILY, collegeId);
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
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string,
    params: Record<string, unknown>
  ) => PromiseLike<{
    data: Array<{ decision_id: string }> | null;
    error: { message: string; code?: string } | null;
  }>;
  const { data, error } = await rpc("submit_decision", {
    p_category: parsed.category,
    p_title: parsed.title,
    p_description: parsed.description,
    p_urgency: parsed.urgency,
    p_financial_impact: parsed.financialImpact ?? null,
    p_student_impact_count: parsed.studentImpactCount ?? null,
    p_institutional_impact_summary: parsed.institutionalImpactSummary ?? null,
    p_recommendation: parsed.recommendation ?? null,
    p_deadline: parsed.deadline ?? null,
  });
  const decision = data?.[0];

  if (error || !decision) {
    throw dbError(error ?? { message: "Failed to submit decision." });
  }

  return { id: decision.decision_id };
}

export async function submitDecision(params: SubmitDecisionParams) {
  const actor = await requireRole(PERMISSIONS.decision_submit);
  await checkRateLimit(`submitDecision:${actor.userId}`, 10, 3600);
  const supabase = await createClient();
  const result = await submitDecisionCore(supabase, actor, params);
  await invalidateCacheFamily(DECISIONS_CACHE_FAMILY, actor.collegeId);
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

export async function decideOnDecisionCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: DecideParams
) {
  const { decisionId, action, reason, delegateTo } = DecideSchema.parse(params);
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string,
    params: Record<string, unknown>
  ) => PromiseLike<{
    data: Array<{ decision_id: string }> | null;
    error: { message: string; code?: string } | null;
  }>;
  const { data, error } = await rpc("decide_decision", {
    p_decision_id: decisionId,
    p_action: action,
    p_reason: reason ?? null,
    p_delegate_to: delegateTo ?? null,
  });
  if (error || !data?.[0]) {
    throw dbError(error ?? { message: "Decision could not be updated." });
  }
}

export async function decideOnDecision(params: DecideParams) {
  const actor = await requireRole(PERMISSIONS.decision_decide);
  await checkRateLimit(`decideOnDecision:${actor.userId}`, 30, 3600);
  const supabase = await createClient();
  await decideOnDecisionCore(supabase, actor, params);
  await invalidateCacheFamily(DECISIONS_CACHE_FAMILY, actor.collegeId);
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
