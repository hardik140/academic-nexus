"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache, middlewareProfileCacheKey } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertClaimed } from "@/lib/concurrent-claim";
import { PERMISSIONS } from "@/lib/permissions";
import { inviteUserCore, type InviteUserParams } from "@/lib/invitations";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// Roles eligible to be promoted directly into Placement Cell — mirrors
// assignHodCore's "must already hold an eligible role" guard
// (director/departments/actions.ts), narrowed to avoid accidentally
// demoting a director/warden/finance/hod account via this action.
const PROMOTABLE_ROLES = ["teacher", "admin"] as const;

/** Current Placement Cell users in the director's own college. */
export async function listPlacementCellUsers() {
  const actor = await requireRole(["director"]);
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, email, status, created_at")
    .eq("college_id", actor.collegeId)
    .eq("role", "placement_cell")
    .order("created_at", { ascending: false });
  return data || [];
}

/** Eligible existing staff who could be promoted into Placement Cell. */
export async function listPlacementCellCandidates() {
  const actor = await requireRole(["director"]);
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, email, role")
    .eq("college_id", actor.collegeId)
    .in("role", PROMOTABLE_ROLES)
    .order("full_name");
  return data || [];
}

const PromoteSchema = z.object({ userId: z.string().guid() });

/**
 * "Select existing college user" path — promotes an existing profile's
 * role directly to placement_cell (unlike HOD assignment, which points a
 * pointer FK at an unchanged role — Placement Cell's portal access needs
 * profiles.role itself to change, see the Placement Cell plan's "Role
 * model decision"). Never trusts the client-picked id: re-verified against
 * the director's own college and an eligible source role below.
 */
export async function promoteToPlacementCellCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  userIdRaw: string
) {
  const { userId } = PromoteSchema.parse({ userId: userIdRaw });
  await checkRateLimit(`promoteToPlacementCell:${actor.userId}`, 20, 60);

  const { data: candidate } = await supabase
    .from("profiles")
    .select("id, role, college_id")
    .eq("id", userId)
    .single();

  if (!candidate || candidate.college_id !== actor.collegeId) {
    throw new Error("Selected staff member not found in your college.");
  }
  if (!(PROMOTABLE_ROLES as readonly string[]).includes(candidate.role)) {
    throw new Error("Only teacher or admin staff can be promoted to Placement Cell.");
  }

  // Written through the SERVICE-ROLE client, not the director's own.
  //
  // `profiles` has exactly two UPDATE policies — profiles_update_self (own
  // row) and profiles_admin_manage (admin only). A director has NO update
  // path on profiles at all, so this write matched zero rows and returned
  // no error: promote/revoke/reactivate have silently done nothing since the
  // Placement Cell module shipped. Confirmed against the live database by
  // measuring affected rows, not the error value.
  //
  // Authorization is unchanged and still enforced in app code — the caller
  // already passed requireRole(PERMISSIONS.assign_placement_cell) (director
  // only) plus the college and promotable-role checks above. That is this
  // codebase's documented contract for the service-role client.
  //
  // .select("id") + assertClaimed is what stops this regressing into another
  // silent no-op if the policy situation changes again.
  const { data: promoted, error } = await createAdminClient()
    .from("profiles")
    .update({ role: "placement_cell", status: "active" })
    .eq("id", userId)
    .eq("college_id", actor.collegeId)
    .select("id");

  if (error) {
    throw new Error(error.message);
  }
  assertClaimed(promoted, "staff member");

  await invalidateCache(middlewareProfileCacheKey(userId));
  await logAudit(supabase, actor, "Promoted to Placement Cell", "profiles", userId);
}

export async function promoteToPlacementCell(userId: string) {
  const actor = await requireRole(PERMISSIONS.assign_placement_cell);
  const supabase = await createClient();
  await promoteToPlacementCellCore(supabase, actor, userId);
  revalidatePath("/director/placement-cell");
}

/**
 * "Invite new user" path — thin wrapper over the existing invitation
 * system's inviteUserCore (lib/invitations.ts), forcing role to
 * "placement_cell" server-side rather than trusting a client-supplied
 * role. Everything else (Supabase invite link, /auth/confirm,
 * accept-invite, migration 022's RLS) is already role-agnostic.
 */
export async function assignPlacementCell(params: Omit<InviteUserParams, "role">) {
  const actor = await requireRole(PERMISSIONS.assign_placement_cell);
  const supabase = await createClient();
  await inviteUserCore(supabase, actor, { ...params, role: "placement_cell" });
  revalidatePath("/director/placement-cell");
}

