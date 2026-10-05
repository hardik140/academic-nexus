"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCacheFamily, versionedKey } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { DataTableQuery } from "@/components/ui/data-table";
import { dbError } from "@/lib/internal-error";
import { assertRead } from "@/lib/read-result-server";

const COMPANIES_PAGE_SIZE = 10;
const COMPANIES_SORT_COLUMNS = ["name", "industry"] as const;
const COMPANIES_CACHE_PREFIX = "list:companies";

export async function listCompanies(q: DataTableQuery) {
  const actor = await requireRole(["placement_cell", "director", "admin"]);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(COMPANIES_SORT_COLUMNS, "name", true, q);
  const cacheKey = versionedKey(listCacheKey(COMPANIES_CACHE_PREFIX, actor.collegeId, q, column), COMPANIES_CACHE_PREFIX, actor.collegeId);

  return getCached(cacheKey, 30, async () => {
    let dbQuery = supabase.from("companies").select("*", { count: "exact" });
    if (q.search) dbQuery = dbQuery.ilike("name", `%${q.search}%`);
    dbQuery = dbQuery.order(column, { ascending });

    const from = q.page * COMPANIES_PAGE_SIZE;
    const { data, count, error: dataError } = await dbQuery.range(from, from + COMPANIES_PAGE_SIZE - 1);
    assertRead(dataError);
    return { data: data || [], count: count ?? 0 };
  });
}

const CompanySchema = z.object({
  name: z.string().trim().min(1, { message: "Company name is required." }).max(200),
  industry: z.string().trim().max(100).optional(),
  website: z.string().trim().max(300).optional(),
  location: z.string().trim().max(200).optional(),
  hrContactName: z.string().trim().max(200).optional(),
  hrEmail: z.string().trim().email({ message: "Enter a valid email." }).optional().or(z.literal("")),
  hrPhone: z.string().trim().max(20).optional(),
  description: z.string().trim().max(2000).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export interface CompanyParams {
  name: string;
  industry?: string;
  website?: string;
  location?: string;
  hrContactName?: string;
  hrEmail?: string;
  hrPhone?: string;
  description?: string;
  status?: "active" | "inactive";
}

async function createCompanyCore(supabase: SupabaseClient<Database>, actor: AuthorizedActor, params: CompanyParams) {
  const parsed = CompanySchema.parse(params);
  await checkRateLimit(`createCompany:${actor.userId}`, 20, 60);

  const { data, error } = await supabase
    .from("companies")
    .insert({
      college_id: actor.collegeId,
      name: parsed.name,
      industry: parsed.industry || null,
      website: parsed.website || null,
      location: parsed.location || null,
      hr_contact_name: parsed.hrContactName || null,
      hr_email: parsed.hrEmail || null,
      hr_phone: parsed.hrPhone || null,
      description: parsed.description || null,
      status: parsed.status || "active",
      created_by: actor.userId,
    })
    .select("id")
    .single();

  if (error) {
    throw dbError(error);
  }

  await logAudit(supabase, actor, `Added company ${parsed.name}`, "companies", data.id);
  return data;
}

export async function createCompany(params: CompanyParams) {
  const actor = await requireRole(["placement_cell", "admin"]);
  const supabase = await createClient();
  const result = await createCompanyCore(supabase, actor, params);
  revalidatePath("/placement-cell/companies");
  await invalidateCacheFamily(COMPANIES_CACHE_PREFIX, actor.collegeId);
  return result;
}

const UpdateCompanySchema = CompanySchema.extend({ companyId: z.string().guid() });

export async function updateCompany(
  companyId: string,
  params: CompanyParams) {
  const actor = await requireRole(["placement_cell", "admin"]);
  const supabase = await createClient();
  const parsed = UpdateCompanySchema.parse({ companyId, ...params });
  await checkRateLimit(`updateCompany:${actor.userId}`, 20, 60);

  const { data: existing } = await supabase
    .from("companies")
    .select("id, college_id")
    .eq("id", companyId)
    .single();
  if (!existing || existing.college_id !== actor.collegeId) {
    throw new Error("Company not found in your college.");
  }

  const { error } = await supabase
    .from("companies")
    .update({
      name: parsed.name,
      industry: parsed.industry || null,
      website: parsed.website || null,
      location: parsed.location || null,
      hr_contact_name: parsed.hrContactName || null,
      hr_email: parsed.hrEmail || null,
      hr_phone: parsed.hrPhone || null,
      description: parsed.description || null,
      status: parsed.status || "active",
    })
    .eq("id", companyId)
    .eq("college_id", actor.collegeId);

  if (error) {
    throw dbError(error);
  }

  await logAudit(supabase, actor, `Updated company ${parsed.name}`, "companies", companyId);
  revalidatePath("/placement-cell/companies");
  await invalidateCacheFamily(COMPANIES_CACHE_PREFIX, actor.collegeId);
}
