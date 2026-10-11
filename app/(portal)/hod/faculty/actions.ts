"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCachedWriteBehind } from "@/lib/cache";
import { PERMISSIONS } from "@/lib/permissions";
import { assertRead } from "@/lib/read-result-server";
import { businessRpc, num } from "@/lib/business-rpc";

// Full teaching load a single instructor is expected to carry per week —
// there is no per-college/per-department config for this anywhere in the
// schema, so this is a documented constant, not a fabricated per-teacher
// number. Matches director/faculty/actions.ts's own refusal to invent an
// "expected count" it can't back with real data: weekly_periods itself
// (the numerator) is always a real tally of that teacher's timetable_slots.
const STANDARD_WEEKLY_LOAD = 16;

/**
 * Department-scoped sibling of director/faculty/actions.ts's listFaculty —
 * that function is intentionally college-wide + paginated for the
 * Director's own faculty directory; a HOD's department is a single small
 * list, so this is its own query rather than a forked copy of that page.
 */
export async function listDepartmentFacultyWorkload() {
  const actor = await requireRole(PERMISSIONS.faculty_workload_read);
  const supabase = await createClient();

  const cacheKey = `hod-workload:${actor.role === "hod" ? actor.userId : actor.collegeId}`;

  return getCachedWriteBehind(cacheKey, 60, async () => {
    let departmentId: string | null = null;
    if (actor.role === "hod") {
      const { data: department, error: departmentError } = await supabase.from("departments").select("id").eq("hod_id", actor.userId).single();
      assertRead(departmentError);
      departmentId = department?.id ?? null;
      if (!departmentId) return [];
    }

    let facultyQuery = supabase.from("profiles").select("id, full_name, email").in("role", ["teacher", "hod"]);
    facultyQuery = departmentId ? facultyQuery.eq("department_id", departmentId) : facultyQuery.eq("college_id", actor.collegeId);
    const { data: faculty, error: facultyError } = await facultyQuery.order("full_name");
    assertRead(facultyError);
    if (!faculty || faculty.length === 0) return [];

    // Workload is measured in OFFERINGS delivered (not cancelled) and the
    // weekly periods of their slots, counted in PostgreSQL (migration 059,
    // faculty_activity). This used to read the offerings and then their
    // slots — a college's slots run past PostgREST's 1,000-row cap — and
    // tally them here.
    const facultyIds = faculty.map((f) => f.id);
    const activity = await businessRpc<{ faculty_id: string; course_count: number | string; weekly_periods: number | string }>(
      supabase,
      "faculty_activity",
      { p_college_id: actor.collegeId, p_faculty_ids: facultyIds }
    );
    const byId = new Map(activity.map((a) => [a.faculty_id, a]));

    return faculty
      .map((f) => {
        const periods = num(byId.get(f.id)?.weekly_periods);
        return {
          id: f.id,
          fullName: f.full_name,
          email: f.email,
          courseCount: num(byId.get(f.id)?.course_count),
          weeklyPeriods: periods,
          workloadPct: Math.round((periods / STANDARD_WEEKLY_LOAD) * 100),
        };
      })
      .sort((a, b) => b.workloadPct - a.workloadPct);
  });
}
