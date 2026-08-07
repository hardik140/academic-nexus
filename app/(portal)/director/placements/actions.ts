"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import type { Database } from "@/types/database";

type OfferType = Database["public"]["Tables"]["placements"]["Row"]["offer_type"];
type PlacementStatus = Database["public"]["Tables"]["placements"]["Row"]["status"];

export async function createPlacement(
  studentId: string,
  companyName: string,
  roleTitle: string,
  packageLpa: number | null,
  placementDate: string,
  offerType?: OfferType,
  status?: PlacementStatus
) {
  const actor = await requireRole(["director", "admin"]);
  const supabase = await createClient();

  const { data: student } = await supabase
    .from("students")
    .select("id, college_id")
    .eq("id", studentId)
    .single();

  if (!student || student.college_id !== actor.collegeId) {
    throw new Error("Student not found in your college.");
  }
  if (!companyName.trim() || !roleTitle.trim()) {
    throw new Error("Company name and role title are required.");
  }

  const { error } = await supabase.from("placements").insert({
    college_id: actor.collegeId,
    student_id: studentId,
    company_name: companyName,
    role_title: roleTitle,
    package_lpa: packageLpa,
    placement_date: placementDate || null,
    offer_type: offerType || null,
    status: status || "placed",
  });

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath("/director/placements");
  revalidatePath("/director/analytics");
}
