import type { DataTableQuery } from "@/components/ui/data-table";
import { keyDigest } from "@/lib/redis-config";

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

/**
 * The longest search that is cached. Longer searches still run — they go
 * straight to the database — because a 2,000-character search is not a
 * query anyone repeats, and caching it would only spend Redis memory and
 * commands on a key nobody reads twice.
 */
export const MAX_CACHED_SEARCH_LENGTH = 100;
const MAX_CACHED_PAGE = 10_000;

/**
 * The search as it appears in a key. Never the raw text: it is user input,
 * of any length and any characters (colons, spaces, Unicode), and keys must
 * neither grow with it nor be shaped by it. The empty search ("no filter":
 * list queries test `if (q.search)`) gets its own token; a whitespace-only
 * search IS a filter (it reaches .ilike) and is hashed like any other, so
 * the key never claims two different queries are the same.
 *
 * Case and whitespace are NOT folded: the key must describe the query that
 * actually runs, and the query receives q.search verbatim. Folding here
 * would make two different queries share one cached answer.
 */
function searchToken(search: string): string | null {
  if (search === "") return "-";
  if (search.length > MAX_CACHED_SEARCH_LENGTH) return null;
  return `s${keyDigest(search.normalize("NFC"))}`;
}

/**
 * Key for one page of a cached list, or null when the query is not cacheable
 * (getCached then reads the database directly). `scopeId` is the visibility
 * scope of the rows — the college for college-wide lists, the user where
 * the query is narrowed per user — never just "the college" by habit
 * (see tests/cache-scope-registry.test.ts).
 *
 * Server Actions are directly callable, so every part is validated, not
 * trusted: an invalid page or sort direction makes the query uncacheable
 * rather than minting a new key per garbage value.
 */
export function listCacheKey(prefix: string, scopeId: string, q: DataTableQuery, sortColumn: string): string | null {
  if (!Number.isInteger(q.page) || q.page < 0 || q.page > MAX_CACHED_PAGE) return null;
  if (q.sortDir !== "asc" && q.sortDir !== "desc") return null;
  if (typeof q.search !== "string") return null;
  const search = searchToken(q.search);
  if (search === null) return null;
  return `${prefix}:${scopeId}:${q.page}:${sortColumn}:${q.sortDir}:${search}`;
}
