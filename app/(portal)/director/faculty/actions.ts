"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCachedWriteBehind } from "@/lib/cache";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import type { DataTableQuery } from "@/components/ui/data-table";
import { businessRpc, num } from "@/lib/business-rpc";
import { assertRead } from "@/lib/read-result-server";

const FACULTY_PAGE_SIZE = 10;
// full_name only — course_count is a join tally computed below, not a real
// profiles column the server could .order() by.
const FACULTY_SORT_COLUMNS = ["full_name"] as const;
const FACULTY_CACHE_PREFIX = "list:faculty";

/**
 * Read-only page (no mutations) — no invalidation wired up, 30s TTL alone
 * is fine. Course-count-per-instructor is folded into the same cache entry
 * as the paginated faculty page rather than cached separately: it doesn't
 * vary by page, but a cache miss recomputing both together is simpler than
 * coordinating two caches, and the course catalog rarely changes anyway.
 */
export async function listFaculty(q: DataTableQuery) {
  const actor = await requireRole(["director"]);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(FACULTY_SORT_COLUMNS, "full_name", true, q);
  const cacheKey = listCacheKey(FACULTY_CACHE_PREFIX, actor.collegeId, q, column);

  return getCachedWriteBehind(cacheKey, 30, async () => {
    let facultyQuery = supabase
      .from("profiles")
      .select("*, departments:department_id(name, code)", { count: "exact" })
      .in("role", ["teacher", "hod"]);
    if (q.search) facultyQuery = facultyQuery.ilike("full_name", `%${q.search}%`);
    const from = q.page * FACULTY_PAGE_SIZE;
    const facultyRes = await facultyQuery.order(column, { ascending }).range(from, from + FACULTY_PAGE_SIZE - 1);
    assertRead(facultyRes.error);

    // Workload is measured in OFFERINGS delivered (not cancelled), weekly
    // periods from those offerings' slots, attendance as distinct days
    // marked, marks as entries — all counted in PostgreSQL (migration 059,
    // faculty_activity) for this page's faculty only. This used to read the
    // college's offerings and slots capped at 1,000 rows each, and every
    // attendance and marks row of the page's faculty, and tally them here:
    // past the cap the tallies were silently low.
    const pageIds = (facultyRes.data || []).map((f: any) => f.id as string);
    const activity = pageIds.length
      ? await businessRpc<{
          faculty_id: string;
          course_count: number | string;
          weekly_periods: number | string;
          attendance_sessions_marked: number | string;
          marks_entered: number | string;
        }>(supabase, "faculty_activity", { p_college_id: actor.collegeId, p_faculty_ids: pageIds })
      : [];
    const byId = new Map(activity.map((a) => [a.faculty_id, a]));

    const data = (facultyRes.data || []).map((f: any) => {
      const a = byId.get(f.id);
      return {
        ...f,
        course_count: num(a?.course_count),
        weekly_periods: num(a?.weekly_periods),
        attendance_sessions_marked: num(a?.attendance_sessions_marked),
        marks_entered: num(a?.marks_entered),
      };
    });
    return { data, count: facultyRes.count ?? 0 };
  });
}
