"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type AuthorizedActor } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { assertClaimed } from "@/lib/concurrent-claim";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * Academic period lifecycle — academic years and the semesters (terms) inside
 * them. This is the ONLY write path to either table in the product.
 *
 * Until this file existed, `semesters` had a read policy and nothing else:
 * migration 046 gave it a status vocabulary and 047 hung every attendance,
 * marks and enrollment row off an offering that hangs off a semester, but no
 * screen, action or route could create one. A college that finished its term
 * could not begin the next one without a SQL console.
 *
 * WHAT IS ENFORCED WHERE
 *
 * The lifecycle rules live in the database (047 §7k) and this file only
 * mirrors them so the UI can explain a refusal instead of surfacing a
 * constraint name:
 *
 *   created            planned, inside an academic year of this college
 *   planned -> active  the academic year must already be active; at most one
 *                      active semester per college (idx_semesters_one_active)
 *   active  -> closed  a year closes only after its active semester has
 *   closed             immutable
 *   deleted            only while planned; never once an offering points at it
 *
 * Every transition is a compare-and-swap on the status it expects to leave
 * (assertClaimed), so two admins closing the same term at once produce one
 * close and one "already actioned", never two audit rows for one event.
 *
 * NOT here, deliberately: offerings, sections, programmes and enrollments
 * still have no write path. Creating a semester is necessary for the
 * academic model to be operable through the product; it is not sufficient.
 */

const ACADEMIC_PERIOD_ROLES = PERMISSIONS.academic_period_manage;

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "Use YYYY-MM-DD." });

const CreateAcademicYearSchema = z
  .object({
    name: z.string().trim().min(1, { message: "Name is required." }).max(50),
    startDate: DateString,
    endDate: DateString,
  })
  .refine((v) => v.startDate < v.endDate, { message: "End date must be after start date.", path: ["endDate"] });

export type CreateAcademicYearParams = z.infer<typeof CreateAcademicYearSchema>;

const CreateSemesterSchema = z
  .object({
    academicYearId: z.string().guid(),
    name: z.string().trim().min(1, { message: "Name is required." }).max(100),
    sequenceNo: z.number().int().positive().max(12),
    startDate: DateString,
    endDate: DateString,
  })
  .refine((v) => v.startDate < v.endDate, { message: "End date must be after start date.", path: ["endDate"] });

export type CreateSemesterParams = z.infer<typeof CreateSemesterSchema>;

const UpdateSemesterSchema = z
  .object({
    semesterId: z.string().guid(),
    name: z.string().trim().min(1, { message: "Name is required." }).max(100),
    startDate: DateString,
    endDate: DateString,
  })
  .refine((v) => v.startDate < v.endDate, { message: "End date must be after start date.", path: ["endDate"] });

export type UpdateSemesterParams = z.infer<typeof UpdateSemesterSchema>;

/** The two legal forward moves. There is no way back and no skipping. */
type PeriodTransition = "activate" | "close";
const TRANSITIONS: Record<PeriodTransition, { from: "planned" | "active"; to: "active" | "closed" }> = {
  activate: { from: "planned", to: "active" },
  close: { from: "active", to: "closed" },
};

/**
 * Turns the database's refusal into the sentence an administrator can act
 * on. The constraint names are stable (046/047); the wording is ours.
 */
function explain(error: { code?: string; message: string }): Error {
  if (error.code === "23505" && /one_active/.test(error.message)) {
    return new Error("Another period is already active. Close it before activating this one.");
  }
  if (error.code === "23503") {
    return new Error("This period is referenced by course offerings and cannot be deleted.");
  }
  return new Error(error.message);
}

export async function createAcademicYearCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: CreateAcademicYearParams
) {
  const { name, startDate, endDate } = CreateAcademicYearSchema.parse(params);
  await checkRateLimit(`createAcademicYear:${actor.userId}`, 20, 60);

  const { data: year, error } = await supabase
    .from("academic_years")
    .insert({ college_id: actor.collegeId, name, start_date: startDate, end_date: endDate, status: "planned" })
    .select("id")
    .single();
  if (error) throw explain(error);

  await logAudit(supabase, actor, `Created academic year ${name}`, "academic_years", year.id, {
    newValue: { name, start_date: startDate, end_date: endDate, status: "planned" },
  });
  return year.id;
}

export async function createSemesterCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: CreateSemesterParams
) {
  const { academicYearId, name, sequenceNo, startDate, endDate } = CreateSemesterSchema.parse(params);
  await checkRateLimit(`createSemester:${actor.userId}`, 20, 60);

  // The year is read back rather than trusted: RLS would refuse a foreign
  // college's id at insert time anyway, but the deprecated `academic_year`
  // text column is NOT NULL and 046's backfill keyed it on the year's name,
  // so it is kept truthful here from the same source.
  const { data: year } = await supabase
    .from("academic_years")
    .select("id, name, college_id, status")
    .eq("id", academicYearId)
    .single();
  if (!year || year.college_id !== actor.collegeId) {
    throw new Error("Academic year not found in your college.");
  }
  if (year.status === "closed") {
    throw new Error("This academic year is closed. Create the semester in a planned or active year.");
  }

  const { data: semester, error } = await supabase
    .from("semesters")
    .insert({
      college_id: actor.collegeId,
      academic_year_id: year.id,
      academic_year: year.name,
      name,
      sequence_no: sequenceNo,
      start_date: startDate,
      end_date: endDate,
      status: "planned",
    })
    .select("id")
    .single();
  if (error) throw explain(error);

  await logAudit(supabase, actor, `Created semester ${name} in ${year.name}`, "semesters", semester.id, {
    newValue: { name, academic_year_id: year.id, sequence_no: sequenceNo, start_date: startDate, end_date: endDate, status: "planned" },
  });
  return semester.id;
}

