"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCacheFamily, versionedKey } from "@/lib/cache";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import { logAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { DataTableQuery } from "@/components/ui/data-table";
import { dbError } from "@/lib/internal-error";
import { assertRead } from "@/lib/read-result-server";

const FEES_PAGE_SIZE = 10;
const FEES_SORT_COLUMNS = ["type", "amount", "due_date"] as const;
const FEES_CACHE_PREFIX = "list:fees";

/** Cached, paginated — see admin/users/actions.ts's listUsers for the full
 * rationale (Server Action instead of a browser call, since getCached()
 * needs the server-only Redis token; explicit invalidation on top of the
 * short TTL since this is an edited list, not a stat count). */
export async function listInvoices(q: DataTableQuery) {
  const actor = await requireRole(PERMISSIONS.invoice_read);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(FEES_SORT_COLUMNS, "due_date", false, q);
  const cacheKey = versionedKey(listCacheKey(FEES_CACHE_PREFIX, actor.collegeId, q, column), FEES_CACHE_PREFIX, actor.collegeId);

  return getCached(cacheKey, 30, async () => {
    let dbQuery = supabase
      .from("fees")
      .select("*, students:student_id(enrollment_number, profiles:user_id(full_name))", { count: "exact" })
      .eq("college_id", actor.collegeId);

    if (q.search) dbQuery = dbQuery.ilike("type", `%${q.search}%`);
    dbQuery = dbQuery.order(column, { ascending });

    const from = q.page * FEES_PAGE_SIZE;
    const { data, count, error: dataError } = await dbQuery.range(from, from + FEES_PAGE_SIZE - 1);
    assertRead(dataError);
    return { data: data || [], count: count ?? 0 };
  });
}

const CreateInvoiceSchema = z.object({
  studentId: z.string().guid(),
  type: z.string().trim().min(1).max(100),
  amount: z.number().positive({ message: "Amount must be greater than zero." }),
  dueDate: z.string().min(1),
  academicYear: z.string().trim().max(20).optional(),
});

export interface CreateInvoiceParams {
  studentId: string;
  type: string;
  amount: number;
  dueDate: string;
  academicYear?: string;
}

/**
 * Shared by the web Server Action below and app/api/mobile/finance/invoice's
 * Route Handler — same guarded logic either way, just a different transport.
 */
export async function createInvoiceCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: CreateInvoiceParams
) {
  const { studentId, type, amount, dueDate, academicYear } = CreateInvoiceSchema.parse(params);
  await checkRateLimit(`createInvoice:${actor.userId}`, 20, 60);

  const { data: student } = await supabase
    .from("students")
    .select("id, college_id")
    .eq("id", studentId)
    .single();

  if (!student || student.college_id !== actor.collegeId) {
    throw new Error("Student not found in your college.");
  }

  const { data: fee, error } = await supabase
    .from("fees")
    .insert({
      college_id: actor.collegeId,
      student_id: studentId,
      type,
      amount,
      due_date: dueDate,
      academic_year: academicYear || null,
    })
    .select("id")
    .single();

  if (error || !fee) {
    throw dbError({ ...error, message: error?.message || "Failed to create invoice." });
  }

  await logAudit(supabase, actor, "invoice_created", "fees", fee.id, {
    newValue: { student_id: studentId, type, amount, due_date: dueDate },
  });
}

export async function createInvoice(
  studentId: string,
  type: string,
  amount: number,
  dueDate: string,
  academicYear?: string) {
  const actor = await requireRole(PERMISSIONS.invoice_create);
  const supabase = await createClient();
  await createInvoiceCore(supabase, actor, { studentId, type, amount, dueDate, academicYear });
  revalidatePath("/finance/invoices");
  revalidatePath("/finance/transactions");
  revalidatePath("/finance/dashboard");
  await invalidateCacheFamily(FEES_CACHE_PREFIX, actor.collegeId);
}

/** Called by app/api/mobile/finance/invoice/route.ts. */
export async function createInvoiceViaRequest(request: Request, params: CreateInvoiceParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, PERMISSIONS.invoice_create);
  await createInvoiceCore(supabase, actor, params);
}
