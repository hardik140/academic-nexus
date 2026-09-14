"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { dbError } from "@/lib/internal-error";

const UpdateCollegeSchema = z.object({
  name: z.string().trim().min(1, { message: "Institution name is required." }).max(200),
  code: z.string().trim().min(1, { message: "Institution code is required." }).max(50),
  domain: z.string().trim().max(200).optional(),
  accreditation: z.string().trim().max(200).optional(),
  established_year: z.number().int().min(1800).max(2100).optional(),
  email: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(30).optional(),
  website: z.string().trim().max(300).optional(),
  address: z.string().trim().max(500).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  country: z.string().trim().max(100).optional(),
});

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
  const parsed = UpdateCollegeSchema.parse(fields);
  await checkRateLimit(`updateCollege:${actor.userId}`, 10, 60);

  const { error } = await supabase
    .from("colleges")
    .update({
      name: parsed.name,
      code: parsed.code,
      domain: parsed.domain || null,
      accreditation: parsed.accreditation || null,
      established_year: parsed.established_year || null,
      email: parsed.email || null,
      phone: parsed.phone || null,
      website: parsed.website || null,
      address: parsed.address || null,
      city: parsed.city || null,
      state: parsed.state || null,
      country: parsed.country || null,
    })
    .eq("id", actor.collegeId);

  if (error) {
    throw dbError(error);
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
