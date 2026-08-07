"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/rbac";
import { logAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import type { UserRole, UserStatus } from "@/types/database";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createUser(
  email: string,
  fullName: string,
  role: UserRole,
  departmentId?: string
) {
  const actor = await requireRole(["admin"]);
  await checkRateLimit(`createUser:${actor.userId}`, 20, 60);

  if (!EMAIL_RE.test(email)) {
    throw new Error("Enter a valid email address.");
  }
  if (!fullName.trim()) {
    throw new Error("Full name is required.");
  }

  const admin = createAdminClient();
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: fullName, role, college_id: actor.collegeId },
  });
  if (createErr || !created.user) {
    throw new Error(createErr?.message || "Failed to create user.");
  }

  const supabase = await createClient();

  if (departmentId) {
    await supabase.from("profiles").update({ department_id: departmentId }).eq("id", created.user.id);
  }

  await logAudit(supabase, actor, `Created user ${email} (${role})`, "profiles", created.user.id);

  revalidatePath("/admin/users");
}

export async function updateUserProfile(
  targetUserId: string,
  fullName: string,
  role: UserRole,
  phone?: string
) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();

  if (!fullName.trim()) {
    throw new Error("Full name is required.");
  }

  await supabase
    .from("profiles")
    .update({ full_name: fullName, role, phone: phone || null })
    .eq("id", targetUserId)
    .eq("college_id", actor.collegeId);

  await logAudit(supabase, actor, `Updated profile (role: ${role})`, "profiles", targetUserId);

  revalidatePath("/admin/users");
}

export async function updateUserStatus(targetUserId: string, status: UserStatus) {
  const actor = await requireRole(["admin"]);

  if (targetUserId === actor.userId && status !== "active") {
    throw new Error("You can't suspend your own account.");
  }

  const supabase = await createClient();

  await supabase
    .from("profiles")
    .update({ status })
    .eq("id", targetUserId)
    .eq("college_id", actor.collegeId);

  await logAudit(supabase, actor, `Changed status to ${status}`, "profiles", targetUserId);

  revalidatePath("/admin/users");
}
