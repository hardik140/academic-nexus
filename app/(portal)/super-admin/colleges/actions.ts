"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { logAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCacheFamily, versionedKey } from "@/lib/cache";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import { PLATFORM_COLLEGE_ID } from "@/lib/constants";
import { inviteUserCore, resendInvitationCore, revokeInvitationCore, type InviteUserParams } from "@/lib/invitations";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { DataTableQuery } from "@/components/ui/data-table";
import { dbError } from "@/lib/internal-error";
import { assertRead } from "@/lib/read-result-server";
import { callAccessRpc } from "@/lib/college-access";
import type { DeviceSession } from "@/components/portal/device-list";

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
  // Every super admin sees every college: the scope is the platform, not
  // the super admin's own (possibly empty) college id.
  const cacheKey = versionedKey(listCacheKey(COLLEGES_CACHE_PREFIX, "platform", q, column), COLLEGES_CACHE_PREFIX, "platform");

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

export async function createCollege(params: CreateCollegeParams) {
  const actor = await requireRole(["super_admin"]);
  const supabase = await createClient();
  const result = await createCollegeCore(supabase, actor, params);
  revalidatePath("/super-admin/colleges");
  await invalidateCacheFamily(COLLEGES_CACHE_PREFIX, "platform");
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

// ─── College lifecycle and Admin sessions (migrations 053/054) ───────────

const LifecycleSchema = z.object({
  collegeId: z.string().regex(/^[0-9a-f-]{36}$/i, { message: "Invalid college." }),
  state: z.enum(["ACTIVE", "MAINTENANCE", "SUSPENDED"]),
  reason: z.string().trim().min(10, { message: "Give a reason of at least 10 characters." }).max(1000),
  message: z.string().trim().max(500).optional(),
  expectedResumeAt: z.string().datetime({ offset: true }).optional(),
});

export type SetCollegeLifecycleParams = z.input<typeof LifecycleSchema>;

/**
 * Moves a college between ACTIVE, MAINTENANCE and SUSPENDED. The database
 * function is the authority (super_admin only, reason required, history and
 * audit written in the same transaction, the college's sessions revoked when
 * it leaves ACTIVE); this validates the shape first so the form can say what
 * is wrong, and refreshes the cached list.
 */
export async function setCollegeLifecycle(params: SetCollegeLifecycleParams) {
  const actor = await requireRole(["super_admin"]);
  const parsed = LifecycleSchema.parse(params);
  await checkRateLimit(`collegeLifecycle:${actor.userId}`, 20, 60);
  const supabase = await createClient();

  await callAccessRpc(
    supabase,
    "set_college_lifecycle",
    {
      p_college_id: parsed.collegeId,
      p_state: parsed.state,
      p_reason: parsed.reason,
      p_message: parsed.state === "ACTIVE" ? null : parsed.message || null,
      p_expected_resume_at: parsed.state === "MAINTENANCE" ? parsed.expectedResumeAt ?? null : null,
    },
    "The college's status couldn't be changed."
  );

  revalidatePath("/super-admin/colleges");
  await invalidateCacheFamily(COLLEGES_CACHE_PREFIX, "platform");
}

export interface LifecycleEvent {
  id: string;
  previous_state: string;
  new_state: string;
  reason: string;
  message: string | null;
  expected_resume_at: string | null;
  sessions_revoked: number;
  changed_by: string;
  changed_at: string;
}

/** The college's lifecycle history, newest first (super_admin-only RLS). */
export async function listCollegeLifecycleHistory(collegeId: string): Promise<LifecycleEvent[]> {
  await requireRole(["super_admin"]);
  const id = LifecycleSchema.shape.collegeId.parse(collegeId);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("college_lifecycle_events")
    .select("id, previous_state, new_state, reason, message, expected_resume_at, sessions_revoked, changed_by, changed_at")
    .eq("college_id", id)
    .order("changed_at", { ascending: false })
    .limit(100);
  assertRead(error);
  return (data ?? []) as LifecycleEvent[];
}

/**
 * The active sessions of a college's Admin accounts — the only accounts
 * super_admin manages (migration 020's scope, kept by 054's RLS).
 */
export async function listCollegeAdminSessions(collegeId: string): Promise<DeviceSession[]> {
  await requireRole(["super_admin"]);
  const id = LifecycleSchema.shape.collegeId.parse(collegeId);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_sessions")
    .select("session_id, client, device_label, status, created_at, last_seen_at, profiles:user_id(full_name)")
    .eq("college_id", id)
    .eq("status", "active")
    .order("last_seen_at", { ascending: false });
  assertRead(error);
  return ((data ?? []) as unknown as Array<DeviceSession & { profiles: { full_name: string | null } | null }>).map((s) => ({
    ...s,
    device_label: [s.profiles?.full_name, s.device_label].filter(Boolean).join(" — ") || null,
  }));
}

export async function revokeAdminSession(sessionId: string): Promise<void> {
  await requireRole(["super_admin"]);
  const id = LifecycleSchema.shape.collegeId.parse(sessionId);
  const supabase = await createClient();
  await callAccessRpc(supabase, "revoke_session", { p_session_id: id }, "That session couldn't be signed out.");
}
