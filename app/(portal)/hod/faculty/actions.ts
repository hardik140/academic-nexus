"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCached } from "@/lib/cache";
import { PERMISSIONS } from "@/lib/permissions";
import { assertRead } from "@/lib/read-result-server";

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

    // Workload is measured in OFFERINGS delivered, not catalog rows owned.
    // Under courses.instructor_id a teacher taking three sections of one
    // course counted as teaching "1 course", and two teachers splitting a
    // course could not both be counted at all. Weekly periods likewise come
    // from the slots of those offerings, since timetable_slots no longer
    // carries its own instructor_id (047) — it belongs to the offering.
    // Cancelled offerings are excluded: nobody is teaching them.
    const facultyIds = faculty.map((f) => f.id);
    const { data: offerings, error: offeringsError } = await supabase
      .from("course_offerings")
      .select("id, instructor_id, status")
      .in("instructor_id", facultyIds);
    assertRead(offeringsError);

    const live = (offerings || []).filter((o) => o.status !== "cancelled");

    const courseCounts: Record<string, number> = {};
    live.forEach((o) => {
      if (!o.instructor_id) return;
      courseCounts[o.instructor_id] = (courseCounts[o.instructor_id] || 0) + 1;
    });

    const instructorByOffering = new Map(live.map((o) => [o.id, o.instructor_id]));
    const { data: slots, error: slotsError } = live.length
      ? await supabase.from("timetable_slots").select("offering_id").in("offering_id", live.map((o) => o.id))
      : { data: [], error: null };
    assertRead(slotsError);

    const weeklyPeriods: Record<string, number> = {};
    (slots || []).forEach((s) => {
      const instructorId = instructorByOffering.get(s.offering_id);
      if (!instructorId) return;
      weeklyPeriods[instructorId] = (weeklyPeriods[instructorId] || 0) + 1;
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
