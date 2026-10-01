"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCached } from "@/lib/cache";
import { PERMISSIONS } from "@/lib/permissions";
import { assertRead } from "@/lib/read-result-server";

async function resolveHodDepartmentId(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { data, error: dataError } = await supabase.from("departments").select("id").eq("hod_id", userId).single();
  assertRead(dataError);
  return data?.id ?? null;
}

/** Director: institution-wide heatmap. HOD: their own department only. */
export async function listDepartmentHealth() {
  const actor = await requireRole(PERMISSIONS.department_risk_read);
  const supabase = await createClient();

  let departmentId: string | null = null;
  if (actor.role === "hod") {
    departmentId = await resolveHodDepartmentId(supabase, actor.userId);
  }

  return getCached(`dept-performance:${actor.role === "hod" ? `hod:${actor.userId}` : `director:${actor.collegeId}`}`, 60, async () => {
    let healthQuery = supabase.from("mv_department_health").select("*").order("department_name");
    if (departmentId) healthQuery = healthQuery.eq("department_id", departmentId);

    let riskQuery = supabase
      .from("risk_flags")
      .select("department_id")
      .eq("college_id", actor.collegeId)
      .in("status", ["open", "assigned", "acknowledged", "in_progress"])
      .not("department_id", "is", null);
    if (departmentId) riskQuery = riskQuery.eq("department_id", departmentId);

    const [healthRes, riskRes] = await Promise.all([healthQuery, riskQuery]);
    assertRead(healthRes.error);
    assertRead(riskRes.error);
    const health = healthRes.data || [];
    const risks = riskRes.data || [];

    return health.map((d) => ({
      departmentId: d.department_id,
      departmentName: d.department_name,
      departmentCode: d.department_code,
      totalStudents: d.total_students,
      avgCgpa: d.avg_cgpa,
      attendancePct: d.attendance_pct,
      backlogCount: d.backlog_count,
      backlogRate: d.backlog_rate,
      feeCollectionPct: d.fee_collection_pct,
      placementRate: d.placement_rate,
      openRiskCount: risks.filter((r) => r.department_id === d.department_id).length,
    }));
  });
}

export async function getDepartmentDetail(departmentId: string) {
  const actor = await requireRole(PERMISSIONS.department_risk_read);
  const supabase = await createClient();

  if (actor.role === "hod") {
    const ownDeptId = await resolveHodDepartmentId(supabase, actor.userId);
    if (ownDeptId !== departmentId) {
      throw new Error("You can only view your own department.");
    }
  }

  // Cast to any: this hand-maintained types file doesn't declare table
  // Relationships, so the embedded profiles:hod_id(...) join collapses this
  // Promise.all tuple's inference — same pattern used throughout the app.
  const [healthRes, funnelRes, riskRes, deptRes] = (await Promise.all([
    supabase.from("mv_department_health").select("*").eq("department_id", departmentId).maybeSingle(),
    supabase.from("mv_placement_funnel").select("*").eq("department_id", departmentId).maybeSingle(),
    supabase
      .from("risk_flags")
      .select("id, title, severity, status, flag_type")
      .eq("college_id", actor.collegeId)
      .eq("department_id", departmentId)
      .in("status", ["open", "assigned", "acknowledged", "in_progress"])
      .order("severity", { ascending: false }),
    supabase.from("departments").select("id, name, code, hod_id, profiles:hod_id(full_name)").eq("id", departmentId).single(),
  ])) as any[];
  assertRead(healthRes.error);
  assertRead(funnelRes.error);
  assertRead(riskRes.error);
  assertRead(deptRes.error);

  if (!deptRes.data) {
    throw new Error("Department not found.");
  }

  return {
    // Cast to any: this hand-maintained types file doesn't declare table
    // Relationships, so the embedded profiles:hod_id(...) join can't be
    // inferred — same pattern used throughout the rest of the app.
    department: deptRes.data as any,
    health: healthRes.data,
    funnel: funnelRes.data,
    openRisks: riskRes.data || [],
  };
}
