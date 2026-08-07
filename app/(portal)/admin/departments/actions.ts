"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";

export async function createDepartment(params: {
  name: string;
  code: string;
  description: string;
}) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();

  const { error } = await supabase.from("departments").insert({
    college_id: actor.collegeId,
    name: params.name,
    code: params.code,
    description: params.description,
  });

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath("/admin/departments");
}

export async function assignHod(departmentId: string, hodUserId: string | null) {
  const actor = await requireRole(["admin"]);
  const supabase = await createClient();

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

  revalidatePath("/admin/departments");
}
