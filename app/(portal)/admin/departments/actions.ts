"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { checkRateLimit } from "@/lib/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { dbError } from "@/lib/internal-error";

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
    throw dbError(error);
  }
}

export async function createDepartment(params: CreateDepartmentParams) {
  const actor = await requireRole(PERMISSIONS.create_department);
  const supabase = await createClient();
  await createDepartmentCore(supabase, actor, params);
  revalidatePath("/admin/departments");
  revalidatePath("/director/departments");
}

/** Called by app/api/mobile/admin/create-department/route.ts. */
export async function createDepartmentViaRequest(request: Request, params: CreateDepartmentParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, PERMISSIONS.create_department);
  await createDepartmentCore(supabase, actor, params);
}

// HOD assignment moved to app/(portal)/director/departments/actions.ts —
// it's a Director-level institutional decision, not a college-admin one.
// See that file for assignHod/assignHodCore/assignHodViaRequest.
