"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCached } from "@/lib/cache";

const STAFF_ROLES = ["placement_cell", "director", "admin"] as const;

// See app/(portal)/student/placements/actions.ts's comment on why embedded
// selects need a local cast — the hand-maintained Database type has no
// Relationships entries for supabase-js to infer these joins from.
interface PlacementReportRow {
  company_name: string;
  package_lpa: number | null;
  status: string;
  students: { department_id: string; batch_year: number; departments: { name: string } | null } | null;
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

  return getCached(`placement:reports:${actor.collegeId}`, 120, async () => {
    const [placementsRes, totalStudentsRes] = await Promise.all([
      supabase
        .from("placements")
        .select("company_name, package_lpa, status, students:student_id(department_id, batch_year, departments(name))")
        .eq("college_id", actor.collegeId)
        .in("status", ["placed", "joined"]),
      supabase.from("students").select("*", { count: "exact", head: true }).eq("college_id", actor.collegeId),
    ]);

    const rows = (placementsRes.data || []) as unknown as PlacementReportRow[];
    const byDepartment: Record<string, number> = {};
    const byCompany: Record<string, number> = {};
    const byYear: Record<string, number> = {};
    const packageBuckets = { "< ₹5L": 0, "₹5–10L": 0, "₹10–15L": 0, "₹15L+": 0 };

    rows.forEach((r) => {
      const student = r.students;
      const deptName = student?.departments?.name || "Unknown";
      byDepartment[deptName] = (byDepartment[deptName] || 0) + 1;
      byCompany[r.company_name] = (byCompany[r.company_name] || 0) + 1;

      const year = student?.batch_year;
      if (year) byYear[String(year)] = (byYear[String(year)] || 0) + 1;

      const pkg = r.package_lpa || 0;
      if (pkg < 5) packageBuckets["< ₹5L"]++;
      else if (pkg < 10) packageBuckets["₹5–10L"]++;
      else if (pkg < 15) packageBuckets["₹10–15L"]++;
      else packageBuckets["₹15L+"]++;
    });

    const totalStudents = totalStudentsRes.count || 0;
    const totalPlaced = rows.length;

    return {
      totalPlaced,
      totalStudents,
      placementRate: totalStudents ? Math.round((totalPlaced / totalStudents) * 100) : 0,
      byDepartment: Object.entries(byDepartment)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      byCompany: Object.entries(byCompany)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      byYear: Object.entries(byYear)
        .map(([year, count]) => ({ year, count }))
        .sort((a, b) => Number(a.year) - Number(b.year)),
      packageDistribution: Object.entries(packageBuckets).map(([range, count]) => ({ range, count })),
    };
  });
}