const RevokeSchema = z.object({ userId: z.string().guid() });

async function loadOwnedPlacementCellUser(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  userId: string
) {
  const { data: target } = await supabase
    .from("profiles")
    .select("id, role, college_id, status")
    .eq("id", userId)
    .single();

  if (!target || target.college_id !== actor.collegeId || target.role !== "placement_cell") {
    throw new Error("Placement Cell user not found in your college.");
  }
  return target;
}

/**
 * Revoke = deactivate, never delete — reuses the existing profiles.status
 * machinery exactly as-is (requireRole() already rejects non-'active'
 * profiles with INACTIVE), the same lever admin/users' updateUserStatus
 * already uses for other roles.
 */
export async function revokePlacementCellCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  userIdRaw: string
) {
  const { userId } = RevokeSchema.parse({ userId: userIdRaw });
  await checkRateLimit(`revokePlacementCell:${actor.userId}`, 20, 60);

  await loadOwnedPlacementCellUser(supabase, actor, userId);

  // Service-role write — see promoteToPlacementCellCore above for why a
  // director's own client cannot update another profile.
  const { data: revoked, error } = await createAdminClient()
    .from("profiles")
    .update({ status: "suspended" })
    .eq("id", userId)
    .eq("college_id", actor.collegeId)
    .select("id");

  if (error) {
    throw new Error(error.message);
  }
  assertClaimed(revoked, "Placement Cell user");

  await invalidateCache(middlewareProfileCacheKey(userId));
  await logAudit(supabase, actor, "Revoked Placement Cell access", "profiles", userId);
}

export async function revokePlacementCell(userId: string) {
  const actor = await requireRole(PERMISSIONS.revoke_placement_cell);
  const supabase = await createClient();
  await revokePlacementCellCore(supabase, actor, userId);
  revalidatePath("/director/placement-cell");
}

/** Re-assign = restore access for a previously revoked Placement Cell user. */
export async function reactivatePlacementCell(userId: string) {
  const actor = await requireRole(PERMISSIONS.assign_placement_cell);
  const supabase = await createClient();
  const { userId: validatedId } = RevokeSchema.parse({ userId });
  await checkRateLimit(`reactivatePlacementCell:${actor.userId}`, 20, 60);

  await loadOwnedPlacementCellUser(supabase, actor, validatedId);

  // Service-role write — see promoteToPlacementCellCore above.
  const { data: reactivated, error } = await createAdminClient()
    .from("profiles")
    .update({ status: "active" })
    .eq("id", validatedId)
    .eq("college_id", actor.collegeId)
    .select("id");

  if (error) {
    throw new Error(error.message);
  }
  assertClaimed(reactivated, "Placement Cell user");

  await invalidateCache(middlewareProfileCacheKey(validatedId));
  await logAudit(supabase, actor, "Re-activated Placement Cell access", "profiles", validatedId);
  revalidatePath("/director/placement-cell");
}

/**
 * Director oversight KPIs — read-only, college-scoped. Deliberately not
 * the same as Placement Cell's own operational dashboard: this is the
 * "separate Director oversight from Placement Cell operations" surface
 * from the plan, so it stays a handful of counts, not company/drive CRUD.
 */
export async function getPlacementOverview() {
  const actor = await requireRole(["director", "admin"]);
  const supabase = await createClient();

  return getCached(`placement:overview:${actor.collegeId}`, 60, async () => {
    const [summaryRes, companiesRes, activeDrivesRes, applicationsRes, cellRes] = await Promise.all([
      supabase.from("mv_placement_summary").select("*").maybeSingle(),
      supabase.from("companies").select("*", { count: "exact", head: true }).eq("college_id", actor.collegeId),
      supabase
        .from("placement_drives")
        .select("*", { count: "exact", head: true })
        .eq("college_id", actor.collegeId)
        .eq("status", "published"),
      supabase.from("placement_applications").select("*", { count: "exact", head: true }).eq("college_id", actor.collegeId),
      supabase
        .from("profiles")
        .select("*", { count: "exact", head: true })
        .eq("college_id", actor.collegeId)
        .eq("role", "placement_cell")
        .eq("status", "active"),
    ]);

    return {
      totalPlaced: summaryRes.data?.total_placed || 0,
      totalCompanies: companiesRes.count || 0,
      avgPackage: summaryRes.data?.avg_package || 0,
      activeDrives: activeDrivesRes.count || 0,
      totalApplications: applicationsRes.count || 0,
      activePlacementCellCount: cellRes.count || 0,
    };
  });
}
