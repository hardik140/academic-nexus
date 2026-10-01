"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { getCached, invalidateCache } from "@/lib/cache";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { DataTableQuery } from "@/components/ui/data-table";
import { dbError } from "@/lib/internal-error";
import { assertRead } from "@/lib/read-result-server";

type CourseType = Database["public"]["Tables"]["courses"]["Row"]["type"];

const COURSE_TYPES = ["core", "elective", "lab", "project", "seminar"] as const;
const COURSES_PAGE_SIZE = 10;
const COURSES_SORT_COLUMNS = ["code", "name", "credits", "semester"] as const;
const COURSES_CACHE_PREFIX = "list:courses";

export async function listCourses(q: DataTableQuery) {
  const actor = await requireRole(["admin", "hod", "director"]);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(COURSES_SORT_COLUMNS, "code", true, q);
  const cacheKey = listCacheKey(COURSES_CACHE_PREFIX, actor.collegeId, q, column);

  return getCached(cacheKey, 30, async () => {
    let dbQuery = supabase
      .from("courses")
      // No instructor join: courses.instructor_id is deprecated (047) and a
      // course is taught by whoever holds each of its offerings.
      .select("*, departments:department_id(name)", { count: "exact" });

    if (q.search) dbQuery = dbQuery.ilike("name", `%${q.search}%`);
    dbQuery = dbQuery.order(column, { ascending });

    const from = q.page * COURSES_PAGE_SIZE;
    const { data, count, error: dataError } = await dbQuery.range(from, from + COURSES_PAGE_SIZE - 1);
    assertRead(dataError);
    return { data: data || [], count: count ?? 0 };
  });
}

const CreateCourseSchema = z.object({
  name: z.string().trim().min(1, { message: "Course name is required." }).max(200),
  code: z.string().trim().min(1, { message: "Course code is required." }).max(50),
  departmentId: z.string().guid(),
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
    throw dbError(error);
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
  description?: string,
  viewQuery?: DataTableQuery
) {
  const actor = await requireRole(PERMISSIONS.create_course);
  const supabase = await createClient();
  await createCourseCore(supabase, actor, { name, code, departmentId, credits, semester, type, description });
  revalidatePath("/admin/courses");
  if (viewQuery) {
    const { column } = resolveListSort(COURSES_SORT_COLUMNS, "code", true, viewQuery);
    await invalidateCache(listCacheKey(COURSES_CACHE_PREFIX, actor.collegeId, viewQuery, column));
  }
}

/** Called by app/api/mobile/admin/create-course/route.ts. */
export async function createCourseViaRequest(request: Request, params: CreateCourseParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, PERMISSIONS.create_course);
  await createCourseCore(supabase, actor, params);
}
