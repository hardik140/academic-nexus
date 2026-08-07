"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { logAudit } from "@/lib/audit";
import type { Database } from "@/types/database";

type CourseType = Database["public"]["Tables"]["courses"]["Row"]["type"];

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

  if (!name.trim() || !code.trim()) {
    throw new Error("Course name and code are required.");
  }

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

  revalidatePath("/admin/courses");
}
