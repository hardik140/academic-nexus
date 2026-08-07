"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type OfferType = Database["public"]["Tables"]["placements"]["Row"]["offer_type"];
type PlacementStatus = Database["public"]["Tables"]["placements"]["Row"]["status"];

export interface CreatePlacementParams {
  studentId: string;
  companyName: string;
  roleTitle: string;
  packageLpa: number | null;
  placementDate: string;
  offerType?: OfferType;
  status?: PlacementStatus;
}

/**
 * Shared by the web Server Action below and
 * app/api/mobile/director/placement's Route Handler — same guarded logic
 * either way, just a different transport.
 */
export async function createPlacementCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: CreatePlacementParams
) {
  const { studentId, companyName, roleTitle, packageLpa, placementDate, offerType, status } = params;

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
}

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
  await createPlacementCore(supabase, actor, { studentId, companyName, roleTitle, packageLpa, placementDate, offerType, status });
  revalidatePath("/director/placements");
  revalidatePath("/director/analytics");
}

/** Called by app/api/mobile/director/placement/route.ts. */
export async function createPlacementViaRequest(request: Request, params: CreatePlacementParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["director", "admin"]);
  await createPlacementCore(supabase, actor, params);
}
