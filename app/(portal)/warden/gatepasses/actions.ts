"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";

export async function actOnGatePass(
  passId: string,
  action: "approved" | "rejected"
) {
  const actor = await requireRole(["warden", "admin"]);
  const supabase = await createClient();

  await supabase
    .from("gate_passes")
    .update({
      status: action,
      approved_by: actor.userId,
      approved_at: new Date().toISOString(),
    })
    .eq("id", passId)
    .eq("college_id", actor.collegeId);

  revalidatePath("/warden/gatepasses");
}
