"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCached } from "@/lib/cache";
import { PERMISSIONS } from "@/lib/permissions";

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

  return getCached(cacheKey, 60, async () => {
    let departmentId: string | null = null;
    if (actor.role === "hod") {
      const { data: department } = await supabase.from("departments").select("id").eq("hod_id", actor.userId).single();
      departmentId = department?.id ?? null;
      if (!departmentId) return [];
    }

    let facultyQuery = supabase.from("profiles").select("id, full_name, email").in("role", ["teacher", "hod"]);
    facultyQuery = departmentId ? facultyQuery.eq("department_id", departmentId) : facultyQuery.eq("college_id", actor.collegeId);
    const { data: faculty } = await facultyQuery.order("full_name");
    if (!faculty || faculty.length === 0) return [];

    const facultyIds = faculty.map((f) => f.id);
    const [coursesRes, slotsRes] = await Promise.all([
      supabase.from("courses").select("id, instructor_id").in("instructor_id", facultyIds),
      supabase.from("timetable_slots").select("instructor_id").in("instructor_id", facultyIds),
    ]);

    const courseCounts: Record<string, number> = {};
    (coursesRes.data || []).forEach((c) => {
      if (!c.instructor_id) return;
      courseCounts[c.instructor_id] = (courseCounts[c.instructor_id] || 0) + 1;
    });

    const weeklyPeriods: Record<string, number> = {};
    (slotsRes.data || []).forEach((s) => {
      if (!s.instructor_id) return;
      weeklyPeriods[s.instructor_id] = (weeklyPeriods[s.instructor_id] || 0) + 1;
    });

    return faculty
      .map((f) => {
        const periods = weeklyPeriods[f.id] || 0;
        return {
          id: f.id,
          fullName: f.full_name,
          email: f.email,
          courseCount: courseCounts[f.id] || 0,
          weeklyPeriods: periods,
          workloadPct: Math.round((periods / STANDARD_WEEKLY_LOAD) * 100),
        };
      })
      .sort((a, b) => b.workloadPct - a.workloadPct);
  });
}
