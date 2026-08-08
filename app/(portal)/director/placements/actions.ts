"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type OfferType = Database["public"]["Tables"]["placements"]["Row"]["offer_type"];
type PlacementStatus = Database["public"]["Tables"]["placements"]["Row"]["status"];

const OFFER_TYPES = ["full_time", "internship", "ppo"] as const;
const PLACEMENT_STATUSES = ["placed", "joined", "declined", "offer_revoked"] as const;

const CreatePlacementSchema = z.object({
  studentId: z.string().uuid(),
  companyName: z.string().trim().min(1, { message: "Company name is required." }).max(200),
  roleTitle: z.string().trim().min(1, { message: "Role title is required." }).max(200),
  packageLpa: z.number().nonnegative().nullable(),
  placementDate: z.string(),
  offerType: z.enum(OFFER_TYPES).optional(),
  status: z.enum(PLACEMENT_STATUSES).optional(),
});

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
  const { studentId, companyName, roleTitle, packageLpa, placementDate, offerType, status } =
    CreatePlacementSchema.parse(params);
  await checkRateLimit(`createPlacement:${actor.userId}`, 20, 60);

  const { data: student } = await supabase
    .from("students")
    .select("id, college_id")
    .eq("id", studentId)
    .single();

  if (!student || student.college_id !== actor.collegeId) {
    throw new Error("Student not found in your college.");
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
