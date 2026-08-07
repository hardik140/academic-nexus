"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";

export async function updateComplaintStatus(
  complaintId: string,
  status: "in_progress" | "resolved"
) {
  const actor = await requireRole(["warden", "admin"]);
  const supabase = await createClient();

  const { error } = await supabase
    .from("complaints")
    .update({
      status,
      resolved_at: status === "resolved" ? new Date().toISOString() : null,
    })
    .eq("id", complaintId)
    .eq("college_id", actor.collegeId);

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath("/warden/complaints");
}
