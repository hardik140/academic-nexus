"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { DataTableQuery } from "@/components/ui/data-table";

// See app/(portal)/student/placements/actions.ts's comment on why embedded
// selects need a local cast — the hand-maintained Database type has no
// Relationships entries for supabase-js to infer these joins from.
interface ApplicationWithDrive {
  id: string;
  college_id: string;
  student_id: string;
  drive_id: string;
  placement_drives: {
    job_role: string;
    package_lpa: number | null;
    company_id: string;
    companies: { name: string } | null;
  } | null;
}

const DRIVES_PAGE_SIZE = 10;
const DRIVES_SORT_COLUMNS = ["job_role", "application_deadline", "package_lpa"] as const;
const DRIVES_CACHE_PREFIX = "list:placement_drives";

const STAFF_ROLES = ["placement_cell", "director", "admin"] as const;
const OPERATOR_ROLES = ["placement_cell", "admin"] as const;

export async function listDrives(q: DataTableQuery) {
  const actor = await requireRole(STAFF_ROLES);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(DRIVES_SORT_COLUMNS, "application_deadline", true, q);
  const cacheKey = listCacheKey(DRIVES_CACHE_PREFIX, actor.collegeId, q, column);

  return getCached(cacheKey, 30, async () => {
    let dbQuery = supabase
      .from("placement_drives")
      .select("*, companies:company_id(name), placement_applications(count)", { count: "exact" });

    if (q.search) dbQuery = dbQuery.ilike("job_role", `%${q.search}%`);
    dbQuery = dbQuery.order(column, { ascending });

    const from = q.page * DRIVES_PAGE_SIZE;
    const { data, count } = await dbQuery.range(from, from + DRIVES_PAGE_SIZE - 1);
    return { data: data || [], count: count ?? 0 };
  });
}

export async function listCompaniesForSelect() {
  const actor = await requireRole(STAFF_ROLES);
  const supabase = await createClient();
  const { data } = await supabase
    .from("companies")
    .select("id, name")
    .eq("college_id", actor.collegeId)
    .eq("status", "active")
    .order("name");
  return data || [];
}

/** Published drives, for the notifications page's "eligible students" target picker. */
export async function listActiveDrivesForSelect() {
  const actor = await requireRole(STAFF_ROLES);
  const supabase = await createClient();
  const { data } = await supabase
    .from("placement_drives")
    .select("id, job_role, companies:company_id(name)")
    .eq("college_id", actor.collegeId)
    .eq("status", "published")
    .order("created_at", { ascending: false });
  return data || [];
}

export async function listDepartmentsForSelect() {
  const actor = await requireRole(STAFF_ROLES);
  const supabase = await createClient();
  const { data } = await supabase
    .from("departments")
    .select("id, name, code")
    .eq("college_id", actor.collegeId)
    .order("name");
  return data || [];
}

const DriveSchema = z.object({
  companyId: z.string().guid(),
  jobRole: z.string().trim().min(1, { message: "Job role is required." }).max(200),
  jobDescription: z.string().trim().max(4000).optional(),
  packageLpa: z.number().nonnegative().nullable().optional(),
  minCgpa: z.number().min(0).max(10).nullable().optional(),
  maxBacklogs: z.number().int().min(0).nullable().optional(),
  eligibleBatchYears: z.array(z.number().int()).optional(),
  eligibleDepartmentIds: z.array(z.string().guid()).optional(),
  applicationDeadline: z.string().min(1, { message: "Application deadline is required." }),
  driveDate: z.string().optional(),
});

export interface DriveParams {
  companyId: string;
  jobRole: string;
  jobDescription?: string;
  packageLpa?: number | null;
  minCgpa?: number | null;
  maxBacklogs?: number | null;
  eligibleBatchYears?: number[];
  eligibleDepartmentIds?: string[];
  applicationDeadline: string;
  driveDate?: string;
}

async function verifyCompanyInCollege(supabase: SupabaseClient<Database>, actor: AuthorizedActor, companyId: string) {
  const { data: company } = await supabase.from("companies").select("id, college_id").eq("id", companyId).single();
  if (!company || company.college_id !== actor.collegeId) {
    throw new Error("Company not found in your college.");
  }
}

async function syncDriveDepartments(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  driveId: string,
  departmentIds: string[]
) {
  await supabase.from("placement_drive_departments").delete().eq("drive_id", driveId);
  if (departmentIds.length === 0) return;

  // Never trust client-picked department ids blindly — re-verify every one
  // belongs to the actor's own college before linking it to the drive.
  const { data: validDepartments } = await supabase
    .from("departments")
    .select("id")
    .eq("college_id", actor.collegeId)
    .in("id", departmentIds);
  const validIds = (validDepartments || []).map((d) => d.id);

  if (validIds.length > 0) {
    await supabase.from("placement_drive_departments").insert(validIds.map((id) => ({ drive_id: driveId, department_id: id })));
  }
}

