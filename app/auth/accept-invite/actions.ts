"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/audit";
import { dashboardPathFor } from "@/lib/auth/role-routes";
import { invalidateCache, middlewareProfileCacheKey } from "@/lib/cache";

const AcceptInvitationSchema = z.object({
  password: z.string().min(8, { message: "Password must be at least 8 characters." }).max(200),
});

/**
 * Completes onboarding for an invited user who just clicked their email
 * link and landed here with a live (but 'pending') Supabase session.
 * Re-validates everything server-side against that session rather than
 * trusting anything client-supplied — same "never trust client state,
 * re-fetch and re-check" precedent as assignHodCore/assignWardenCore.
 */
export async function acceptInvitation(password: string) {
  const { password: validPassword } = AcceptInvitationSchema.parse({ password });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("Your session has expired. Open the invitation email link again.");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role, college_id, status")
    .eq("id", user.id)
    .single();

  if (!profile) {
    throw new Error("No invitation found for this account.");
  }
  if (profile.status !== "pending") {
    throw new Error("This invitation has already been accepted — sign in normally instead.");
  }

  // This lookup is scoped to the authenticated user's exact id. Use the
  // server-only client so onboarding does not fail closed when an older
  // deployment has not yet applied the invitee SELECT RLS migration.
  const admin = createAdminClient();
  const { data: invitation, error: invitationLookupError } = await admin
    .from("invitations")
    .select("id, expires_at")
    .eq("user_id", user.id)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (invitationLookupError) {
    throw new Error(`Unable to load your invitation. ${invitationLookupError.message}`);
  }

  if (!invitation) {
    throw new Error("No pending invitation found for this account.");
  }
  if (new Date(invitation.expires_at) < new Date()) {
    throw new Error("This invitation has expired. Ask whoever invited you to resend it.");
  }

  const { error: passwordErr } = await supabase.auth.updateUser({ password: validPassword });
  if (passwordErr) {
    throw new Error(passwordErr.message);
  }

  const { error: profileErr } = await supabase
    .from("profiles")
    .update({ status: "active" })
    .eq("id", user.id);
  if (profileErr) {
    throw new Error(profileErr.message);
  }
  // Belt-and-suspenders: /auth/accept-invite is a public route, so
  // middleware never cached this user's (still-pending) profile in the
  // first place — the redirect below will populate the cache fresh either
  // way. Invalidating anyway costs nothing and removes any doubt.
  await invalidateCache(middlewareProfileCacheKey(user.id));

  const { error: invitationErr } = await admin
    .from("invitations")
    .update({ status: "accepted", accepted_at: new Date().toISOString(), accepted_by: user.id })
    .eq("id", invitation.id);
  if (invitationErr) {
    throw new Error(invitationErr.message);
  }

  await logAudit(
    supabase,
    { userId: user.id, role: profile.role, collegeId: profile.college_id },
    "Accepted invitation",
    "invitations",
    invitation.id
  );

  redirect(dashboardPathFor(profile.role));
}
