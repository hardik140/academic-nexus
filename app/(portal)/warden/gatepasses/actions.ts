"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { DataTableQuery } from "@/components/ui/data-table";

const PROCESSED_PAGE_SIZE = 10;
const PROCESSED_SORT_COLUMNS = ["exit_time", "destination"] as const;
const PROCESSED_CACHE_PREFIX = "list:gatepasses";

function pendingCacheKey(collegeId: string) {
  return `pending:gatepasses:${collegeId}`;
}

/** The "needs your attention now" queue — short TTL (15s, shorter than the
 * usual 30s) since this is what a warden is actively working through, not
 * just browsing. */
export async function listPendingGatePasses() {
  const actor = await requireRole(["warden", "admin"]);
  const supabase = await createClient();

  return getCached(pendingCacheKey(actor.collegeId), 15, async () => {
    const { data } = await supabase
      .from("gate_passes")
      .select("*, students:student_id(enrollment_number, profiles:user_id(full_name))")
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    return data || [];
  });
}

export async function listProcessedGatePasses(q: DataTableQuery) {
  const actor = await requireRole(["warden", "admin"]);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(PROCESSED_SORT_COLUMNS, "created_at", false, q);
  const cacheKey = listCacheKey(PROCESSED_CACHE_PREFIX, actor.collegeId, q, column);

  return getCached(cacheKey, 30, async () => {
    const { data, count } = await supabase
      .from("gate_passes")
      .select("*, students:student_id(enrollment_number, profiles:user_id(full_name))", { count: "exact" })
      .neq("status", "pending")
      .order(column, { ascending })
      .range(q.page * PROCESSED_PAGE_SIZE, q.page * PROCESSED_PAGE_SIZE + PROCESSED_PAGE_SIZE - 1);
    return { data: data || [], count: count ?? 0 };
  });
}

const ActOnGatePassSchema = z.object({
  passId: z.string().guid(),
  action: z.enum(["approved", "rejected"]),
});

/**
 * Shared by the web Server Action below and app/api/mobile/gatepass/act's
 * Route Handler — same guarded logic either way, just a different transport.
 */
export async function actOnGatePassCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  passId: string,
  action: "approved" | "rejected"
) {
  ({ passId, action } = ActOnGatePassSchema.parse({ passId, action }));
  await checkRateLimit(`actOnGatePass:${actor.userId}`, 30, 60);

  const { error } = await supabase
    .from("gate_passes")
    .update({
      status: action,
      approved_by: actor.userId,
      approved_at: new Date().toISOString(),
    })
    .eq("id", passId)
    .eq("college_id", actor.collegeId);

  if (error) {
    throw new Error(error.message);
  }
}

export async function actOnGatePass(
  passId: string,
  action: "approved" | "rejected",
  processedViewQuery?: DataTableQuery
) {
  const actor = await requireRole(["warden", "admin"]);
  const supabase = await createClient();
  await actOnGatePassCore(supabase, actor, passId, action);
  revalidatePath("/warden/gatepasses");

  await invalidateCache(pendingCacheKey(actor.collegeId));
  if (processedViewQuery) {
    const { column } = resolveListSort(PROCESSED_SORT_COLUMNS, "created_at", false, processedViewQuery);
    await invalidateCache(listCacheKey(PROCESSED_CACHE_PREFIX, actor.collegeId, processedViewQuery, column));
  }
}

/** Called by app/api/mobile/gatepass/act/route.ts. */
export async function actOnGatePassViaRequest(
  request: Request,
  passId: string,
  action: "approved" | "rejected"
) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["warden", "admin"]);
  await actOnGatePassCore(supabase, actor, passId, action);
}
