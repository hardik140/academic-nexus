"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

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
  const { studentId, type, amount, dueDate, academicYear } = params;

  const { data: student } = await supabase
    .from("students")
    .select("id, college_id")
    .eq("id", studentId)
    .single();

  if (!student || student.college_id !== actor.collegeId) {
    throw new Error("Student not found in your college.");
  }
  if (amount <= 0) {
    throw new Error("Amount must be greater than zero.");
  }

  const { error } = await supabase.from("fees").insert({
    college_id: actor.collegeId,
    student_id: studentId,
    type,
    amount,
    due_date: dueDate,
    academic_year: academicYear || null,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function createInvoice(
  studentId: string,
  type: string,
  amount: number,
  dueDate: string,
  academicYear?: string
) {
  const actor = await requireRole(["finance", "admin"]);
  const supabase = await createClient();
  await createInvoiceCore(supabase, actor, { studentId, type, amount, dueDate, academicYear });
  revalidatePath("/finance/invoices");
  revalidatePath("/finance/transactions");
  revalidatePath("/finance/dashboard");
}

/** Called by app/api/mobile/finance/invoice/route.ts. */
export async function createInvoiceViaRequest(request: Request, params: CreateInvoiceParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["finance", "admin"]);
  await createInvoiceCore(supabase, actor, params);
}
