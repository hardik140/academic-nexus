"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { PERMISSIONS } from "@/lib/permissions";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const AssignHodSchema = z.object({
  departmentId: z.string().guid(),
  hodUserId: z.string().guid().nullable(),
});

/**
 * Moved here from admin/departments/actions.ts — HOD assignment is a
 * Director-level institutional decision, not a college-admin one (business
 * rule confirmed directly, not assumed; college-admin previously had this
 * capability and it's being removed, not just relabeled). Shared by the web
 * Server Action below and app/api/mobile/director/assign-hod's Route Handler.
 */
export async function assignHodCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  departmentId: string,
  hodUserId: string | null
) {
  ({ departmentId, hodUserId } = AssignHodSchema.parse({ departmentId, hodUserId }));
  await checkRateLimit(`assignHod:${actor.userId}`, 20, 60);

  // Verify the target department actually belongs to this director's own
  // college before touching it — never trust a client-picked id blindly,
  // even one that came from a dropdown we populated ourselves.
  const { data: department } = await supabase
    .from("departments")
    .select("id, college_id")
    .eq("id", departmentId)
    .single();

  if (!department || department.college_id !== actor.collegeId) {
    throw new Error("Department not found in your college.");
  }

  // Same for the candidate HOD: must be in this director's college and
  // hold an eligible role.
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
  const actor = await requireRole(PERMISSIONS.assign_hod);
  const supabase = await createClient();
  await assignHodCore(supabase, actor, departmentId, hodUserId);
  revalidatePath("/director/departments");
  revalidatePath("/director/dashboard");
}

/** Called by app/api/mobile/director/assign-hod/route.ts. */
export async function assignHodViaRequest(request: Request, departmentId: string, hodUserId: string | null) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, PERMISSIONS.assign_hod);
  await assignHodCore(supabase, actor, departmentId, hodUserId);
}

/** For the director/departments page's HOD-picker dropdown — eligible
 * (hod or teacher role) staff in the director's own college. */
export async function listEligibleHodCandidates() {
  const actor = await requireRole(["director"]);
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .eq("college_id", actor.collegeId)
    .in("role", ["hod", "teacher"])
    .order("full_name");
  return data || [];
}
