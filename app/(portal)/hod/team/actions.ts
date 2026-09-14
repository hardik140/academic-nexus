"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { inviteUserCore, resendInvitationCore, revokeInvitationCore } from "@/lib/invitations";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { dbError } from "@/lib/internal-error";

const InviteTeacherSchema = z.object({
  email: z.string().trim().email({ message: "Enter a valid email address." }),
  fullName: z.string().trim().min(1, { message: "Full name is required." }).max(200),
  role: z.literal("teacher"),
});

const InviteStudentSchema = z.object({
  email: z.string().trim().email({ message: "Enter a valid email address." }),
  fullName: z.string().trim().min(1, { message: "Full name is required." }).max(200),
  role: z.literal("student"),
  enrollmentNumber: z.string().trim().min(1, { message: "Enrollment number is required." }).max(50),
  batchYear: z.number().int().min(1900).max(2200),
  parentName: z.string().trim().max(200).optional(),
  parentEmail: z.string().trim().max(200).optional(),
  parentPhone: z.string().trim().max(20).optional(),
});

const InviteHodTeamSchema = z.discriminatedUnion("role", [InviteTeacherSchema, InviteStudentSchema]);

export type InviteHodTeamParams = z.infer<typeof InviteHodTeamSchema>;

async function resolveHodDepartment(supabase: SupabaseClient<Database>, actor: AuthorizedActor) {
  // Resolved via departments.hod_id, NOT profiles.department_id — same
  // gotcha documented in hod/dashboard and hod/reports: assigning someone
  // as HOD doesn't set their own profile's department_id.
  const { data: department } = await supabase
    .from("departments")
    .select("id")
    .eq("hod_id", actor.userId)
    .single();
  if (!department) {
    throw new Error("You must be assigned as a department's HOD before inviting staff or students.");
  }
  return department.id;
}

/**
 * HOD's invite surface — HOD may invite Teachers or Students (see
 * lib/auth/invite-tiers.ts's INVITE_PERMISSIONS), always into their own
 * department, resolved server-side and never trusted from the client. A
 * student invite additionally creates the `students` row — inviteUserCore
 * alone only creates a `profiles` row, but `students.enrollment_number` /
 * `batch_year` / `department_id` are all NOT NULL, so a bare profile isn't
 * enough for that student's portal to actually work once they accept.
 * Teacher invites need nothing beyond the profile.
 */
async function inviteHodTeam(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  paramsRaw: InviteHodTeamParams
) {
  const params = InviteHodTeamSchema.parse(paramsRaw);
  const departmentId = await resolveHodDepartment(supabase, actor);

  const { userId } = await inviteUserCore(supabase, actor, {
    email: params.email,
    fullName: params.fullName,
    role: params.role,
    departmentId,
  });

  if (params.role === "student") {
    const { error } = await supabase.from("students").insert({
      college_id: actor.collegeId,
      user_id: userId,
      department_id: departmentId,
      enrollment_number: params.enrollmentNumber,
      batch_year: params.batchYear,
      parent_name: params.parentName || null,
      parent_email: params.parentEmail || null,
      parent_phone: params.parentPhone || null,
    });
    if (error) {
      throw dbError(error);
    }
  }
}

export async function inviteUser(params: InviteHodTeamParams) {
  const actor = await requireRole(["hod"]);
  const supabase = await createClient();
  await inviteHodTeam(supabase, actor, params);
  revalidatePath("/hod/team");
}

/** Called by app/api/mobile/hod/invite-user/route.ts. */
export async function inviteUserViaRequest(request: Request, params: InviteHodTeamParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["hod"]);
  await inviteHodTeam(supabase, actor, params);
}

export async function resendInvitation(invitationId: string) {
  const actor = await requireRole(["hod"]);
  const supabase = await createClient();
  await resendInvitationCore(supabase, actor, invitationId);
  revalidatePath("/hod/team");
}

/** Called by app/api/mobile/hod/invitations/resend/route.ts. */
export async function resendInvitationViaRequest(request: Request, invitationId: string) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["hod"]);
  await resendInvitationCore(supabase, actor, invitationId);
}

export async function revokeInvitation(invitationId: string) {
  const actor = await requireRole(["hod"]);
  const supabase = await createClient();
  await revokeInvitationCore(supabase, actor, invitationId);
  revalidatePath("/hod/team");
}

/** Called by app/api/mobile/hod/invitations/revoke/route.ts. */
export async function revokeInvitationViaRequest(request: Request, invitationId: string) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["hod"]);
  await revokeInvitationCore(supabase, actor, invitationId);
}
