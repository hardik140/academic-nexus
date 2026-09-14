"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { PERMISSIONS } from "@/lib/permissions";
import type { Json } from "@/types/database";
import { dbError } from "@/lib/internal-error";

export async function getForecastBaseline() {
  const actor = await requireRole(PERMISSIONS.forecast_simulator_read);
  const supabase = await createClient();

  const [studentsRes, facultyRes, feeRes, placementRes, hostelBlocksRes] = await Promise.all([
    supabase.from("students").select("*", { count: "exact", head: true }).eq("college_id", actor.collegeId).eq("status", "active"),
    supabase.from("profiles").select("*", { count: "exact", head: true }).eq("college_id", actor.collegeId).in("role", ["teacher", "hod"]),
    supabase.from("mv_fee_summary").select("collection_pct").maybeSingle(),
    supabase.from("mv_department_health").select("placement_rate"),
    supabase.from("hostel_blocks").select("id").eq("college_id", actor.collegeId),
  ]);

  let hostelCapacity = 0;
  let hostelOccupancy = 0;
  const blockIds = (hostelBlocksRes.data || []).map((b) => b.id);
  if (blockIds.length > 0) {
    const { data: rooms } = await supabase.from("hostel_rooms").select("capacity, occupancy").in("block_id", blockIds);
    hostelCapacity = (rooms || []).reduce((s, r) => s + r.capacity, 0);
    hostelOccupancy = (rooms || []).reduce((s, r) => s + r.occupancy, 0);
  }

  const placementValues = (placementRes.data || []).map((d) => d.placement_rate).filter((v): v is number => v != null);
  const avgPlacementRate = placementValues.length ? Math.round((placementValues.reduce((s, v) => s + v, 0) / placementValues.length) * 10) / 10 : null;

  return {
    totalStudents: studentsRes.count || 0,
    totalFaculty: facultyRes.count || 0,
    feeCollectionPct: feeRes.data?.collection_pct ?? null,
    placementRate: avgPlacementRate,
    hostelCapacity,
    hostelOccupancy,
  };
}

const ScenarioSchema = z.object({
  enrollmentDelta: z.number().default(0),
  facultyDelta: z.number().default(0),
  feeCollectionDeltaPct: z.number().default(0),
  placementTargetPct: z.number().nullable().optional(),
});
export type ScenarioParams = z.infer<typeof ScenarioSchema>;

/**
 * Pure, deterministic proportional projection — no AI, no invented
 * precision. The hostel-demand assumption (new students seek hostel at the
 * same rate as the current student body) is stated explicitly in the UI,
 * not hidden inside the math.
 */
export async function computeScenario(params: ScenarioParams) {
  const actor = await requireRole(PERMISSIONS.forecast_simulator_read);
  const parsed = ScenarioSchema.parse(params);
  const baseline = await getForecastBaseline();

  const projectedStudents = Math.max(0, baseline.totalStudents + parsed.enrollmentDelta);
  const projectedFaculty = Math.max(0, baseline.totalFaculty + parsed.facultyDelta);
  const projectedRatio = projectedFaculty > 0 ? Math.round((projectedStudents / projectedFaculty) * 10) / 10 : null;
  const baselineRatio = baseline.totalFaculty > 0 ? Math.round((baseline.totalStudents / baseline.totalFaculty) * 10) / 10 : null;

  const projectedFeeCollection = baseline.feeCollectionPct != null ? Math.max(0, Math.min(100, Math.round((baseline.feeCollectionPct + parsed.feeCollectionDeltaPct) * 10) / 10)) : null;

  const hostelUptakeRate = baseline.totalStudents > 0 ? baseline.hostelOccupancy / baseline.totalStudents : null;
  const projectedHostelDemand = hostelUptakeRate != null ? Math.round(projectedStudents * hostelUptakeRate) : null;
  const projectedHostelOccupancyPct =
    projectedHostelDemand != null && baseline.hostelCapacity > 0 ? Math.round((projectedHostelDemand / baseline.hostelCapacity) * 1000) / 10 : null;

  const placementGap = parsed.placementTargetPct != null && baseline.placementRate != null ? Math.round((parsed.placementTargetPct - baseline.placementRate) * 10) / 10 : null;

  return {
    baseline,
    assumptions: parsed,
    projected: {
      students: projectedStudents,
      faculty: projectedFaculty,
      facultyStudentRatio: projectedRatio,
      baselineFacultyStudentRatio: baselineRatio,
      feeCollectionPct: projectedFeeCollection,
      hostelDemand: projectedHostelDemand,
      hostelOccupancyPct: projectedHostelOccupancyPct,
      hostelUptakeRateNote: hostelUptakeRate != null ? `Assumes ${Math.round(hostelUptakeRate * 1000) / 10}% of students seek hostel, matching today's rate.` : null,
      placementGapToTarget: placementGap,
    },
  };
}

const SaveScenarioSchema = z.object({
  name: z.string().trim().min(1).max(200),
  assumptions: ScenarioSchema,
});

export async function saveForecastScenario(params: { name: string; assumptions: ScenarioParams }) {
  const actor = await requireRole(PERMISSIONS.forecast_scenario_save);
  await checkRateLimit(`saveForecastScenario:${actor.userId}`, 20, 3600);
  const { name, assumptions } = SaveScenarioSchema.parse(params);
  const supabase = await createClient();

  const result = await computeScenario(assumptions);

  const { error } = await supabase.from("forecast_scenarios").insert({
    college_id: actor.collegeId,
    created_by: actor.userId,
    name,
    assumptions: assumptions as unknown as Json,
    computed_results: result.projected as unknown as Json,
  });
  if (error) {
    throw dbError(error);
  }
}

export async function listSavedScenarios() {
  const actor = await requireRole(PERMISSIONS.forecast_simulator_read);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("forecast_scenarios")
    .select("*")
    .eq("college_id", actor.collegeId)
    .eq("created_by", actor.userId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    throw dbError(error);
  }
  return data || [];
}
