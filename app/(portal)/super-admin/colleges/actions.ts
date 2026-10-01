"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { logAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import { PLATFORM_COLLEGE_ID } from "@/lib/constants";
import { inviteUserCore, resendInvitationCore, revokeInvitationCore, type InviteUserParams } from "@/lib/invitations";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { DataTableQuery } from "@/components/ui/data-table";
import { dbError } from "@/lib/internal-error";
import { assertRead } from "@/lib/read-result-server";

const COLLEGES_PAGE_SIZE = 10;
const COLLEGES_SORT_COLUMNS = ["name", "code"] as const;
const COLLEGES_CACHE_PREFIX = "list:colleges";

/**
 * super_admin's actor.collegeId is always the platform placeholder (they
 * aren't scoped to any real tenant — migration 018), so this cache key is
 * effectively one shared entry across every super_admin viewing the same
 * platform-wide list, which is exactly the right scope here.
 */
export async function listColleges(q: DataTableQuery) {
  const actor = await requireRole(["super_admin"]);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(COLLEGES_SORT_COLUMNS, "created_at", false, q);
  const cacheKey = listCacheKey(COLLEGES_CACHE_PREFIX, actor.collegeId, q, column);

  return getCached(cacheKey, 30, async () => {
    let dbQuery = supabase
      .from("colleges")
      .select("*", { count: "exact" })
      .neq("id", PLATFORM_COLLEGE_ID);

    if (q.search) dbQuery = dbQuery.ilike("name", `%${q.search}%`);
    dbQuery = dbQuery.order(column, { ascending });

    const from = q.page * COLLEGES_PAGE_SIZE;
    const { data, count, error: dataError } = await dbQuery.range(from, from + COLLEGES_PAGE_SIZE - 1);
    assertRead(dataError);
    return { data: data || [], count: count ?? 0 };
  });
}

const CreateCollegeSchema = z.object({
  name: z.string().trim().min(1, { message: "College name is required." }).max(200),
  code: z.string().trim().min(1, { message: "College code is required." }).max(50),
  country: z.string().trim().max(100).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
});

export interface CreateCollegeParams {
  name: string;
  code: string;
  country?: string;
  city?: string;
  state?: string;
}

/**
 * Shared by the web Server Action below and
 * app/api/mobile/super-admin/create-college's Route Handler. Uses the
 * actor's own RLS-scoped client (colleges_super_admin_insert, migration
 * 020) rather than the service-role client — super_admin is already
 * allowed to make this insert directly, no need to bypass RLS for it.
 */
export async function createCollegeCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: CreateCollegeParams
) {
  const parsed = CreateCollegeSchema.parse(params);
  await checkRateLimit(`createCollege:${actor.userId}`, 5, 60);

  const { data: college, error } = await supabase
    .from("colleges")
    .insert({
      name: parsed.name,
      code: parsed.code,
      country: parsed.country || "India",
      city: parsed.city || null,
      state: parsed.state || null,
      created_by: actor.userId,
    })
    .select("id")
    .single();

  if (error || !college) {
    throw dbError({ ...error, message: error?.message || "Failed to create college." });
  }

  await logAudit(supabase, actor, `Created college ${parsed.code} — ${parsed.name}`, "colleges", college.id);

  return { collegeId: college.id };
}

export async function createCollege(params: CreateCollegeParams, viewQuery?: DataTableQuery) {
  const actor = await requireRole(["super_admin"]);
  const supabase = await createClient();
  const result = await createCollegeCore(supabase, actor, params);
  revalidatePath("/super-admin/colleges");
  if (viewQuery) {
    const { column } = resolveListSort(COLLEGES_SORT_COLUMNS, "created_at", false, viewQuery);
    await invalidateCache(listCacheKey(COLLEGES_CACHE_PREFIX, actor.collegeId, viewQuery, column));
  }
  return result;
}

/** Called by app/api/mobile/super-admin/create-college/route.ts. */
export async function createCollegeViaRequest(request: Request, params: CreateCollegeParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["super_admin"]);
  return createCollegeCore(supabase, actor, params);
}

/**
 * Super Admin invites a college's first Admin — reuses the shared
 * inviteUserCore (lib/invitations.ts), which requires collegeId explicitly
 * when the actor is super_admin (it never defaults to the platform
 * placeholder college).
 */
export async function inviteUser(params: InviteUserParams) {
  const actor = await requireRole(["super_admin"]);
  const supabase = await createClient();
  await inviteUserCore(supabase, actor, params);
  revalidatePath("/super-admin/colleges");
}

/** Called by app/api/mobile/super-admin/invite-user/route.ts. */
export async function inviteUserViaRequest(request: Request, params: InviteUserParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["super_admin"]);
  await inviteUserCore(supabase, actor, params);
}

export async function resendInvitation(invitationId: string) {
  const actor = await requireRole(["super_admin"]);
  const supabase = await createClient();
  await resendInvitationCore(supabase, actor, invitationId);
  revalidatePath("/super-admin/colleges");
}

export async function revokeInvitation(invitationId: string) {
  const actor = await requireRole(["super_admin"]);
  const supabase = await createClient();
  await revokeInvitationCore(supabase, actor, invitationId);
  revalidatePath("/super-admin/colleges");
}
