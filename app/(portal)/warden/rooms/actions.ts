"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCached } from "@/lib/cache";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import { PERMISSIONS } from "@/lib/permissions";
import type { DataTableQuery } from "@/components/ui/data-table";
import { assertRead } from "@/lib/read-result-server";

const ROOMS_PAGE_SIZE = 10;
const ROOMS_SORT_COLUMNS = ["block_name", "room_number", "type", "occupancy"] as const;
const ROOMS_CACHE_PREFIX = "list:hostel-rooms";

/**
 * Read-only page (no mutations), so no invalidation needed — the 30s TTL
 * alone is fine here, same as it is for the dashboards.
 */
export async function listWardenRooms(q: DataTableQuery) {
  const actor = await requireRole(PERMISSIONS.hostel_room_read);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(ROOMS_SORT_COLUMNS, "block_name", true, q);
  // Scope = what the query returns: an admin sees every room in the college,
  // a warden only the blocks they run. Keying on the college alone let one
  // warden's page be served to another warden (or to an admin) for 30 s.
  const cacheKey = listCacheKey(ROOMS_CACHE_PREFIX, actor.role === "admin" ? actor.collegeId : actor.userId, q, column);

  return getCached(cacheKey, 30, async () => {
    // Resolved server-side from the authenticated actor, never trusted from
    // the client — matches the "never trust client-picked ids" precedent
    // used throughout this codebase's assignHodCore/assignWardenCore.
    // admin is unrestricted (matches every other warden/*/actions.ts
    // resolver's null-means-unrestricted convention) — previously this
    // filtered by warden_id = actor.userId even for admin, which never
    // matches any block and silently produced an empty room list.
    let blockIds: string[] | null = null;
    if (actor.role !== "admin") {
      const { data: blocks, error: blocksError } = await supabase.from("hostel_blocks").select("id").eq("warden_id", actor.userId);
      assertRead(blocksError);
      blockIds = (blocks || []).map((b) => b.id);
      if (blockIds.length === 0) {
        return { data: [], count: 0 };
      }
    }

    let dbQuery = supabase
      .from("hostel_rooms")
      .select("*", { count: "exact" })
      .eq("college_id", actor.collegeId);
    if (blockIds !== null) dbQuery = dbQuery.in("block_id", blockIds);

    if (q.search) dbQuery = dbQuery.ilike("room_number", `%${q.search}%`);
    dbQuery = dbQuery.order(column, { ascending });
    if (!q.sortKey) dbQuery = dbQuery.order("room_number", { ascending: true });

    const from = q.page * ROOMS_PAGE_SIZE;
    const { data, count, error: dataError } = await dbQuery.range(from, from + ROOMS_PAGE_SIZE - 1);
    assertRead(dataError);
    return { data: data || [], count: count ?? 0 };
  });
}
