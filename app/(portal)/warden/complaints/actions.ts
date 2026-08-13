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

const COMPLAINTS_PAGE_SIZE = 10;
const COMPLAINTS_SORT_COLUMNS = ["title"] as const;
const COMPLAINTS_CACHE_PREFIX = "list:hostel-complaints";
const HOSTEL_CATEGORIES = ["hostel", "mess", "plumbing", "electrical", "ac_hvac", "carpentry", "cleaning", "safety"] as const;

export async function listHostelComplaints(q: DataTableQuery) {
  const actor = await requireRole(["warden", "admin"]);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(COMPLAINTS_SORT_COLUMNS, "created_at", false, q);
  const cacheKey = listCacheKey(COMPLAINTS_CACHE_PREFIX, actor.collegeId, q, column);

  return getCached(cacheKey, 30, async () => {
    let dbQuery = supabase
      .from("complaints")
      .select("*, profiles:submitted_by(full_name)", { count: "exact" })
      .in("category", HOSTEL_CATEGORIES);

    if (q.search) dbQuery = dbQuery.ilike("title", `%${q.search}%`);
    dbQuery = dbQuery.order(column, { ascending });

    const from = q.page * COMPLAINTS_PAGE_SIZE;
    const { data, count } = await dbQuery.range(from, from + COMPLAINTS_PAGE_SIZE - 1);
    return { data: data || [], count: count ?? 0 };
  });
}

const UpdateComplaintStatusSchema = z.object({
  complaintId: z.string().guid(),
  status: z.enum(["in_progress", "resolved"]),
});

/**
 * Shared by the web Server Action below and app/api/mobile/complaints/status's
 * Route Handler — same guarded logic either way, just a different transport.
 */
export async function updateComplaintStatusCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  complaintId: string,
  status: "in_progress" | "resolved"
) {
  ({ complaintId, status } = UpdateComplaintStatusSchema.parse({ complaintId, status }));
  await checkRateLimit(`updateComplaintStatus:${actor.userId}`, 30, 60);

  const { error } = await supabase
    .from("complaints")
    .update({
      status,
      resolved_at: status === "resolved" ? new Date().toISOString() : null,
    })
    .eq("id", complaintId)
    .eq("college_id", actor.collegeId);

  if (error) {
    throw new Error(error.message);
  }
}

export async function updateComplaintStatus(
  complaintId: string,
  status: "in_progress" | "resolved",
  viewQuery?: DataTableQuery
) {
  const actor = await requireRole(["warden", "admin"]);
  const supabase = await createClient();
  await updateComplaintStatusCore(supabase, actor, complaintId, status);
  revalidatePath("/warden/complaints");
  if (viewQuery) {
    const { column } = resolveListSort(COMPLAINTS_SORT_COLUMNS, "created_at", false, viewQuery);
    await invalidateCache(listCacheKey(COMPLAINTS_CACHE_PREFIX, actor.collegeId, viewQuery, column));
  }
}

/** Called by app/api/mobile/complaints/status/route.ts. */
export async function updateComplaintStatusViaRequest(
  request: Request,
  complaintId: string,
  status: "in_progress" | "resolved"
) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["warden", "admin"]);
  await updateComplaintStatusCore(supabase, actor, complaintId, status);
}
