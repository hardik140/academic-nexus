"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type CourseType = Database["public"]["Tables"]["courses"]["Row"]["type"];

const COURSE_TYPES = ["core", "elective", "lab", "project", "seminar"] as const;

const CreateCourseSchema = z.object({
  name: z.string().trim().min(1, { message: "Course name is required." }).max(200),
  code: z.string().trim().min(1, { message: "Course code is required." }).max(50),
  departmentId: z.string().uuid(),
  credits: z.number().positive().max(20),
  semester: z.number().int().positive().max(20),
  type: z.enum(COURSE_TYPES),
  description: z.string().trim().max(2000).optional(),
});

export interface CreateCourseParams {
  name: string;
  code: string;
  departmentId: string;
  credits: number;
  semester: number;
  type: CourseType;
  description?: string;
}

/**
 * Shared by the web Server Action below and
 * app/api/mobile/admin/create-course's Route Handler.
 */
export async function createCourseCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: CreateCourseParams
) {
  const { name, code, departmentId, credits, semester, type, description } =
    CreateCourseSchema.parse(params);
  await checkRateLimit(`createCourse:${actor.userId}`, 20, 60);

  const { data: dept } = await supabase
    .from("departments")
    .select("id, college_id")
    .eq("id", departmentId)
    .single();

  if (!dept || dept.college_id !== actor.collegeId) {
    throw new Error("Department not found in your college.");
  }

  const { data: course, error } = await supabase
    .from("courses")
    .insert({
      college_id: actor.collegeId,
      department_id: departmentId,
      name,
      code,
      credits,
      semester,
      type,
      description: description || null,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  await logAudit(supabase, actor, `Created course ${code} — ${name}`, "courses", course.id);
}

export async function createCourse(
  name: string,
  code: string,
  departmentId: string,
  credits: number,
  semester: number,
  type: CourseType,
  description?: string
) {
  const actor = await requireRole(["admin", "hod", "director"]);
  const supabase = await createClient();
  await createCourseCore(supabase, actor, { name, code, departmentId, credits, semester, type, description });
  revalidatePath("/admin/courses");
}

/** Called by app/api/mobile/admin/create-course/route.ts. */
export async function createCourseViaRequest(request: Request, params: CreateCourseParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["admin", "hod", "director"]);
  await createCourseCore(supabase, actor, params);
}
