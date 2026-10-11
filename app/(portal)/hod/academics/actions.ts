"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type AuthorizedActor } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { checkRateLimit } from "@/lib/rate-limit";
import { assertRead } from "@/lib/read-result-server";
import { dbError } from "@/lib/internal-error";
import { academicRpc } from "@/lib/academic/rpc";
import type { Database } from "@/types/database";
import type {
  CourseOption, DepartmentOption, DepartmentReadiness, ExternalAuthorization, OfferingRow, ProgrammeRow,
  SectionOption, SectionRow, SectionWithIncharge, StaffOption, TermOption, TimetableSlotRow, UnplacedStudent,
} from "@/lib/academic/types";

/**
 * The HOD's academic workspace (ACADEMIC_LIFECYCLE_CONTRACT.md, PR 1).
 *
 * Authority is the DATABASE's: every write below is either a 055 function
 * that re-derives "does this caller head THIS department" from
 * departments.hod_id, or a direct write that RLS and 055's triggers decide
 * (programmes, sections, offerings). The department id a client sends is
 * only a choice among the departments this HOD heads — checked here so a
 * wrong id fails early and clearly, and checked again by the database.
 *
 * Structural writes are audited by 055's audit_academic_structure trigger
 * and the functions audit themselves, so nothing here calls logAudit.
 */

type Client = SupabaseClient<Database>;
const PATH = "/hod/academics";

const Id = z.string().guid();
const Reason = z.string().trim().min(10, { message: "Give a reason of at least 10 characters." }).max(1000);

/**
 * The department id, if this HOD heads it. Read here rather than through
 * lib/offerings' resolveHodDepartmentIds, which treats a failed read as "no
 * departments" — a read failure must surface as one (owner decision D5).
 */
async function headedDepartment(supabase: Client, actor: AuthorizedActor, departmentId: string): Promise<string> {
  const id = Id.parse(departmentId);
  const { data, error } = await supabase.from("departments").select("id").eq("hod_id", actor.userId);
  assertRead(error);
  if (!(data ?? []).some((d) => d.id === id)) throw new Error("Department not found.");
  return id;
}

async function activeTerm(supabase: Client, actor: AuthorizedActor) {
  const { data, error } = await supabase
    .from("semesters")
    .select("id, name, status")
    .eq("college_id", actor.collegeId)
    .eq("status", "active")
    .maybeSingle();
  assertRead(error);
  return data as TermOption | null;
}

const sectionLabel = (s: { name?: string; batch_year?: number; programmes?: { code?: string } | null } | null | undefined) =>
  `${s?.programmes?.code ?? ""} ${s?.name ?? ""} (${s?.batch_year ?? ""})`.trim();

// ─────────────────────────────────────────────────────────────
// Departments and the term
// ─────────────────────────────────────────────────────────────

export async function listMyDepartments(): Promise<DepartmentOption[]> {
  const actor = await requireRole(PERMISSIONS.department_term_manage);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("departments")
    .select("id, name, code")
    .eq("hod_id", actor.userId)
    .order("name");
  assertRead(error);
  return (data ?? []) as DepartmentOption[];
}

