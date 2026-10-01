"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import { logAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { DataTableQuery } from "@/components/ui/data-table";
import { dbError } from "@/lib/internal-error";
import { assertRead } from "@/lib/read-result-server";

type ScholarshipType = Database["public"]["Tables"]["scholarships"]["Row"]["type"];

const SCHOLARSHIP_TYPES = ["merit", "need", "sports", "government", "corporate", "other"] as const;
const SCHOLARSHIPS_PAGE_SIZE = 10;
const SCHOLARSHIPS_SORT_COLUMNS = ["name", "amount"] as const;
const SCHOLARSHIPS_CACHE_PREFIX = "list:scholarships";

export async function listScholarships(q: DataTableQuery) {
  const actor = await requireRole(PERMISSIONS.scholarship_read);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(SCHOLARSHIPS_SORT_COLUMNS, "awarded_date", false, q);
  const cacheKey = listCacheKey(SCHOLARSHIPS_CACHE_PREFIX, actor.collegeId, q, column);

  return getCached(cacheKey, 30, async () => {
    let dbQuery = supabase
      .from("scholarships")
      .select("*, students:student_id(enrollment_number, profiles:user_id(full_name))", { count: "exact" })
      .eq("college_id", actor.collegeId);

    if (q.search) dbQuery = dbQuery.ilike("name", `%${q.search}%`);
    dbQuery = dbQuery.order(column, { ascending });

    const from = q.page * SCHOLARSHIPS_PAGE_SIZE;
    const { data, count, error: dataError } = await dbQuery.range(from, from + SCHOLARSHIPS_PAGE_SIZE - 1);
    assertRead(dataError);
    return { data: data || [], count: count ?? 0 };
  });
}

const CreateScholarshipSchema = z.object({
  studentId: z.string().guid(),
  name: z.string().trim().min(1).max(200),
  type: z.enum(SCHOLARSHIP_TYPES),
  amount: z.number().positive({ message: "Amount must be greater than zero." }),
  academicYear: z.string().trim().max(20).optional(),
});

export interface CreateScholarshipParams {
  studentId: string;
  name: string;
  type: ScholarshipType;
  amount: number;
  academicYear?: string;
}

/**
 * Shared by the web Server Action below and
 * app/api/mobile/finance/scholarship's Route Handler — same guarded logic
 * either way, just a different transport.
 */
export async function createScholarshipCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: CreateScholarshipParams
) {
  const { studentId, name, type, amount, academicYear } = CreateScholarshipSchema.parse(params);
  await checkRateLimit(`createScholarship:${actor.userId}`, 15, 60);

  const { data: student } = await supabase
    .from("students")
    .select("id, college_id")
    .eq("id", studentId)
    .single();

  if (!student || student.college_id !== actor.collegeId) {
    throw new Error("Student not found in your college.");
  }

  const { data: scholarship, error } = await supabase
    .from("scholarships")
    .insert({
      college_id: actor.collegeId,
      student_id: studentId,
      name,
      type,
      amount,
      academic_year: academicYear || null,
      awarded_date: new Date().toISOString().slice(0, 10),
    })
    .select("id")
    .single();

  if (error || !scholarship) {
    throw dbError({ ...error, message: error?.message || "Failed to create scholarship." });
  }

  await logAudit(supabase, actor, "scholarship_created", "scholarships", scholarship.id, {
    newValue: { student_id: studentId, name, type, amount },
  });
}

export async function createScholarship(
  studentId: string,
  name: string,
  type: ScholarshipType,
  amount: number,
  academicYear?: string,
  viewQuery?: DataTableQuery
) {
  const actor = await requireRole(PERMISSIONS.scholarship_manage);
  const supabase = await createClient();
  await createScholarshipCore(supabase, actor, { studentId, name, type, amount, academicYear });
  revalidatePath("/finance/scholarships");
  revalidatePath("/finance/dashboard");
  if (viewQuery) {
    const { column } = resolveListSort(SCHOLARSHIPS_SORT_COLUMNS, "awarded_date", false, viewQuery);
    await invalidateCache(listCacheKey(SCHOLARSHIPS_CACHE_PREFIX, actor.collegeId, viewQuery, column));
  }
}

/** Called by app/api/mobile/finance/scholarship/route.ts. */
export async function createScholarshipViaRequest(request: Request, params: CreateScholarshipParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, PERMISSIONS.scholarship_manage);
  await createScholarshipCore(supabase, actor, params);
}
