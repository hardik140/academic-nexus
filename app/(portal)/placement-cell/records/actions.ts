"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import type { DataTableQuery } from "@/components/ui/data-table";

// See app/(portal)/student/placements/actions.ts's comment on why embedded
// selects need a local cast — the hand-maintained Database type has no
// Relationships entries for supabase-js to infer these joins from.
interface StudentRecordRow {
  id: string;
  enrollment_number: string;
  batch_year: number;
  cgpa: number | null;
  profiles: { full_name: string } | null;
  departments: { name: string } | null;
  student_placement_profiles: { placement_status: string } | null;
}

const RECORDS_PAGE_SIZE = 10;
const RECORDS_SORT_COLUMNS = ["enrollment_number", "batch_year"] as const;
const RECORDS_CACHE_PREFIX = "list:student_placement_records";

const STAFF_ROLES = ["placement_cell", "director", "admin"] as const;
const OPERATOR_ROLES = ["placement_cell", "admin"] as const;

const PLACEMENT_STATUSES = [
  "not_placed",
  "eligible",
  "applied",
  "shortlisted",
  "selected",
  "placed",
  "rejected",
  "opted_out",
] as const;

/**
 * All students in the college, with their master placement status (if any
 * activity exists) and most recent outcome from the pre-existing
 * `placements` ledger — fetched as two scoped queries and merged in
 * memory rather than a fragile deep nested-array join.
 */
export async function listStudentPlacementRecords(q: DataTableQuery) {
  const actor = await requireRole(STAFF_ROLES);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(RECORDS_SORT_COLUMNS, "enrollment_number", true, q);
  const cacheKey = listCacheKey(RECORDS_CACHE_PREFIX, actor.collegeId, q, column);

  return getCached(cacheKey, 30, async () => {
    let dbQuery = supabase
      .from("students")
      .select(
        "id, enrollment_number, batch_year, cgpa, profiles:user_id(full_name), departments(name), student_placement_profiles(placement_status)",
        { count: "exact" }
      )
      .eq("college_id", actor.collegeId);

    if (q.search) dbQuery = dbQuery.ilike("enrollment_number", `%${q.search}%`);
    dbQuery = dbQuery.order(column, { ascending });

    const from = q.page * RECORDS_PAGE_SIZE;
    const { data, count } = await dbQuery.range(from, from + RECORDS_PAGE_SIZE - 1);
    const students = (data || []) as unknown as StudentRecordRow[];

    const studentIds = students.map((s) => s.id);
    const { data: placementRows } = studentIds.length
      ? await supabase
          .from("placements")
          .select("student_id, company_name, package_lpa, status")
          .in("student_id", studentIds)
          .order("placement_date", { ascending: false })
      : { data: [] };

    const latestByStudent: Record<string, { company_name: string; package_lpa: number | null; status: string }> = {};
    (placementRows || []).forEach((p) => {
      if (!latestByStudent[p.student_id]) latestByStudent[p.student_id] = p;
    });

    const merged = students.map((s) => ({ ...s, placement: latestByStudent[s.id] || null }));
    return { data: merged, count: count ?? 0 };
  });
}

const UpdateStatusSchema = z.object({
  studentId: z.string().guid(),
  placementStatus: z.enum(PLACEMENT_STATUSES),
  notes: z.string().trim().max(2000).optional(),
});

export async function updateStudentPlacementStatus(
  studentId: string,
  placementStatus: (typeof PLACEMENT_STATUSES)[number],
  notes?: string,
  viewQuery?: DataTableQuery
) {
  const actor = await requireRole(OPERATOR_ROLES);
  const supabase = await createClient();
  const parsed = UpdateStatusSchema.parse({ studentId, placementStatus, notes });
  await checkRateLimit(`updateStudentPlacementStatus:${actor.userId}`, 30, 60);

  const { data: student } = await supabase.from("students").select("id, college_id").eq("id", parsed.studentId).single();
  if (!student || student.college_id !== actor.collegeId) {
    throw new Error("Student not found in your college.");
  }

  const { error } = await supabase.from("student_placement_profiles").upsert(
    {
      college_id: actor.collegeId,
      student_id: parsed.studentId,
      placement_status: parsed.placementStatus,
      notes: parsed.notes || null,
      updated_by: actor.userId,
    },
    { onConflict: "student_id" }
  );

  if (error) {
    throw new Error(error.message);
  }

  await logAudit(supabase, actor, `Updated placement record to ${parsed.placementStatus}`, "student_placement_profiles", parsed.studentId);
  revalidatePath("/placement-cell/records");
  if (viewQuery) {
    const { column } = resolveListSort(RECORDS_SORT_COLUMNS, "enrollment_number", true, viewQuery);
    await invalidateCache(listCacheKey(RECORDS_CACHE_PREFIX, actor.collegeId, viewQuery, column));
  }
}
