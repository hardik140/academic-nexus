"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import type { Database } from "@/types/database";

type ScholarshipType = Database["public"]["Tables"]["scholarships"]["Row"]["type"];

export async function createScholarship(
  studentId: string,
  name: string,
  type: ScholarshipType,
  amount: number,
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

  const { error } = await supabase.from("scholarships").insert({
    college_id: actor.collegeId,
    student_id: studentId,
    name,
    type,
    amount,
    academic_year: academicYear || null,
    awarded_date: new Date().toISOString().slice(0, 10),
  });

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath("/finance/scholarships");
  revalidatePath("/finance/dashboard");
}
