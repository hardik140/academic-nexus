import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, UserRole } from "@/types/database";
import type { AuthorizedActor } from "@/lib/rbac";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { canInvite } from "@/lib/auth/invite-tiers";
import { sendInvitationEmail } from "@/lib/email";

/**
 * Best-effort college-name lookup for the invitation email body. Never
 * blocks the invite on failure — a generic fallback is fine here, this is
 * cosmetic, not the security boundary.
 */
async function getCollegeName(supabase: SupabaseClient<Database>, collegeId: string): Promise<string> {
  const { data } = await supabase.from("colleges").select("name").eq("id", collegeId).single();
  return data?.name || "Academic Nexus";
}

const INVITABLE_ROLES = [
  "student",
  "teacher",
  "hod",
  "finance",
  "director",
  "admin",
  "warden",
  "placement_cell",
] as const;

const InviteUserSchema = z.object({
  email: z.string().trim().email({ message: "Enter a valid email address." }),
  fullName: z.string().trim().min(1, { message: "Full name is required." }).max(200),
  role: z.enum(INVITABLE_ROLES),
  collegeId: z.string().guid().optional(),
  departmentId: z.string().guid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const INVITE_REDIRECT_PATH = "/auth/callback?next=/auth/accept-invite";

/**
 * Builds the link that actually goes in the invitation email — points at
 * our own /auth/confirm (token_hash + verifyOtp), not GoTrue's hosted
 * action_link. See app/auth/confirm/route.ts for why: an admin-generated
 * link is opened by a browser that never initiated the request, so GoTrue's
 * hosted /verify redirect lands back here as an implicit-flow hash fragment
 * (#access_token=...), which never reaches /auth/callback's server-side
 * `?code=` check at all.
 */
function confirmLink(tokenHash: string, type: "invite"): string {
  const params = new URLSearchParams({ token_hash: tokenHash, type, next: "/auth/accept-invite" });
  return `${process.env.NEXT_PUBLIC_APP_URL}/auth/confirm?${params.toString()}`;
}

export interface InviteUserParams {
  email: string;
  fullName: string;
  role: Exclude<UserRole, "super_admin">;
  /** Only honored when actor.role === "super_admin" — required in that case
   * (inviting an Admin into the college they just created). Ignored, and
   * always overridden by the actor's own college, for every other role. */
  collegeId?: string;
  departmentId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Shared by every invite-capable tier's Server Action/Route Handler
 * (admin/users, director/team, hod/team, super-admin/colleges) — the
 * authorization logic is identical regardless of which tier calls it, so it
 * lives here once instead of four divergent copies. See
 * supabase/migrations/019_invitations_table.sql's header comment: Supabase
 * owns the real invitation token end-to-end — the `invitations` row this
 * writes is bookkeeping/audit only, not the security boundary.
 */
export async function inviteUserCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: InviteUserParams
) {
  const parsed = InviteUserSchema.parse(params);

  if (!canInvite(actor.role, parsed.role)) {
    throw new Error(`Your role can't invite a ${parsed.role}.`);
  }

  await checkRateLimit(`inviteUser:${actor.userId}`, 20, 60);

  // Never trust a client-supplied college for anyone but super_admin —
  // every other tier's invite is forced into their own college, matching
  // the assignHodCore/assignWardenCore "never trust client ids" precedent.
  let collegeId: string;
  if (actor.role === "super_admin") {
    if (!parsed.collegeId) {
      throw new Error("A college must be selected when inviting as Super Admin.");
    }
    collegeId = parsed.collegeId;
  } else {
    collegeId = actor.collegeId;
  }

  const admin = createAdminClient();
  // generateLink (not inviteUserByEmail) — it still creates the auth.users
  // row and still mints a real, Supabase-validated token exactly the same
  // way, but returns the action_link to app code instead of emailing it
  // via Supabase's own mailer, so we can send our own branded email via
  // nodemailer (lib/email.ts) instead. The security boundary is unchanged:
  // the link's token is still verified by Supabase itself at accept time.
  const { data: created, error: inviteErr } = await admin.auth.admin.generateLink({
    type: "invite",
    email: parsed.email,
    options: {
      data: {
        full_name: parsed.fullName,
        role: parsed.role,
        college_id: collegeId,
        status: "pending",
        invited_by: actor.userId,
      },
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}${INVITE_REDIRECT_PATH}`,
    },
  });

  if (inviteErr || !created.user) {
    throw new Error(inviteErr?.message || "Failed to create the invited account.");
  }

  if (parsed.departmentId) {
    await supabase.from("profiles").update({ department_id: parsed.departmentId }).eq("id", created.user.id);
  }

  const { error: insertErr } = await supabase.from("invitations").insert({
    college_id: collegeId,
    email: parsed.email,
    role: parsed.role,
    department_id: parsed.departmentId || null,
    invited_by: actor.userId,
    user_id: created.user.id,
    metadata: (parsed.metadata as Database["public"]["Tables"]["invitations"]["Insert"]["metadata"]) || null,
  });
  if (insertErr) {
    throw new Error(insertErr.message);
  }

  const collegeName = await getCollegeName(supabase, collegeId);
  await sendInvitationEmail({
    to: parsed.email,
    fullName: parsed.fullName,
    role: parsed.role,
    collegeName,
    actionLink: confirmLink(created.properties.hashed_token, "invite"),
  });

  await logAudit(supabase, actor, `Invited ${parsed.email} as ${parsed.role}`, "invitations", created.user.id);

  return { userId: created.user.id };
}

const InvitationIdSchema = z.object({ invitationId: z.string().guid() });

async function loadOwnedInvitation(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  invitationId: string
) {
  const { data: invitation, error } = await supabase
    .from("invitations")
    .select("id, email, role, college_id, invited_by, user_id, status")
    .eq("id", invitationId)
    .single();

  if (error || !invitation) {
    throw new Error("Invitation not found.");
  }
  if (invitation.invited_by !== actor.userId) {
    throw new Error("You can only manage invitations you sent.");
  }
  return invitation;
}

/**
 * Shared by every tier's resend Server Action/Route Handler. Deletes the
 * still-unconfirmed auth.users row and re-invites from scratch rather than
 * relying on inviteUserByEmail's undocumented behavior when called twice
 * for the same still-pending email — simpler to reason about, and safe
 * since no password was ever set on the account being replaced.
 */
export async function resendInvitationCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  invitationIdRaw: string
) {
  const { invitationId } = InvitationIdSchema.parse({ invitationId: invitationIdRaw });
  await checkRateLimit(`resendInvitation:${actor.userId}`, 10, 60);

  const invitation = await loadOwnedInvitation(supabase, actor, invitationId);
  if (invitation.status !== "pending") {
    throw new Error("Only a pending invitation can be resent.");
  }

  const admin = createAdminClient();
  if (invitation.user_id) {
    await admin.auth.admin.deleteUser(invitation.user_id);
  }

  const { data: created, error: inviteErr } = await admin.auth.admin.generateLink({
    type: "invite",
    email: invitation.email,
    options: {
      data: {
        role: invitation.role,
        college_id: invitation.college_id,
        status: "pending",
        invited_by: actor.userId,
      },
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}${INVITE_REDIRECT_PATH}`,
    },
  });
  if (inviteErr || !created.user) {
    throw new Error(inviteErr?.message || "Failed to resend invitation.");
  }

  const { error: updateErr } = await supabase
    .from("invitations")
    .update({
      user_id: created.user.id,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq("id", invitationId);
  if (updateErr) {
    throw new Error(updateErr.message);
  }

  // invitations doesn't store full_name (only the original inviteUserByEmail
  // call's user_metadata did) — "there" is a deliberately generic greeting
  // for the resend case rather than misusing the email address as a name.
  const collegeName = await getCollegeName(supabase, invitation.college_id);
  await sendInvitationEmail({
    to: invitation.email,
    fullName: "there",
    role: invitation.role,
    collegeName,
    actionLink: confirmLink(created.properties.hashed_token, "invite"),
  });

  await logAudit(supabase, actor, `Resent invitation to ${invitation.email}`, "invitations", invitationId);
}

/** Shared by every tier's revoke Server Action/Route Handler. */
export async function revokeInvitationCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  invitationIdRaw: string
) {
  const { invitationId } = InvitationIdSchema.parse({ invitationId: invitationIdRaw });

  const invitation = await loadOwnedInvitation(supabase, actor, invitationId);
  if (invitation.status !== "pending") {
    throw new Error("Only a pending invitation can be revoked.");
  }

  const admin = createAdminClient();
  if (invitation.user_id) {
    await admin.auth.admin.deleteUser(invitation.user_id);
  }

  const { error } = await supabase.from("invitations").update({ status: "revoked" }).eq("id", invitationId);
  if (error) {
    throw new Error(error.message);
  }

  await logAudit(supabase, actor, `Revoked invitation to ${invitation.email}`, "invitations", invitationId);
}
