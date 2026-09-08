"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const METRIC_KEYS = ["placement_rate", "avg_cgpa", "attendance_pct", "fee_collection_pct", "hostel_occupancy_pct"] as const;
type MetricKey = (typeof METRIC_KEYS)[number];

function goalsCacheKey(collegeId: string) {
  return `goals:${collegeId}`;
}

/**
 * Live-resolves an 'auto' goal's current_value from the same real data
 * every other Command Center screen already reads — never trusts a
 * possibly-stale DB column for the number a Director sees. Returns null
 * (never 0) when the underlying signal has no data, same "insufficient
 * data over fabrication" rule as everywhere else in this pass.
 */
async function resolveAutoMetricValue(supabase: SupabaseClient<Database>, actor: AuthorizedActor, metricKey: MetricKey): Promise<number | null> {
  switch (metricKey) {
    case "placement_rate": {
      const { data } = await supabase.from("mv_department_health").select("placement_rate");
      const values = (data || []).map((d) => d.placement_rate).filter((v): v is number => v != null);
      return values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10 : null;
    }
    case "avg_cgpa": {
      const { data } = await supabase.from("mv_department_enrollment").select("avg_cgpa");
      const values = (data || []).map((d) => d.avg_cgpa).filter((v): v is number => v != null);
      return values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100 : null;
    }
    case "attendance_pct": {
      const { data } = await supabase.from("mv_department_health").select("attendance_pct");
      const values = (data || []).map((d) => d.attendance_pct).filter((v): v is number => v != null);
      return values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10 : null;
    }
    case "fee_collection_pct": {
      const { data } = await supabase.from("mv_fee_summary").select("collection_pct").maybeSingle();
      return data?.collection_pct ?? null;
    }
    case "hostel_occupancy_pct": {
      const { data: blocks } = await supabase.from("hostel_blocks").select("id").eq("college_id", actor.collegeId);
      const blockIds = (blocks || []).map((b) => b.id);
      if (blockIds.length === 0) return null;
      const { data: rooms } = await supabase.from("hostel_rooms").select("capacity, occupancy").in("block_id", blockIds);
      const capacity = (rooms || []).reduce((s, r) => s + r.capacity, 0);
      const occupancy = (rooms || []).reduce((s, r) => s + r.occupancy, 0);
      return capacity > 0 ? Math.round((occupancy / capacity) * 1000) / 10 : null;
    }
  }
}

export async function listGoals() {
  const actor = await requireRole(PERMISSIONS.strategic_goal_read);
  const supabase = await createClient();

  let query = supabase
    .from("strategic_goals")
    .select("*, owner:owner_id(full_name, role), department:department_id(name, code), milestones:strategic_goal_milestones(*)")
    .eq("college_id", actor.collegeId)
    .order("created_at", { ascending: false });
  if (actor.role === "hod") {
    query = query.eq("owner_id", actor.userId);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(error.message);
  }

  // Cast to any: this hand-maintained types file doesn't declare table
  // Relationships, so the embedded owner/department/milestones joins can't
  // be inferred — same pattern used throughout the rest of the app.
  const goals = (data || []) as any[];
  const autoGoals = goals.filter((g) => g.tracking_mode === "auto");
  const liveValues = await Promise.all(autoGoals.map((g) => resolveAutoMetricValue(supabase, actor, g.metric_key as MetricKey)));
  const liveValueMap = new Map(autoGoals.map((g, i) => [g.id, liveValues[i]]));

  return goals.map((g) => ({
    ...g,
    current_value: g.tracking_mode === "auto" ? (liveValueMap.get(g.id) ?? null) : g.current_value,
  }));
}

const CreateGoalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  trackingMode: z.enum(["auto", "manual"]),
  metricKey: z.enum(METRIC_KEYS).nullable().optional(),
  metricLabel: z.string().trim().min(1).max(100),
  metricUnit: z.string().trim().max(20).optional(),
  targetValue: z.number(),
  ownerId: z.string().guid().nullable().optional(),
  departmentId: z.string().guid().nullable().optional(),
  startDate: z.string(),
  targetDate: z.string(),
});
export type CreateGoalParams = z.infer<typeof CreateGoalSchema>;

