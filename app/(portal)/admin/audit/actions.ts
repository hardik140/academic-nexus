"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCached } from "@/lib/cache";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import type { DataTableQuery } from "@/components/ui/data-table";

const LOGS_PAGE_SIZE = 10;
const LOGS_SORT_COLUMNS = ["created_at"] as const;
const LOGS_CACHE_PREFIX = "list:audit-logs";

/**
 * Read-only page — no invalidation wired up. audit_logs is written to by
 * nearly every action in the app (logAudit()), so this cache trades up to
 * 30s of staleness on a log viewer (not a real-time need) for far fewer
 * reads against a table that every other action is also writing to.
 */
export async function listAuditLogs(q: DataTableQuery) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(LOGS_SORT_COLUMNS, "created_at", false, q);
  const cacheKey = listCacheKey(LOGS_CACHE_PREFIX, actor.collegeId, q, column);

  return getCached(cacheKey, 30, async () => {
    let dbQuery = supabase
      .from("audit_logs")
      .select("*, profiles:user_id(full_name, email, role)", { count: "exact" });

    if (q.search) dbQuery = dbQuery.ilike("action", `%${q.search}%`);
    dbQuery = dbQuery.order(column, { ascending });

    const from = q.page * LOGS_PAGE_SIZE;
    const { data, count } = await dbQuery.range(from, from + LOGS_PAGE_SIZE - 1);
    return { data: data || [], count: count ?? 0 };
  });
}