export async function getDepartmentOverview(departmentId: string): Promise<{
  readiness: DepartmentReadiness;
  sections: SectionWithIncharge[];
  staff: StaffOption[];
}> {
  const actor = await requireRole(PERMISSIONS.department_term_manage);
  const supabase = await createClient();
  const dept = await headedDepartment(supabase, actor, departmentId);

  const readiness = await academicRpc<DepartmentReadiness>(supabase, "department_term_readiness", { p_department_id: dept });

  const { data: sectionRows, error: sectionsError } = await supabase
    .from("sections")
    .select("id, name, batch_year, status, programmes:programme_id!inner(code, name, department_id)")
    .eq("programmes.department_id", dept)
    .eq("status", "active")
    .order("batch_year", { ascending: false });
  assertRead(sectionsError);
  const sections = (sectionRows ?? []) as unknown as {
    id: string; name: string; batch_year: number; status: string; programmes: { code: string; name: string };
  }[];
  const sectionIds = sections.map((s) => s.id);

  const [incharges, assignments, staff] = await Promise.all([
    readiness.semester_id && sectionIds.length
      ? supabase
          .from("section_class_incharges")
          .select("section_id, teacher_id, profiles:teacher_id(full_name)")
          .eq("semester_id", readiness.semester_id)
          .is("ended_at", null)
          .in("section_id", sectionIds)
      : Promise.resolve({ data: [], error: null }),
    sectionIds.length
      ? supabase.from("student_section_assignments").select("section_id").is("ended_at", null).in("section_id", sectionIds)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("profiles")
      .select("id, full_name")
      .eq("department_id", dept)
      .eq("status", "active")
      .in("role", ["teacher", "hod"])
      .order("full_name"),
  ]);
  assertRead(incharges.error);
  assertRead(assignments.error);
  assertRead(staff.error);

  const inchargeBySection = new Map(
    ((incharges.data ?? []) as unknown as { section_id: string; teacher_id: string; profiles: { full_name: string } | null }[])
      .map((r) => [r.section_id, { id: r.teacher_id, full_name: r.profiles?.full_name ?? "Teacher" }])
  );
  const counts = new Map<string, number>();
  for (const a of (assignments.data ?? []) as { section_id: string }[]) counts.set(a.section_id, (counts.get(a.section_id) ?? 0) + 1);

  const staffList = (staff.data ?? []) as StaffOption[];
  // The HOD can lead a section too, even when their own profile carries no
  // department (departments.hod_id is what makes them its staff).
  if (!staffList.some((s) => s.id === actor.userId)) {
    const { data: me, error: meError } = await supabase.from("profiles").select("id, full_name").eq("id", actor.userId).single();
    assertRead(meError);
    if (me) staffList.unshift(me as StaffOption);
  }

  return {
    readiness,
    sections: sections.map((s) => ({
      id: s.id,
      name: s.name,
      batch_year: s.batch_year,
      status: s.status,
      programme_code: s.programmes?.code ?? "",
      programme_name: s.programmes?.name ?? "",
      student_count: counts.get(s.id) ?? 0,
      incharge: inchargeBySection.get(s.id) ?? null,
    })),
    staff: staffList,
  };
}

export async function startDepartmentTerm(departmentId: string, acknowledgePending: boolean) {
  const actor = await requireRole(PERMISSIONS.department_term_manage);
  await checkRateLimit(`startDepartmentTerm:${actor.userId}`, 10, 60);
  const supabase = await createClient();
  const dept = await headedDepartment(supabase, actor, departmentId);
  await academicRpc(supabase, "start_department_term", { p_department_id: dept, p_acknowledge_pending: acknowledgePending === true });
  revalidatePath(PATH);
}

export async function endDepartmentTerm(departmentId: string, reason: string) {
  const actor = await requireRole(PERMISSIONS.department_term_manage);
  await checkRateLimit(`endDepartmentTerm:${actor.userId}`, 10, 60);
  const supabase = await createClient();
  const dept = await headedDepartment(supabase, actor, departmentId);
  await academicRpc(supabase, "end_department_term", { p_department_id: dept, p_reason: Reason.parse(reason) });
  revalidatePath(PATH);
}

export async function assignClassIncharge(sectionId: string, teacherId: string) {
  const actor = await requireRole(PERMISSIONS.class_incharge_manage);
  await checkRateLimit(`assignClassIncharge:${actor.userId}`, 30, 60);
  const supabase = await createClient();
  await academicRpc(supabase, "assign_class_incharge", {
    p_section_id: Id.parse(sectionId),
    p_teacher_id: Id.parse(teacherId),
    p_reason: null,
  });
  revalidatePath(PATH);
}

// ─────────────────────────────────────────────────────────────
// Department academic configuration (decision 5)
// ─────────────────────────────────────────────────────────────

