"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCacheFamily, versionedKey } from "@/lib/cache";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { DataTableQuery } from "@/components/ui/data-table";
import { dbError } from "@/lib/internal-error";
import { assertRead } from "@/lib/read-result-server";

type OfferType = Database["public"]["Tables"]["placements"]["Row"]["offer_type"];
type PlacementStatus = Database["public"]["Tables"]["placements"]["Row"]["status"];

const OFFER_TYPES = ["full_time", "internship", "ppo"] as const;
const PLACEMENT_STATUSES = ["placed", "joined", "declined", "offer_revoked"] as const;
const PLACEMENTS_PAGE_SIZE = 10;
const PLACEMENTS_SORT_COLUMNS = ["company_name", "package_lpa"] as const;
const PLACEMENTS_CACHE_PREFIX = "list:placements";

export async function listPlacements(q: DataTableQuery) {
  const actor = await requireRole(["director", "admin"]);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(PLACEMENTS_SORT_COLUMNS, "placement_date", false, q);
  const cacheKey = versionedKey(listCacheKey(PLACEMENTS_CACHE_PREFIX, actor.collegeId, q, column), PLACEMENTS_CACHE_PREFIX, actor.collegeId);

  return getCached(cacheKey, 30, async () => {
    let dbQuery = supabase
      .from("placements")
      .select("*, students:student_id(enrollment_number, profiles:user_id(full_name), departments(name))", { count: "exact" });

    if (q.search) dbQuery = dbQuery.ilike("company_name", `%${q.search}%`);
    dbQuery = dbQuery.order(column, { ascending });

    const from = q.page * PLACEMENTS_PAGE_SIZE;
    const { data, count, error: dataError } = await dbQuery.range(from, from + PLACEMENTS_PAGE_SIZE - 1);
    assertRead(dataError);
    return { data: data || [], count: count ?? 0 };
  });
}

const CreatePlacementSchema = z.object({
  studentId: z.string().guid(),
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
    throw dbError(error);
  }
}

export async function createPlacement(
  studentId: string,
  companyName: string,
  roleTitle: string,
  packageLpa: number | null,
  placementDate: string,
  offerType?: OfferType,
  status?: PlacementStatus) {
  const actor = await requireRole(["director", "admin"]);
  const supabase = await createClient();
  await createPlacementCore(supabase, actor, { studentId, companyName, roleTitle, packageLpa, placementDate, offerType, status });
  revalidatePath("/director/placements");
  revalidatePath("/director/analytics");
  await invalidateCacheFamily(PLACEMENTS_CACHE_PREFIX, actor.collegeId);
}

/** Called by app/api/mobile/director/placement/route.ts. */
export async function createPlacementViaRequest(request: Request, params: CreatePlacementParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["director", "admin"]);
  await createPlacementCore(supabase, actor, params);
}
