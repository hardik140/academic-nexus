"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export interface CreateDepartmentParams {
  name: string;
  code: string;
  description: string;
}

/**
 * Shared by the web Server Action below and
 * app/api/mobile/admin/create-department's Route Handler.
 */
export async function createDepartmentCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: CreateDepartmentParams
) {
  const { error } = await supabase.from("departments").insert({
    college_id: actor.collegeId,
    name: params.name,
    code: params.code,
    description: params.description,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function createDepartment(params: CreateDepartmentParams) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();
  await createDepartmentCore(supabase, actor, params);
  revalidatePath("/admin/departments");
}

/** Called by app/api/mobile/admin/create-department/route.ts. */
export async function createDepartmentViaRequest(request: Request, params: CreateDepartmentParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["admin"]);
  await createDepartmentCore(supabase, actor, params);
}

/**
 * Shared by the web Server Action below and
 * app/api/mobile/admin/assign-hod's Route Handler.
 */
export async function assignHodCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  departmentId: string,
  hodUserId: string | null
) {
  // Verify the target profile is actually in this college and eligible
  // (hod or teacher role) before assigning — never trust the client-picked
  // id blindly, even though it came from a dropdown we populated ourselves.
  if (hodUserId) {
    const { data: candidate } = await supabase
      .from("profiles")
      .select("id, role, college_id")
      .eq("id", hodUserId)
      .single();

    if (!candidate || candidate.college_id !== actor.collegeId) {
      throw new Error("Selected staff member not found in your college.");
    }
    if (!["hod", "teacher"].includes(candidate.role)) {
      throw new Error("Only HOD or teacher staff can be assigned as department head.");
    }
  }

  const { error } = await supabase
    .from("departments")
    .update({ hod_id: hodUserId })
    .eq("id", departmentId)
    .eq("college_id", actor.collegeId);

  if (error) {
    throw new Error(error.message);
  }
}

export async function assignHod(departmentId: string, hodUserId: string | null) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();
  await assignHodCore(supabase, actor, departmentId, hodUserId);
  revalidatePath("/admin/departments");
}

/** Called by app/api/mobile/admin/assign-hod/route.ts. */
export async function assignHodViaRequest(request: Request, departmentId: string, hodUserId: string | null) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["admin"]);
  await assignHodCore(supabase, actor, departmentId, hodUserId);
}
