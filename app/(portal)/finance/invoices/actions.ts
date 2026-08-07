"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";

export async function createInvoice(
  studentId: string,
  type: string,
  amount: number,
  dueDate: string,
  academicYear?: string
) {
  const actor = await requireRole(["finance", "admin"]);
  const supabase = await createClient();

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

  revalidatePath("/finance/invoices");
  revalidatePath("/finance/transactions");
  revalidatePath("/finance/dashboard");
}
