"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";

export async function assignWarden(blockId: string, wardenUserId: string | null) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();

  // Verify the target profile is actually in this college and eligible
  // (warden role) before assigning — never trust the client-picked id
  // blindly, even though it came from a dropdown we populated ourselves.
  if (wardenUserId) {
    const { data: candidate } = await supabase
      .from("profiles")
      .select("id, role, college_id")
      .eq("id", wardenUserId)
      .single();

    if (!candidate || candidate.college_id !== actor.collegeId) {
      throw new Error("Selected staff member not found in your college.");
    }
    if (candidate.role !== "warden") {
      throw new Error("Only staff with the warden role can be assigned to a hostel block.");
    }
  }

  const { error } = await supabase
    .from("hostel_blocks")
    .update({ warden_id: wardenUserId })
    .eq("id", blockId)
    .eq("college_id", actor.collegeId);

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath("/admin/hostel");
}