export async function getDepartmentStructure(departmentId: string): Promise<{ programmes: ProgrammeRow[]; sections: SectionRow[] }> {
  const actor = await requireRole(PERMISSIONS.department_structure_manage);
  const supabase = await createClient();
  const dept = await headedDepartment(supabase, actor, departmentId);
  const { data: programmes, error } = await supabase
    .from("programmes")
    .select("id, name, code, degree_type, duration_semesters, total_credits, status")
    .eq("department_id", dept)
    .order("name");
  assertRead(error);
  const ids = (programmes ?? []).map((p) => p.id).filter(Boolean);
  const { data: sections, error: sectionsError } = ids.length
    ? await supabase
        .from("sections")
        .select("id, programme_id, name, batch_year, capacity, status")
        .in("programme_id", ids)
        .order("batch_year", { ascending: false })
        .order("name")
    : { data: [], error: null };
  assertRead(sectionsError);
  return { programmes: (programmes ?? []) as ProgrammeRow[], sections: (sections ?? []) as SectionRow[] };
}

const ProgrammeSchema = z.object({
  name: z.string().trim().min(2, { message: "Enter the programme name." }).max(200),
  code: z.string().trim().min(2, { message: "Enter a short code." }).max(30),
  degreeType: z.enum(["undergraduate", "postgraduate", "diploma", "doctoral", "certificate"]),
  durationSemesters: z.number().int().min(1).max(20),
  totalCredits: z.number().int().min(1).max(1000).nullable(),
});

export async function createProgramme(departmentId: string, input: z.infer<typeof ProgrammeSchema>) {
  const actor = await requireRole(PERMISSIONS.department_structure_manage);
  await checkRateLimit(`academicStructure:${actor.userId}`, 30, 60);
  const supabase = await createClient();
  const dept = await headedDepartment(supabase, actor, departmentId);
  const p = ProgrammeSchema.parse(input);
  const { error } = await supabase.from("programmes").insert({
    college_id: actor.collegeId,
    department_id: dept,
    name: p.name,
    code: p.code,
    degree_type: p.degreeType,
    duration_semesters: p.durationSemesters,
    total_credits: p.totalCredits,
  });
  if (error) throw dbError(error);
  revalidatePath(PATH);
}

export async function updateProgramme(programmeId: string, input: z.infer<typeof ProgrammeSchema> & { status: "active" | "inactive" }) {
  const actor = await requireRole(PERMISSIONS.department_structure_manage);
  await checkRateLimit(`academicStructure:${actor.userId}`, 30, 60);
  const supabase = await createClient();
  const p = ProgrammeSchema.extend({ status: z.enum(["active", "inactive"]) }).parse(input);
  const { data, error } = await supabase
    .from("programmes")
    .update({
      name: p.name,
      code: p.code,
      degree_type: p.degreeType,
      duration_semesters: p.durationSemesters,
      total_credits: p.totalCredits,
      status: p.status,
    })
    .eq("id", Id.parse(programmeId))
    .select("id");
  if (error) throw dbError(error);
  if (!data?.length) throw new Error("Programme not found in a department you head.");
  revalidatePath(PATH);
}

const SectionSchema = z.object({
  name: z.string().trim().min(1, { message: "Enter the section name." }).max(30),
  batchYear: z.number().int().min(1990).max(2200),
  capacity: z.number().int().min(1).max(1000).nullable(),
});

export async function createSection(programmeId: string, input: z.infer<typeof SectionSchema>) {
  const actor = await requireRole(PERMISSIONS.department_structure_manage);
  await checkRateLimit(`academicStructure:${actor.userId}`, 30, 60);
  const supabase = await createClient();
  const s = SectionSchema.parse(input);
  const { error } = await supabase.from("sections").insert({
    college_id: actor.collegeId,
    programme_id: Id.parse(programmeId),
    name: s.name,
    batch_year: s.batchYear,
    capacity: s.capacity,
  });
  if (error) throw dbError(error);
  revalidatePath(PATH);
}

export async function setSectionStatus(sectionId: string, status: "active" | "inactive") {
  const actor = await requireRole(PERMISSIONS.department_structure_manage);
  await checkRateLimit(`academicStructure:${actor.userId}`, 30, 60);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sections")
    .update({ status: z.enum(["active", "inactive"]).parse(status) })
    .eq("id", Id.parse(sectionId))
    .select("id");
  if (error) throw dbError(error);
  if (!data?.length) throw new Error("Section not found in a department you head.");
  revalidatePath(PATH);
}

// ─────────────────────────────────────────────────────────────
// Teacher assignment: offerings and external teaching (decision 4)
// ─────────────────────────────────────────────────────────────

