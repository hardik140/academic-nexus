"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { logAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { inviteUserCore, resendInvitationCore, revokeInvitationCore, type InviteUserParams } from "@/lib/invitations";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, UserRole, UserStatus } from "@/types/database";

// Deliberately excludes "super_admin" — this is the only thing standing
// between an admin's "edit role" form and the DB write once UserRole grows
// to include it. Also excludes "parent" (a valid DB-level role via a CHECK
// constraint, but with no app-layer support anywhere — see the "parent"
// gap noted throughout lib/rbac.ts-adjacent code). Do not widen this to
// UserRole directly.
const USER_ROLES = ["student", "teacher", "hod", "finance", "director", "admin", "warden"] as const;
const USER_STATUSES = ["active", "suspended", "pending", "graduated", "alumni"] as const;

/**
 * Shared by the web Server Action below and
 * app/api/mobile/admin/invite-user's Route Handler. The actual invite logic
 * (Zod validation, invite-tier check, rate limiting, inviteUserByEmail,
 * bookkeeping insert, audit log) lives in lib/invitations.ts's
 * inviteUserCore, shared across every invite-capable tier.
 */
export async function inviteUser(params: InviteUserParams) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();
  await inviteUserCore(supabase, actor, params);
  revalidatePath("/admin/users");
}

/** Called by app/api/mobile/admin/invite-user/route.ts. */
export async function inviteUserViaRequest(request: Request, params: InviteUserParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["admin"]);
  await inviteUserCore(supabase, actor, params);
}

export async function resendInvitation(invitationId: string) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();
  await resendInvitationCore(supabase, actor, invitationId);
  revalidatePath("/admin/users");
}

/** Called by app/api/mobile/admin/invitations/resend/route.ts. */
export async function resendInvitationViaRequest(request: Request, invitationId: string) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["admin"]);
  await resendInvitationCore(supabase, actor, invitationId);
}

export async function revokeInvitation(invitationId: string) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();
  await revokeInvitationCore(supabase, actor, invitationId);
  revalidatePath("/admin/users");
}

/** Called by app/api/mobile/admin/invitations/revoke/route.ts. */
export async function revokeInvitationViaRequest(request: Request, invitationId: string) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["admin"]);
  await revokeInvitationCore(supabase, actor, invitationId);
}

const UpdateUserProfileSchema = z.object({
  targetUserId: z.string().guid(),
  fullName: z.string().trim().min(1, { message: "Full name is required." }).max(200),
  role: z.enum(USER_ROLES),
  phone: z.string().trim().max(20).optional(),
});

export interface UpdateUserProfileParams {
  targetUserId: string;
  fullName: string;
  role: UserRole;
  phone?: string;
}

/**
 * Shared by the web Server Action below and
 * app/api/mobile/admin/update-user's Route Handler.
 */
export async function updateUserProfileCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: UpdateUserProfileParams
) {
  const { targetUserId, fullName, role, phone } = UpdateUserProfileSchema.parse(params);
  await checkRateLimit(`updateUserProfile:${actor.userId}`, 20, 60);

  await supabase
    .from("profiles")
    .update({ full_name: fullName, role, phone: phone || null })
    .eq("id", targetUserId)
    .eq("college_id", actor.collegeId);

  await logAudit(supabase, actor, `Updated profile (role: ${role})`, "profiles", targetUserId);
}

export async function updateUserProfile(
  targetUserId: string,
  fullName: string,
  role: UserRole,
  phone?: string
) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();
  await updateUserProfileCore(supabase, actor, { targetUserId, fullName, role, phone });
  revalidatePath("/admin/users");
}

/** Called by app/api/mobile/admin/update-user/route.ts. */
export async function updateUserProfileViaRequest(request: Request, params: UpdateUserProfileParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["admin"]);
  await updateUserProfileCore(supabase, actor, params);
}

const UpdateUserStatusSchema = z.object({
  targetUserId: z.string().guid(),
  status: z.enum(USER_STATUSES),
});

/**
 * Shared by the web Server Action below and
 * app/api/mobile/admin/user-status's Route Handler.
 */
export async function updateUserStatusCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  targetUserId: string,
  status: UserStatus
) {
  ({ targetUserId, status } = UpdateUserStatusSchema.parse({ targetUserId, status }));
  await checkRateLimit(`updateUserStatus:${actor.userId}`, 20, 60);

  if (targetUserId === actor.userId && status !== "active") {
    throw new Error("You can't suspend your own account.");
  }

  await supabase
    .from("profiles")
    .update({ status })
    .eq("id", targetUserId)
    .eq("college_id", actor.collegeId);

  await logAudit(supabase, actor, `Changed status to ${status}`, "profiles", targetUserId);
}

export async function updateUserStatus(targetUserId: string, status: UserStatus) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();
  await updateUserStatusCore(supabase, actor, targetUserId, status);
  revalidatePath("/admin/users");
}

/** Called by app/api/mobile/admin/user-status/route.ts. */
export async function updateUserStatusViaRequest(request: Request, targetUserId: string, status: UserStatus) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["admin"]);
  await updateUserStatusCore(supabase, actor, targetUserId, status);
}
