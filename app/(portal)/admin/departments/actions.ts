"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const CreateDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().min(1).max(50),
  description: z.string().trim().max(2000),
});

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
  const { name, code, description } = CreateDepartmentSchema.parse(params);
  await checkRateLimit(`createDepartment:${actor.userId}`, 20, 60);

  const { error } = await supabase.from("departments").insert({
    college_id: actor.collegeId,
    name,
    code,
    description,
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

const AssignHodSchema = z.object({
  departmentId: z.string().guid(),
  hodUserId: z.string().guid().nullable(),
});

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
  ({ departmentId, hodUserId } = AssignHodSchema.parse({ departmentId, hodUserId }));
  await checkRateLimit(`assignHod:${actor.userId}`, 20, 60);

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
