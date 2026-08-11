"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { logAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { inviteUserCore, resendInvitationCore, revokeInvitationCore, type InviteUserParams } from "@/lib/invitations";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

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
    throw new Error(error?.message || "Failed to create college.");
  }

  await logAudit(supabase, actor, `Created college ${parsed.code} — ${parsed.name}`, "colleges", college.id);

  return { collegeId: college.id };
}

export async function createCollege(params: CreateCollegeParams) {
  const actor = await requireRole(["super_admin"]);
  const supabase = await createClient();
  const result = await createCollegeCore(supabase, actor, params);
  revalidatePath("/super-admin/colleges");
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
