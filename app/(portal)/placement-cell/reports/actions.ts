"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCachedWriteBehind } from "@/lib/cache";
import { assertRead } from "@/lib/read-result-server";
import { businessRpc, num } from "@/lib/business-rpc";

const STAFF_ROLES = ["placement_cell", "director", "admin"] as const;

interface PlacementReport {
  totalPlaced: number;
  byDepartment: { name: string; count: number }[];
  byCompany: { name: string; count: number }[];
  byYear: { year: string; count: number }[];
  packageDistribution: { range: string; count: number }[];
}

/**
 * Placement report aggregates — computed via grouped Supabase queries in a
 * cached Server Action rather than a new materialized view (see the
 * Placement Cell plan's "no new MV for V1" scope note): a handful of
 * GROUP BY-shaped rollups at college scale, cached the same way
 * getDashboardStats() already caches director/dashboard's counts.
 */
export async function getPlacementReports() {
  const actor = await requireRole(STAFF_ROLES);
  const supabase = await createClient();

  // Role-scoped: placement_cell, director and admin see DIFFERENT rows here
  // (students_read_staff excludes placement_cell; student_placement_profiles
  // excludes director), so one college-wide entry served one role's data to
  // another. See tests/cache-scope-registry.test.ts.
  return getCachedWriteBehind(`placement:reports:${actor.collegeId}:${actor.role}`, 120, async () => {
    // Grouped in PostgreSQL (migration 059, placement_report) over EVERY
    // placed or joined placement. This used to read the rows — capped at
    // PostgREST's 1,000 — and group them here, so past the cap every count
    // and the placement rate were silently low. The department and batch
    // year still come through students under the caller's RLS, exactly as
    // the old embedded join did, so roles that cannot read a student still
    // see "Unknown" for it.
    const [reportRows, totalStudentsRes] = await Promise.all([
      businessRpc<PlacementReport>(supabase, "placement_report", { p_college_id: actor.collegeId }),
      supabase.from("students").select("*", { count: "exact", head: true }).eq("college_id", actor.collegeId),
    ]);
    assertRead(totalStudentsRes.error);
    const report = reportRows[0];
    const totalStudents = totalStudentsRes.count || 0;
    const totalPlaced = num(report?.totalPlaced);
    const counted = <T extends { count: unknown }>(xs: T[] | undefined) =>
      Array.isArray(xs) ? xs.map((x) => ({ ...x, count: num(x.count) })) : [];

    return {
      totalPlaced,
      totalStudents,
      placementRate: totalStudents ? Math.round((totalPlaced / totalStudents) * 100) : 0,
      byDepartment: counted(report?.byDepartment),
      byCompany: counted(report?.byCompany),
      byYear: counted(report?.byYear),
      packageDistribution: counted(report?.packageDistribution),
    };
  });
}
