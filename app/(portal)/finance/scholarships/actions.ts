"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type ScholarshipType = Database["public"]["Tables"]["scholarships"]["Row"]["type"];

const SCHOLARSHIP_TYPES = ["merit", "need", "sports", "government", "corporate", "other"] as const;

const CreateScholarshipSchema = z.object({
  studentId: z.string().uuid(),
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
}

export async function createScholarship(
  studentId: string,
  name: string,
  type: ScholarshipType,
  amount: number,
  academicYear?: string
) {
  const actor = await requireRole(["finance", "admin"]);
  const supabase = await createClient();
  await createScholarshipCore(supabase, actor, { studentId, name, type, amount, academicYear });
  revalidatePath("/finance/scholarships");
  revalidatePath("/finance/dashboard");
}

/** Called by app/api/mobile/finance/scholarship/route.ts. */
export async function createScholarshipViaRequest(request: Request, params: CreateScholarshipParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["finance", "admin"]);
  await createScholarshipCore(supabase, actor, params);
}