export async function createGoal(params: CreateGoalParams) {
  const actor = await requireRole(PERMISSIONS.strategic_goal_manage);
  await checkRateLimit(`createGoal:${actor.userId}`, 20, 3600);
  const parsed = CreateGoalSchema.parse(params);
  const supabase = await createClient();

  if (parsed.trackingMode === "auto" && !parsed.metricKey) {
    throw new Error("An auto-tracked goal needs a metric.");
  }

  const baselineValue = parsed.trackingMode === "auto" ? await resolveAutoMetricValue(supabase, actor, parsed.metricKey as MetricKey) : null;

  const { data, error } = await supabase
    .from("strategic_goals")
    .insert({
      college_id: actor.collegeId,
      title: parsed.title,
      description: parsed.description ?? null,
      tracking_mode: parsed.trackingMode,
      metric_key: parsed.trackingMode === "auto" ? parsed.metricKey : null,
      metric_label: parsed.metricLabel,
      metric_unit: parsed.metricUnit ?? null,
      baseline_value: baselineValue,
      current_value: parsed.trackingMode === "manual" ? baselineValue : baselineValue,
      target_value: parsed.targetValue,
      owner_id: parsed.ownerId ?? null,
      department_id: parsed.departmentId ?? null,
      start_date: parsed.startDate,
      target_date: parsed.targetDate,
      created_by: actor.userId,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to create goal.");
  }

  await logAudit(supabase, actor, "strategic_goal_created", "strategic_goals", data.id, {
    newValue: { title: parsed.title, tracking_mode: parsed.trackingMode, target_value: parsed.targetValue },
  });

  await invalidateCache(goalsCacheKey(actor.collegeId));
  revalidatePath("/director/goals");
  return { id: data.id as string };
}

const UpdateGoalSchema = z.object({
  goalId: z.string().guid(),
  status: z.enum(["on_track", "at_risk", "off_track", "achieved", "abandoned"]).optional(),
  currentValue: z.number().optional(),
});

/** Manual-goal progress update, or a status override — director-only, matching strategic_goal_manage. */
export async function updateGoal(params: { goalId: string; status?: string; currentValue?: number }) {
  const actor = await requireRole(PERMISSIONS.strategic_goal_manage);
  const { goalId, status, currentValue } = UpdateGoalSchema.parse(params);
  const supabase = await createClient();

  const { data: existing } = await supabase.from("strategic_goals").select("status, current_value, tracking_mode").eq("id", goalId).eq("college_id", actor.collegeId).single();
  if (!existing) {
    throw new Error("Goal not found.");
  }

  const update: Database["public"]["Tables"]["strategic_goals"]["Update"] = {};
  if (status) update.status = status as Database["public"]["Tables"]["strategic_goals"]["Row"]["status"];
  if (currentValue != null && existing.tracking_mode === "manual") update.current_value = currentValue;

  const { error } = await supabase.from("strategic_goals").update(update).eq("id", goalId).eq("college_id", actor.collegeId);
  if (error) {
    throw new Error(error.message);
  }

  await logAudit(supabase, actor, "strategic_goal_updated", "strategic_goals", goalId, {
    oldValue: { status: existing.status, current_value: existing.current_value },
    newValue: update,
  });

  await invalidateCache(goalsCacheKey(actor.collegeId));
  revalidatePath("/director/goals");
}

const AddMilestoneSchema = z.object({
  goalId: z.string().guid(),
  title: z.string().trim().min(1).max(200),
  targetDate: z.string().optional(),
});

export async function addMilestone(params: { goalId: string; title: string; targetDate?: string }) {
  const actor = await requireRole(PERMISSIONS.strategic_goal_manage);
  const { goalId, title, targetDate } = AddMilestoneSchema.parse(params);
  const supabase = await createClient();

  const { error } = await supabase.from("strategic_goal_milestones").insert({
    college_id: actor.collegeId,
    goal_id: goalId,
    title,
    target_date: targetDate || null,
  });
  if (error) {
    throw new Error(error.message);
  }

  await invalidateCache(goalsCacheKey(actor.collegeId));
  revalidatePath("/director/goals");
}

export async function toggleMilestone(milestoneId: string, done: boolean) {
  const actor = await requireRole(PERMISSIONS.strategic_goal_manage);
  const supabase = await createClient();

  const { error } = await supabase
    .from("strategic_goal_milestones")
    .update({ status: done ? "done" : "pending", completed_at: done ? new Date().toISOString() : null })
    .eq("id", milestoneId)
    .eq("college_id", actor.collegeId);
  if (error) {
    throw new Error(error.message);
  }

  await invalidateCache(goalsCacheKey(actor.collegeId));
  revalidatePath("/director/goals");
}

/** Populates the "Owner" select — HODs (departmental goals) plus the Director themself. */
export async function listGoalOwnerCandidates() {
  const actor = await requireRole(["director"]);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .eq("college_id", actor.collegeId)
    .in("role", ["director", "hod"])
    .order("full_name");
  if (error) {
    throw new Error(error.message);
  }
  return data || [];
}
