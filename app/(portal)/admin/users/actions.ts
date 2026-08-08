"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { logAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, UserRole, UserStatus } from "@/types/database";

const USER_ROLES = ["student", "teacher", "hod", "finance", "director", "admin", "warden"] as const;
const USER_STATUSES = ["active", "suspended", "pending", "graduated", "alumni"] as const;

const CreateUserSchema = z.object({
  email: z.string().trim().email({ message: "Enter a valid email address." }),
  fullName: z.string().trim().min(1, { message: "Full name is required." }).max(200),
  role: z.enum(USER_ROLES),
  departmentId: z.string().uuid().optional(),
});

export interface CreateUserParams {
  email: string;
  fullName: string;
  role: UserRole;
  departmentId?: string;
}

/**
 * Shared by the web Server Action below and app/api/mobile/admin/create-user's
 * Route Handler — same guarded logic either way, just a different transport.
 * The service-role admin client stays entirely server-side either way; the
 * mobile app only ever sees this guarded HTTP endpoint, never the key itself.
 */
export async function createUserCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: CreateUserParams
) {
  const { email, fullName, role, departmentId } = CreateUserSchema.parse(params);

  const admin = createAdminClient();
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: fullName, role, college_id: actor.collegeId },
  });
  if (createErr || !created.user) {
    throw new Error(createErr?.message || "Failed to create user.");
  }

  if (departmentId) {
    await supabase.from("profiles").update({ department_id: departmentId }).eq("id", created.user.id);
  }

  await logAudit(supabase, actor, `Created user ${email} (${role})`, "profiles", created.user.id);
}

export async function createUser(
  email: string,
  fullName: string,
  role: UserRole,
  departmentId?: string
) {
  const actor = await requireRole(["admin"]);
  await checkRateLimit(`createUser:${actor.userId}`, 20, 60);
  const supabase = await createClient();
  await createUserCore(supabase, actor, { email, fullName, role, departmentId });
  revalidatePath("/admin/users");
}

/** Called by app/api/mobile/admin/create-user/route.ts. */
export async function createUserViaRequest(request: Request, params: CreateUserParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["admin"]);
  await checkRateLimit(`createUser:${actor.userId}`, 20, 60);
  await createUserCore(supabase, actor, params);
}

const UpdateUserProfileSchema = z.object({
  targetUserId: z.string().uuid(),
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
  targetUserId: z.string().uuid(),
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
