import type { DataTableQuery } from "@/components/ui/data-table";

/**
 * Shared sort-resolution + cache-key logic for Phase 3's cached, paginated
 * list Server Actions (see app/(portal)/admin/users/actions.ts's listUsers
 * for the first fully-worked example). Deliberately doesn't wrap the actual
 * getCached()/Supabase call — the query shape (joins, extra filters) varies
 * too much per table to generalize usefully, and forcing it through a
 * generic would fight Supabase's per-table row typing for little benefit.
 * What's extracted is the part that's identical everywhere and easy to get
 * subtly wrong: allowlisting sortKey before it reaches .order() (Server
 * Actions are directly callable, not just reachable through the UI that
 * only ever sends trusted values — "treat all input as adversarial" per
 * this repo's own AGENTS.md), and building a consistent cache key.
 */
export function resolveListSort(
  allowedSortKeys: readonly string[],
  defaultColumn: string,
  defaultAscending: boolean,
  q: DataTableQuery
): { column: string; ascending: boolean } {
  if (q.sortKey && allowedSortKeys.includes(q.sortKey)) {
    return { column: q.sortKey, ascending: q.sortDir === "asc" };
  }
  return { column: defaultColumn, ascending: defaultAscending };
}

export function listCacheKey(prefix: string, collegeId: string, q: DataTableQuery, sortColumn: string): string {
  return `${prefix}:${collegeId}:${q.page}:${sortColumn}:${q.sortDir}:${q.search}`;
}