async function createDriveCore(supabase: SupabaseClient<Database>, actor: AuthorizedActor, params: DriveParams) {
  const parsed = DriveSchema.parse(params);
  await checkRateLimit(`createDrive:${actor.userId}`, 20, 60);
  await verifyCompanyInCollege(supabase, actor, parsed.companyId);

  const { data, error } = await supabase
    .from("placement_drives")
    .insert({
      college_id: actor.collegeId,
      company_id: parsed.companyId,
      job_role: parsed.jobRole,
      job_description: parsed.jobDescription || null,
      package_lpa: parsed.packageLpa ?? null,
      min_cgpa: parsed.minCgpa ?? null,
      max_backlogs: parsed.maxBacklogs ?? null,
      eligible_batch_years: parsed.eligibleBatchYears && parsed.eligibleBatchYears.length > 0 ? parsed.eligibleBatchYears : null,
      application_deadline: parsed.applicationDeadline,
      drive_date: parsed.driveDate || null,
      status: "draft",
      created_by: actor.userId,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  await syncDriveDepartments(supabase, actor, data.id, parsed.eligibleDepartmentIds || []);
  await logAudit(supabase, actor, `Created placement drive for ${parsed.jobRole}`, "placement_drives", data.id);
  return data;
}

export async function createDrive(params: DriveParams, viewQuery?: DataTableQuery) {
  const actor = await requireRole(OPERATOR_ROLES);
  const supabase = await createClient();
  const result = await createDriveCore(supabase, actor, params);
  revalidatePath("/placement-cell/drives");
  if (viewQuery) {
    const { column } = resolveListSort(DRIVES_SORT_COLUMNS, "application_deadline", true, viewQuery);
    await invalidateCache(listCacheKey(DRIVES_CACHE_PREFIX, actor.collegeId, viewQuery, column));
  }
  return result;
}

const UpdateDriveSchema = DriveSchema.extend({ driveId: z.string().guid() });

export async function updateDrive(driveId: string, params: DriveParams, viewQuery?: DataTableQuery) {
  const actor = await requireRole(OPERATOR_ROLES);
  const supabase = await createClient();
  const parsed = UpdateDriveSchema.parse({ driveId, ...params });
  await checkRateLimit(`updateDrive:${actor.userId}`, 20, 60);

  const { data: existing } = await supabase.from("placement_drives").select("id, college_id").eq("id", driveId).single();
  if (!existing || existing.college_id !== actor.collegeId) {
    throw new Error("Placement drive not found in your college.");
  }
  await verifyCompanyInCollege(supabase, actor, parsed.companyId);

  const { error } = await supabase
    .from("placement_drives")
    .update({
      company_id: parsed.companyId,
      job_role: parsed.jobRole,
      job_description: parsed.jobDescription || null,
      package_lpa: parsed.packageLpa ?? null,
      min_cgpa: parsed.minCgpa ?? null,
      max_backlogs: parsed.maxBacklogs ?? null,
      eligible_batch_years: parsed.eligibleBatchYears && parsed.eligibleBatchYears.length > 0 ? parsed.eligibleBatchYears : null,
      application_deadline: parsed.applicationDeadline,
      drive_date: parsed.driveDate || null,
    })
    .eq("id", driveId)
    .eq("college_id", actor.collegeId);

  if (error) {
    throw new Error(error.message);
  }

  await syncDriveDepartments(supabase, actor, driveId, parsed.eligibleDepartmentIds || []);
  await logAudit(supabase, actor, `Updated placement drive for ${parsed.jobRole}`, "placement_drives", driveId);
  revalidatePath("/placement-cell/drives");
  if (viewQuery) {
    const { column } = resolveListSort(DRIVES_SORT_COLUMNS, "application_deadline", true, viewQuery);
    await invalidateCache(listCacheKey(DRIVES_CACHE_PREFIX, actor.collegeId, viewQuery, column));
  }
}

const DriveStatusSchema = z.object({
  driveId: z.string().guid(),
  status: z.enum(["draft", "published", "closed", "cancelled"]),
});

export async function setDriveStatus(driveId: string, status: "draft" | "published" | "closed" | "cancelled", viewQuery?: DataTableQuery) {
  const actor = await requireRole(OPERATOR_ROLES);
  const supabase = await createClient();
  const parsed = DriveStatusSchema.parse({ driveId, status });
  await checkRateLimit(`setDriveStatus:${actor.userId}`, 20, 60);

  const { error } = await supabase
    .from("placement_drives")
    .update({ status: parsed.status })
    .eq("id", parsed.driveId)
    .eq("college_id", actor.collegeId);

  if (error) {
    throw new Error(error.message);
  }

  await logAudit(supabase, actor, `Set placement drive status to ${parsed.status}`, "placement_drives", parsed.driveId);
  revalidatePath("/placement-cell/drives");
  if (viewQuery) {
    const { column } = resolveListSort(DRIVES_SORT_COLUMNS, "application_deadline", true, viewQuery);
    await invalidateCache(listCacheKey(DRIVES_CACHE_PREFIX, actor.collegeId, viewQuery, column));
  }
}

/** Applicants for one drive, joined with student/department detail. */
export async function listApplicants(driveIdRaw: string) {
  const actor = await requireRole(STAFF_ROLES);
  const supabase = await createClient();
  const { driveId } = z.object({ driveId: z.string().guid() }).parse({ driveId: driveIdRaw });

  const { data: drive } = await supabase.from("placement_drives").select("id, college_id").eq("id", driveId).single();
  if (!drive || drive.college_id !== actor.collegeId) {
    throw new Error("Placement drive not found in your college.");
  }

  const { data } = await supabase
    .from("placement_applications")
    .select(
      "*, students:student_id(enrollment_number, cgpa, batch_year, profiles:user_id(full_name), departments(name))"
    )
    .eq("drive_id", driveId)
    .order("applied_at", { ascending: false });

  return data || [];
}

const APPLICATION_STATUSES = ["applied", "shortlisted", "interview", "selected", "rejected", "offer_declined"] as const;
const UpdateApplicationStatusSchema = z.object({
  applicationId: z.string().guid(),
  status: z.enum(APPLICATION_STATUSES),
});

/**
 * Shortlist / move to interview / select / reject an applicant. "Selected"
 * is treated as the terminal successful outcome (matches the spec's own
 * "Applied -> Shortlisted -> Interview -> Selected" example) — it also
 * writes the outcome into the pre-existing `placements` ledger, so
 * mv_placement_summary and director/analytics/placements pick it up with
 * no changes of their own, and syncs student_placement_profiles so
 * "Student Placement Records" reflects it without a second manual step.
 */
export async function updateApplicationStatus(applicationId: string, status: (typeof APPLICATION_STATUSES)[number]) {
  const actor = await requireRole(OPERATOR_ROLES);
  const supabase = await createClient();
  const parsed = UpdateApplicationStatusSchema.parse({ applicationId, status });
  await checkRateLimit(`updateApplicationStatus:${actor.userId}`, 30, 60);

  const { data: applicationData } = await supabase
    .from("placement_applications")
    .select("id, college_id, student_id, drive_id, placement_drives:drive_id(job_role, package_lpa, company_id, companies:company_id(name))")
    .eq("id", parsed.applicationId)
    .single();
  const application = applicationData as unknown as ApplicationWithDrive | null;

  if (!application || application.college_id !== actor.collegeId) {
    throw new Error("Application not found in your college.");
  }

  const { error } = await supabase
    .from("placement_applications")
    .update({ status: parsed.status })
    .eq("id", parsed.applicationId)
    .eq("college_id", actor.collegeId);
  if (error) {
    throw new Error(error.message);
  }

  if (parsed.status === "shortlisted" || parsed.status === "interview") {
    await supabase
      .from("student_placement_profiles")
      .upsert(
        { college_id: actor.collegeId, student_id: application.student_id, placement_status: "shortlisted", updated_by: actor.userId },
        { onConflict: "student_id" }
      );
  } else if (parsed.status === "selected") {
    const drive = application.placement_drives;

    await supabase
      .from("student_placement_profiles")
      .upsert(
        { college_id: actor.collegeId, student_id: application.student_id, placement_status: "placed", updated_by: actor.userId },
        { onConflict: "student_id" }
      );

    await supabase.from("placements").insert({
      college_id: actor.collegeId,
      student_id: application.student_id,
      company_name: drive?.companies?.name || "Unknown",
      role_title: drive?.job_role || "Unknown",
      package_lpa: drive?.package_lpa ?? null,
      placement_date: new Date().toISOString().slice(0, 10),
      offer_type: "full_time",
      status: "placed",
    });
  } else if (parsed.status === "rejected") {
    await supabase
      .from("student_placement_profiles")
      .upsert(
        { college_id: actor.collegeId, student_id: application.student_id, placement_status: "rejected", updated_by: actor.userId },
        { onConflict: "student_id" }
      );
  }

  await logAudit(
    supabase,
    actor,
    `Marked applicant ${parsed.status} for a placement drive`,
    "placement_applications",
    parsed.applicationId
  );
  revalidatePath("/placement-cell/drives");
  revalidatePath("/placement-cell/records");
  revalidatePath("/director/placements");
}
