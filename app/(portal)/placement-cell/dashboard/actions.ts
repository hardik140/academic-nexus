"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCachedWriteBehind } from "@/lib/cache";
import { assertRead } from "@/lib/read-result-server";

export async function getPlacementCellDashboard() {
  const actor = await requireRole(["placement_cell", "director", "admin"]);
  const supabase = await createClient();

  // Role-scoped: placement_cell, director and admin see DIFFERENT rows here
  // (students_read_staff excludes placement_cell; student_placement_profiles
  // excludes director), so one college-wide entry served one role's data to
  // another. See tests/cache-scope-registry.test.ts.
  return getCachedWriteBehind(`placement:cell-dashboard:${actor.collegeId}:${actor.role}`, 60, async () => {
    const [
      totalStudentsRes,
      eligibleRes,
      summaryRes,
      companiesRes,
      activeDrivesRes,
      applicationsRes,
      recentDrivesRes,
      recentApplicationsRes,
    ] = await Promise.all([
      supabase.from("students").select("*", { count: "exact", head: true }).eq("college_id", actor.collegeId),
      supabase
        .from("student_placement_profiles")
        .select("*", { count: "exact", head: true })
        .eq("college_id", actor.collegeId)
        .eq("placement_status", "eligible"),
      supabase.from("mv_placement_summary").select("*").maybeSingle(),
      supabase.from("companies").select("*", { count: "exact", head: true }).eq("college_id", actor.collegeId),
      supabase
        .from("placement_drives")
        .select("*", { count: "exact", head: true })
        .eq("college_id", actor.collegeId)
        .eq("status", "published"),
      supabase.from("placement_applications").select("*", { count: "exact", head: true }).eq("college_id", actor.collegeId),
      supabase
        .from("placement_drives")
        .select("id, job_role, status, application_deadline, companies:company_id(name), placement_applications(count)")
        .eq("college_id", actor.collegeId)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("placement_applications")
        .select(
          "id, status, applied_at, students:student_id(profiles:user_id(full_name)), placement_drives:drive_id(job_role, companies:company_id(name))"
        )
        .eq("college_id", actor.collegeId)
        .order("applied_at", { ascending: false })
        .limit(5),
    ]);
    assertRead(totalStudentsRes.error);
    assertRead(eligibleRes.error);
    assertRead(summaryRes.error);
    assertRead(companiesRes.error);
    assertRead(activeDrivesRes.error);
    assertRead(applicationsRes.error);
    assertRead(recentDrivesRes.error);
    assertRead(recentApplicationsRes.error);

    const totalStudents = totalStudentsRes.count || 0;
    const placed = summaryRes.data?.total_placed || 0;

    return {
      totalStudents,
      eligibleStudents: eligibleRes.count || 0,
      placed,
      placementRate: totalStudents ? Math.round((placed / totalStudents) * 100) : 0,
      companies: companiesRes.count || 0,
      activeDrives: activeDrivesRes.count || 0,
      applications: applicationsRes.count || 0,
      offers: placed,
      recentDrives: recentDrivesRes.data || [],
      recentApplications: recentApplicationsRes.data || [],
    };
  });
}
