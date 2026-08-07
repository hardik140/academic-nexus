"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { logAudit } from "@/lib/audit";

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

export async function updateCollege(fields: CollegeSettingsUpdate) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();

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

  revalidatePath("/admin/settings");
}