export async function getOfferingsWorkspace(departmentId: string): Promise<{
  terms: TermOption[];
  courses: CourseOption[];
  sections: SectionOption[];
  teachers: StaffOption[];
  offerings: OfferingRow[];
  external: ExternalAuthorization[];
  externalCandidates: StaffOption[];
}> {
  const actor = await requireRole(PERMISSIONS.offering_manage);
  const supabase = await createClient();
  const dept = await headedDepartment(supabase, actor, departmentId);

  const [terms, courses, sections, staff, external, college] = await Promise.all([
    supabase.from("semesters").select("id, name, status").eq("college_id", actor.collegeId).in("status", ["planned", "active"]).order("start_date"),
    supabase.from("courses").select("id, code, name, type").eq("department_id", dept).eq("status", "active").order("code"),
    supabase.from("sections").select("id, name, batch_year, programmes:programme_id(code)").eq("college_id", actor.collegeId).eq("status", "active"),
    supabase.from("profiles").select("id, full_name").eq("department_id", dept).eq("status", "active").in("role", ["teacher", "hod"]).order("full_name"),
    supabase
      .from("external_teaching_authorizations")
      .select("id, teacher_id, reason, granted_at, profiles:teacher_id(full_name, departments:department_id(name))")
      .eq("department_id", dept)
      .is("revoked_at", null),
    supabase.from("profiles").select("id, full_name, department_id").eq("college_id", actor.collegeId).eq("status", "active").in("role", ["teacher", "hod"]).order("full_name"),
  ]);
  for (const r of [terms, courses, sections, staff, external, college]) assertRead(r.error);

  const termIds = (terms.data ?? []).map((t) => t.id);
  const courseIds = (courses.data ?? []).map((c) => c.id);
  const { data: offeringRows, error: offeringsError } = termIds.length && courseIds.length
    ? await supabase
        .from("course_offerings")
        .select("id, status, semesters:semester_id(id, name, status), courses:course_id(id, code, name, type), sections:section_id(id, name, batch_year, programmes:programme_id(code)), profiles:instructor_id(id, full_name)")
        .in("semester_id", termIds)
        .in("course_id", courseIds)
    : { data: [], error: null };
  assertRead(offeringsError);

  const externalRows = (external.data ?? []) as unknown as {
    id: string; teacher_id: string; reason: string; granted_at: string;
    profiles: { full_name: string; departments: { name: string } | null } | null;
  }[];
  const staffList = (staff.data ?? []) as StaffOption[];
  const own = new Set(staffList.map((s) => s.id));
  const authorized = new Set(externalRows.map((e) => e.teacher_id));

  const { data: me, error: meError } = await supabase.from("profiles").select("id, full_name").eq("id", actor.userId).single();
  assertRead(meError);
  if (me && !own.has(me.id)) { staffList.unshift(me as StaffOption); own.add(me.id); }

  return {
    terms: (terms.data ?? []) as TermOption[],
    courses: (courses.data ?? []) as CourseOption[],
    sections: ((sections.data ?? []) as unknown as { id: string; name: string; batch_year: number; programmes: { code: string } | null }[])
      .map((s) => ({ id: s.id, label: sectionLabel(s) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    teachers: [
      ...staffList,
      ...externalRows.map((e) => ({ id: e.teacher_id, full_name: e.profiles?.full_name ?? "Teacher", external: true })),
    ],
    offerings: ((offeringRows ?? []) as unknown as {
      id: string; status: string;
      semesters: { id: string; name: string; status: string };
      courses: { id: string; code: string; name: string; type: string };
      sections: { id: string; name: string; batch_year: number; programmes: { code: string } | null };
      profiles: { id: string; full_name: string } | null;
    }[])
      .map((o) => ({
        id: o.id,
        status: o.status,
        semester: { id: o.semesters?.id ?? "", name: o.semesters?.name ?? "", status: o.semesters?.status ?? "" },
        course: { id: o.courses?.id ?? "", code: o.courses?.code ?? "", name: o.courses?.name ?? "", type: o.courses?.type ?? "" },
        section: { id: o.sections?.id ?? "", label: sectionLabel(o.sections) },
        instructor: o.profiles?.id ? { id: o.profiles.id, full_name: o.profiles.full_name ?? "" } : null,
      }))
      .sort((a, b) => a.semester.name.localeCompare(b.semester.name) || a.course.code.localeCompare(b.course.code) || a.section.label.localeCompare(b.section.label)),
    external: externalRows.map((e) => ({
      id: e.id,
      teacher_id: e.teacher_id,
      full_name: e.profiles?.full_name ?? "Teacher",
      home_department: e.profiles?.departments?.name ?? null,
      reason: e.reason,
      granted_at: e.granted_at,
    })),
    externalCandidates: ((college.data ?? []) as { id: string; full_name: string; department_id: string | null }[])
      .filter((p) => !own.has(p.id) && !authorized.has(p.id))
      .map((p) => ({ id: p.id, full_name: p.full_name })),
  };
}

const OfferingSchema = z.object({
  semesterId: Id,
  courseId: Id,
  sectionId: Id,
  instructorId: Id.nullable(),
});

export async function createOffering(input: z.infer<typeof OfferingSchema>) {
  const actor = await requireRole(PERMISSIONS.offering_manage);
  await checkRateLimit(`offering:${actor.userId}`, 60, 60);
  const supabase = await createClient();
  const o = OfferingSchema.parse(input);
  // RLS decides the department (heads_course_department); 055's trigger
  // decides whether the teacher may teach this course (decision 4).
  const { error } = await supabase.from("course_offerings").insert({
    college_id: actor.collegeId,
    semester_id: o.semesterId,
    course_id: o.courseId,
    section_id: o.sectionId,
    instructor_id: o.instructorId,
  });
  if (error) throw dbError(error);
  revalidatePath(PATH);
}

export async function setOfferingInstructor(offeringId: string, instructorId: string | null) {
  const actor = await requireRole(PERMISSIONS.offering_manage);
  await checkRateLimit(`offering:${actor.userId}`, 60, 60);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("course_offerings")
    .update({ instructor_id: instructorId === null ? null : Id.parse(instructorId) })
    .eq("id", Id.parse(offeringId))
    .select("id");
  if (error) throw dbError(error);
  if (!data?.length) throw new Error("Offering not found in a department you head.");
  revalidatePath(PATH);
}

export async function grantExternalTeaching(departmentId: string, teacherId: string, reason: string) {
  const actor = await requireRole(PERMISSIONS.external_teaching_manage);
  await checkRateLimit(`externalTeaching:${actor.userId}`, 20, 60);
  const supabase = await createClient();
  const dept = await headedDepartment(supabase, actor, departmentId);
  await academicRpc(supabase, "grant_external_teaching", { p_department_id: dept, p_teacher_id: Id.parse(teacherId), p_reason: Reason.parse(reason) });
  revalidatePath(PATH);
}

export async function revokeExternalTeaching(authorizationId: string, reason: string) {
  const actor = await requireRole(PERMISSIONS.external_teaching_manage);
  await checkRateLimit(`externalTeaching:${actor.userId}`, 20, 60);
  const supabase = await createClient();
  await academicRpc(supabase, "revoke_external_teaching", { p_authorization_id: Id.parse(authorizationId), p_reason: Reason.parse(reason) });
  revalidatePath(PATH);
}

// ─────────────────────────────────────────────────────────────
// Timetable (decision 6)
// ─────────────────────────────────────────────────────────────

export async function getTimetableWorkspace(departmentId: string): Promise<{ offerings: OfferingRow[]; slots: TimetableSlotRow[] }> {
  const actor = await requireRole(PERMISSIONS.timetable_manage);
  const supabase = await createClient();
  const dept = await headedDepartment(supabase, actor, departmentId);
  const term = await activeTerm(supabase, actor);
  if (!term) return { offerings: [], slots: [] };

  const { data: offeringRows, error } = await supabase
    .from("course_offerings")
    .select("id, status, courses:course_id!inner(id, code, name, type, department_id), sections:section_id(id, name, batch_year, programmes:programme_id(code)), profiles:instructor_id(id, full_name)")
    .eq("semester_id", term.id)
    .eq("courses.department_id", dept)
    .in("status", ["planned", "active"]);
  assertRead(error);
  const offerings = ((offeringRows ?? []) as unknown as {
    id: string; status: string;
    courses: { id: string; code: string; name: string; type: string };
    sections: { id: string; name: string; batch_year: number; programmes: { code: string } | null };
    profiles: { id: string; full_name: string } | null;
  }[]).map((o) => ({
    id: o.id,
    status: o.status,
    semester: term,
    course: { id: o.courses?.id ?? "", code: o.courses?.code ?? "", name: o.courses?.name ?? "", type: o.courses?.type ?? "" },
    section: { id: o.sections?.id ?? "", label: sectionLabel(o.sections) },
    instructor: o.profiles?.id ? { id: o.profiles.id, full_name: o.profiles.full_name ?? "" } : null,
  })).sort((a, b) => a.course.code.localeCompare(b.course.code) || a.section.label.localeCompare(b.section.label));

  const ids = offerings.map((o) => o.id);
  const { data: slotRows, error: slotsError } = ids.length
    ? await supabase
        .from("timetable_slots")
        .select("id, offering_id, day_of_week, start_time, end_time, room")
        .in("offering_id", ids)
        .order("day_of_week")
        .order("start_time")
    : { data: [], error: null };
  assertRead(slotsError);
  const byId = new Map(offerings.map((o) => [o.id, o]));
  return {
    offerings,
    slots: ((slotRows ?? []) as { id: string; offering_id: string; day_of_week: number; start_time: string; end_time: string; room: string | null }[]).map((s) => {
      const o = byId.get(s.offering_id);
      return { ...s, label: o ? `${o.course.code} · ${o.section.label}` : "Class", teacher: o?.instructor?.full_name ?? null };
    }),
  };
}

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "Use a time like 09:30." });
const SlotSchema = z.object({
  offeringId: Id,
  day: z.number().int().min(0).max(6),
  start: Time,
  end: Time,
  room: z.string().trim().max(50).nullable(),
});

export async function createTimetableSlot(input: z.infer<typeof SlotSchema>) {
  const actor = await requireRole(PERMISSIONS.timetable_manage);
  await checkRateLimit(`timetable:${actor.userId}`, 60, 60);
  const supabase = await createClient();
  const s = SlotSchema.parse(input);
  await academicRpc(supabase, "create_timetable_slot", {
    p_offering_id: s.offeringId, p_day: s.day, p_start: s.start, p_end: s.end, p_room: s.room,
  });
  revalidatePath(PATH);
}

export async function deleteTimetableSlot(slotId: string) {
  const actor = await requireRole(PERMISSIONS.timetable_manage);
  await checkRateLimit(`timetable:${actor.userId}`, 60, 60);
  const supabase = await createClient();
  await academicRpc(supabase, "delete_timetable_slot", { p_slot_id: Id.parse(slotId) });
  revalidatePath(PATH);
}

// ─────────────────────────────────────────────────────────────
// Unplaced students (reconciliation)
// ─────────────────────────────────────────────────────────────

export async function getUnplacedStudents(departmentId: string): Promise<{ students: UnplacedStudent[]; sections: SectionOption[] }> {
  const actor = await requireRole(PERMISSIONS.student_section_reconcile);
  const supabase = await createClient();
  const dept = await headedDepartment(supabase, actor, departmentId);
  const students = await academicRpc<UnplacedStudent[]>(supabase, "students_without_section", { p_department_id: dept });
  const { data: sections, error } = await supabase
    .from("sections")
    .select("id, name, batch_year, programmes:programme_id!inner(code, department_id)")
    .eq("programmes.department_id", dept)
    .eq("status", "active");
  assertRead(error);
  return {
    students: students ?? [],
    sections: ((sections ?? []) as unknown as { id: string; name: string; batch_year: number; programmes: { code: string } }[])
      .map((s) => ({ id: s.id, label: sectionLabel(s) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

export async function placeStudentInSection(studentId: string, sectionId: string, reason: string) {
  const actor = await requireRole(PERMISSIONS.student_section_reconcile);
  await checkRateLimit(`placeStudent:${actor.userId}`, 60, 60);
  const supabase = await createClient();
  await academicRpc(supabase, "assign_student_section", {
    p_student_id: Id.parse(studentId),
    p_section_id: Id.parse(sectionId),
    p_reason: Reason.parse(reason),
  });
  revalidatePath(PATH);
}
