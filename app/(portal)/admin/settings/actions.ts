"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { logAudit } from "@/lib/audit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export interface CollegeSettingsUpdate {
  name: string;
  code: string;
  domain?: string;
  accreditation?: string;
  established_year?: number;
  email?: string;
  phone?: string;
  website?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
}

/**
 * Shared by the web Server Action below and
 * app/api/mobile/admin/update-college's Route Handler.
 */
export async function updateCollegeCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  fields: CollegeSettingsUpdate
) {
  if (!fields.name.trim() || !fields.code.trim()) {
    throw new Error("Institution name and code are required.");
  }

  const { error } = await supabase
    .from("colleges")
    .update({
      name: fields.name,
      code: fields.code,
      domain: fields.domain || null,
      accreditation: fields.accreditation || null,
      established_year: fields.established_year || null,
      email: fields.email || null,
      phone: fields.phone || null,
      website: fields.website || null,
      address: fields.address || null,
      city: fields.city || null,
      state: fields.state || null,
      country: fields.country || null,
    })
    .eq("id", actor.collegeId);

  if (error) {
    throw new Error(error.message);
  }

  await logAudit(supabase, actor, "Updated institution settings", "colleges", actor.collegeId);
}

export async function updateCollege(fields: CollegeSettingsUpdate) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();
  await updateCollegeCore(supabase, actor, fields);
  revalidatePath("/admin/settings");
}

/** Called by app/api/mobile/admin/update-college/route.ts. */
export async function updateCollegeViaRequest(request: Request, fields: CollegeSettingsUpdate) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["admin"]);
  await updateCollegeCore(supabase, actor, fields);
}
