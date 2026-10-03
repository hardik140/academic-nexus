"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { inviteUserCore, resendInvitationCore, revokeInvitationCore } from "@/lib/invitations";
import { inviteStudentCore, StudentInviteSchema } from "@/lib/student-invitations";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { assertRead } from "@/lib/read-result-server";

const InviteTeacherSchema = z.object({
  email: z.string().trim().email({ message: "Enter a valid email address." }),
  fullName: z.string().trim().min(1, { message: "Full name is required." }).max(200),
  role: z.literal("teacher"),
});

// The student's department, programme and batch year are NOT form fields:
// they are resolved by the database from the section (migration 055 §14).
const InviteStudentSchema = StudentInviteSchema.extend({ role: z.literal("student") });

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
 * department, resolved server-side and never trusted from the client.
 *
 * A student invitation goes through inviteStudentCore (lib/student-
 * invitations.ts): the HOD picks a SECTION of their department and the
 * database resolves everything else, checks the HOD heads that section's
 * department, and records the placement before any email is sent. The old
 * path inserted the `students` row directly at invite time, which RLS
 * refuses for an HOD (students_admin_manage is admin-only), so it failed
 * after the account had already been created — defect 1 of the contract.
 */
async function inviteHodTeam(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  paramsRaw: InviteHodTeamParams
) {
  const params = InviteHodTeamSchema.parse(paramsRaw);

  if (params.role === "student") {
    const { role: _role, ...student } = params;
    void _role;
    await inviteStudentCore(supabase, actor, student);
    return;
  }

  const departmentId = await resolveHodDepartment(supabase, actor);
  await inviteUserCore(supabase, actor, {
    email: params.email,
    fullName: params.fullName,
    role: params.role,
    departmentId,
  });
}

/**
 * The sections an HOD may invite a student into: the active sections of the
 * departments they head, each with its programme's length (the semester
 * choices). The database re-checks the choice when the invitation is made.
 */
export async function listInviteSections(): Promise<{ id: string; label: string; duration: number }[]> {
  const actor = await requireRole(["hod"]);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sections")
    .select("id, name, batch_year, programmes:programme_id!inner(code, duration_semesters, departments:department_id!inner(hod_id))")
    .eq("programmes.departments.hod_id", actor.userId)
    .eq("status", "active");
  assertRead(error);
  return ((data ?? []) as unknown as { id: string; name: string; batch_year: number; programmes: { code: string; duration_semesters: number } }[])
    .map((s) => ({ id: s.id, label: `${s.programmes.code} ${s.name} (${s.batch_year})`, duration: s.programmes.duration_semesters }))
    .sort((a, b) => a.label.localeCompare(b.label));
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
