"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest } from "@/lib/rbac";
import { inviteUserCore, resendInvitationCore, revokeInvitationCore, type InviteUserParams } from "@/lib/invitations";

/**
 * Director's invite surface — Director may invite Finance, HOD, or Warden
 * (see lib/auth/invite-tiers.ts's INVITE_PERMISSIONS). Director had no
 * user-management pages before this; this is the first one.
 */
export async function inviteUser(params: InviteUserParams) {
  const actor = await requireRole(["director"]);
  const supabase = await createClient();
  await inviteUserCore(supabase, actor, params);
  revalidatePath("/director/team");
}

/** Called by app/api/mobile/director/invite-user/route.ts. */
export async function inviteUserViaRequest(request: Request, params: InviteUserParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["director"]);
  await inviteUserCore(supabase, actor, params);
}

export async function resendInvitation(invitationId: string) {
  const actor = await requireRole(["director"]);
  const supabase = await createClient();
  await resendInvitationCore(supabase, actor, invitationId);
  revalidatePath("/director/team");
}

/** Called by app/api/mobile/director/invitations/resend/route.ts. */
export async function resendInvitationViaRequest(request: Request, invitationId: string) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["director"]);
  await resendInvitationCore(supabase, actor, invitationId);
}

export async function revokeInvitation(invitationId: string) {
  const actor = await requireRole(["director"]);
  const supabase = await createClient();
  await revokeInvitationCore(supabase, actor, invitationId);
  revalidatePath("/director/team");
}

/** Called by app/api/mobile/director/invitations/revoke/route.ts. */
export async function revokeInvitationViaRequest(request: Request, invitationId: string) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["director"]);
  await revokeInvitationCore(supabase, actor, invitationId);
}
