"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCached } from "@/lib/cache";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import { DEFAULT_QUERY_LIMIT } from "@/lib/constants";
import type { DataTableQuery } from "@/components/ui/data-table";

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

  return getCached(cacheKey, 30, async () => {
    const [facultyRes, coursesRes] = await Promise.all([
      (() => {
        let dbQuery = supabase
          .from("profiles")
          .select("*, departments:department_id(name, code)", { count: "exact" })
          .in("role", ["teacher", "hod"]);
        if (q.search) dbQuery = dbQuery.ilike("full_name", `%${q.search}%`);
        dbQuery = dbQuery.order(column, { ascending });
        const from = q.page * FACULTY_PAGE_SIZE;
        return dbQuery.range(from, from + FACULTY_PAGE_SIZE - 1);
      })(),
      // Course catalog, not a per-transaction table — 2x the default cap is
      // ample headroom while still keeping this tally from silently
      // undercounting under normal growth.
      supabase.from("courses").select("id, instructor_id").limit(DEFAULT_QUERY_LIMIT * 2),
    ]);

    const courseCounts: Record<string, number> = {};
    (coursesRes.data || []).forEach((c: any) => {
      if (!c.instructor_id) return;
      courseCounts[c.instructor_id] = (courseCounts[c.instructor_id] || 0) + 1;
    });

    const data = (facultyRes.data || []).map((f: any) => ({ ...f, course_count: courseCounts[f.id] || 0 }));
    return { data, count: facultyRes.count ?? 0 };
  });
}