export async function updateSemesterCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: UpdateSemesterParams
) {
  const { semesterId, name, startDate, endDate } = UpdateSemesterSchema.parse(params);
  await checkRateLimit(`updateSemester:${actor.userId}`, 30, 60);

  const { data: before } = await supabase
    .from("semesters")
    .select("id, name, start_date, end_date, status, college_id")
    .eq("id", semesterId)
    .single();
  if (!before || before.college_id !== actor.collegeId) throw new Error("Semester not found in your college.");
  if (before.status === "closed") throw new Error("A closed semester is immutable.");

  const { data: updated, error } = await supabase
    .from("semesters")
    .update({ name, start_date: startDate, end_date: endDate })
    .eq("id", semesterId)
    .eq("college_id", actor.collegeId)
    .neq("status", "closed")
    .select("id");
  if (error) throw explain(error);
  assertClaimed(updated, "semester");

  await logAudit(supabase, actor, `Updated semester ${before.name}`, "semesters", semesterId, {
    oldValue: { name: before.name, start_date: before.start_date, end_date: before.end_date },
    newValue: { name, start_date: startDate, end_date: endDate },
  });
}

async function transitionCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  table: "semesters" | "academic_years",
  id: string,
  transition: PeriodTransition
) {
  z.string().guid().parse(id);
  const { from, to } = TRANSITIONS[transition];
  await checkRateLimit(`${transition}:${table}:${actor.userId}`, 30, 60);

  const { data: before } = await supabase
    .from(table)
    .select("id, name, status, college_id")
    .eq("id", id)
    .single();
  if (!before || before.college_id !== actor.collegeId) throw new Error(`${label(table)} not found in your college.`);
  if (before.status !== from) {
    throw new Error(`Only a ${from} ${label(table).toLowerCase()} can be ${to === "active" ? "activated" : "closed"}; this one is ${before.status}.`);
  }

  // The status predicate makes this a compare-and-swap; the database trigger
  // (047 §7k) independently refuses anything that is not planned->active or
  // active->closed, and the partial unique index refuses a second active.
  const { data: claimed, error } = await supabase
    .from(table)
    .update({ status: to })
    .eq("id", id)
    .eq("college_id", actor.collegeId)
    .eq("status", from)
    .select("id");
  if (error) throw explain(error);
  assertClaimed(claimed, label(table).toLowerCase());

  await logAudit(supabase, actor, `${transition === "activate" ? "Activated" : "Closed"} ${label(table).toLowerCase()} ${before.name}`, table, id, {
    oldValue: { status: from },
    newValue: { status: to },
  });
}

export async function transitionSemesterCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  semesterId: string,
  transition: PeriodTransition
) {
  await transitionCore(supabase, actor, "semesters", semesterId, transition);
}

export async function transitionAcademicYearCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  academicYearId: string,
  transition: PeriodTransition
) {
  await transitionCore(supabase, actor, "academic_years", academicYearId, transition);
}

export async function deleteSemesterCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  semesterId: string
) {
  z.string().guid().parse(semesterId);
  await checkRateLimit(`deleteSemester:${actor.userId}`, 20, 60);

  const { data: before } = await supabase
    .from("semesters")
    .select("id, name, status, college_id")
    .eq("id", semesterId)
    .single();
  if (!before || before.college_id !== actor.collegeId) throw new Error("Semester not found in your college.");
  if (before.status !== "planned") throw new Error("Only a planned semester can be deleted.");

  const { data: deleted, error } = await supabase
    .from("semesters")
    .delete()
    .eq("id", semesterId)
    .eq("college_id", actor.collegeId)
    .eq("status", "planned")
    .select("id");
  if (error) throw explain(error);
  assertClaimed(deleted, "semester");

  await logAudit(supabase, actor, `Deleted planned semester ${before.name}`, "semesters", semesterId, {
    oldValue: { name: before.name, status: before.status },
  });
}

function label(table: "semesters" | "academic_years") {
  return table === "semesters" ? "Semester" : "Academic year";
}

function revalidate() {
  revalidatePath("/admin/academic-periods");
}

// ---- Web Server Actions -------------------------------------------------

export async function createAcademicYear(params: CreateAcademicYearParams) {
  const actor = await requireRole(ACADEMIC_PERIOD_ROLES);
  const supabase = await createClient();
  const id = await createAcademicYearCore(supabase, actor, params);
  revalidate();
  return id;
}

export async function createSemester(params: CreateSemesterParams) {
  const actor = await requireRole(ACADEMIC_PERIOD_ROLES);
  const supabase = await createClient();
  const id = await createSemesterCore(supabase, actor, params);
  revalidate();
  return id;
}

export async function updateSemester(params: UpdateSemesterParams) {
  const actor = await requireRole(ACADEMIC_PERIOD_ROLES);
  const supabase = await createClient();
  await updateSemesterCore(supabase, actor, params);
  revalidate();
}

export async function transitionSemester(semesterId: string, transition: PeriodTransition) {
  const actor = await requireRole(ACADEMIC_PERIOD_ROLES);
  const supabase = await createClient();
  await transitionSemesterCore(supabase, actor, semesterId, transition);
  revalidate();
}

export async function transitionAcademicYear(academicYearId: string, transition: PeriodTransition) {
  const actor = await requireRole(ACADEMIC_PERIOD_ROLES);
  const supabase = await createClient();
  await transitionAcademicYearCore(supabase, actor, academicYearId, transition);
  revalidate();
}

export async function deleteSemester(semesterId: string) {
  const actor = await requireRole(ACADEMIC_PERIOD_ROLES);
  const supabase = await createClient();
  await deleteSemesterCore(supabase, actor, semesterId);
  revalidate();
}
