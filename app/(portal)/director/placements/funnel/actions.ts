"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCachedWriteBehind } from "@/lib/cache";
import { PERMISSIONS } from "@/lib/permissions";
import { assertRead } from "@/lib/read-result-server";

/**
 * Institution + department-level funnel from mv_placement_funnel (the real
 * per-student pipeline state — see migration 033's doc comment for why this
 * is not the same as the legacy mv_placement_summary Director's placements
 * page already reads).
 */
export async function getInstitutionPlacementFunnel() {
  const actor = await requireRole(PERMISSIONS.institution_placement_funnel_read);
  const supabase = await createClient();

  return getCachedWriteBehind(`placement-funnel:${actor.collegeId}`, 60, async () => {
    const { data, error: dataError } = await supabase.from("mv_placement_funnel").select("*").order("department_name");
    assertRead(dataError);
    const departments = data || [];

    const totals = departments.reduce(
      (acc, d) => ({
        total_students: acc.total_students + d.total_students,
        not_placed_count: acc.not_placed_count + d.not_placed_count,
        eligible_count: acc.eligible_count + d.eligible_count,
        applied_count: acc.applied_count + d.applied_count,
        shortlisted_count: acc.shortlisted_count + d.shortlisted_count,
        selected_count: acc.selected_count + d.selected_count,
        placed_count: acc.placed_count + d.placed_count,
        rejected_count: acc.rejected_count + d.rejected_count,
        opted_out_count: acc.opted_out_count + d.opted_out_count,
      }),
      {
        total_students: 0,
        not_placed_count: 0,
        eligible_count: 0,
        applied_count: 0,
        shortlisted_count: 0,
        selected_count: 0,
        placed_count: 0,
        rejected_count: 0,
        opted_out_count: 0,
      }
    );

    return { totals, departments };
  });
}

/** Per-drive detail — small, bounded row counts, so queried live rather than materialized (see migration 033). */
export async function listDriveFunnels() {
  const actor = await requireRole(PERMISSIONS.institution_placement_funnel_read);
  const supabase = await createClient();

  // Cast to any: this hand-maintained types file doesn't declare table
  // Relationships, so the embedded companies:company_id(...) join can't be
  // inferred — same pattern used throughout the rest of the app.
  const { data: drives, error: drivesError } = (await supabase
    .from("placement_drives")
    .select("id, job_role, status, companies:company_id(name)")
    .eq("college_id", actor.collegeId)
    .order("created_at", { ascending: false })
    .limit(20)) as any;
  assertRead(drivesError);

  if (!drives || drives.length === 0) return [];

  const driveIds = drives.map((d: any) => d.id);
  const { data: applications, error: applicationsError } = await supabase.from("placement_applications").select("drive_id, status").in("drive_id", driveIds);
  assertRead(applicationsError);

  return drives.map((drive: any) => {
    const apps = (applications || []).filter((a) => a.drive_id === drive.id);
    return {
      id: drive.id,
      jobRole: drive.job_role,
      companyName: (drive as any).companies?.name || "Unknown",
      status: drive.status,
      applied: apps.length,
      shortlisted: apps.filter((a) => a.status === "shortlisted").length,
      interview: apps.filter((a) => a.status === "interview").length,
      selected: apps.filter((a) => a.status === "selected").length,
      rejected: apps.filter((a) => a.status === "rejected").length,
    };
  });
}
