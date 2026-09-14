"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifyStudentsEnrolled } from "@/lib/course-enrollment";
import { assertCanWriteOfferingRecords } from "@/lib/offerings";
import { assertPersisted } from "@/lib/concurrent-claim";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { dbError } from "@/lib/internal-error";

type ExamType = Database["public"]["Tables"]["marks"]["Row"]["exam_type"];

const EXAM_TYPES = [
  "internal_1", "internal_2", "midterm", "final", "assignment", "lab", "project", "viva",
] as const;

const SaveMarksSchema = z.object({
  offeringId: z.string().guid(),
  examType: z.enum(EXAM_TYPES),
  maxMarks: z.number().positive({ message: "Max marks must be greater than zero." }),
  entries: z
    .array(
      z.object({
        studentDbId: z.string().guid(),
        obtainedMarks: z.number(),
      })
    )
    .max(500),
});

export interface MarkEntry {
  studentDbId: string;
  obtainedMarks: number;
}

export interface SaveMarksParams {
  /** A course_offerings.id, not a courses.id. */
  offeringId: string;
  examType: ExamType;
  maxMarks: number;
  entries: MarkEntry[];
}

/**
 * Shared by the web Server Action below and app/api/mobile/grading/save's
 * Route Handler — same guarded logic either way, just a different transport.
 */
export async function saveMarksCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: SaveMarksParams
) {
  const { offeringId, examType, maxMarks, entries } = SaveMarksSchema.parse(params);
  await checkRateLimit(`saveMarks:${actor.userId}`, 30, 60);

  // Same offering-derived authority as attendance: only the assigned
  // instructor (teaching HOD included) or an admin may enter marks, re-read
  // server-side. Teacher A cannot grade Teacher B's offering by changing an
  // id in the request. No substitute path here — covering one class does not
  // confer authority over a section's assessment record.
  const offering = await assertCanWriteOfferingRecords(supabase, actor, offeringId);

  // RLS authorizes the OFFERING, never the individual student_id in each row
  // (marks_insert_instructor, 047 §7b). Binding every submitted row to the
  // offering it claims to belong to is this check's job, and it rejects the
  // whole request rather than dropping rows. See lib/course-enrollment.ts.
  await verifyStudentsEnrolled(supabase, offering.id, entries.map((e) => e.studentDbId));

  const rows = entries
    .filter((e) => Number.isFinite(e.obtainedMarks))
    .map((e) => ({
      college_id: actor.collegeId,
      student_id: e.studentDbId,
      offering_id: offering.id,
      exam_type: examType,
      max_marks: maxMarks,
      obtained_marks: Math.min(Math.max(e.obtainedMarks, 0), maxMarks),
      entered_by: actor.userId,
    }));

  if (rows.length === 0) {
    return { saved: 0 };
  }

  // Measured, not claimed — same reasoning as saveAttendanceCore. A marks
  // sheet is the record a degree classification is computed from; reporting
  // it saved when it was refused is the worst possible failure mode here.
  const { data: persisted, error } = await supabase
    .from("marks")
    .upsert(rows, { onConflict: "offering_id,student_id,exam_type" })
    .select("id");

  if (error) {
    throw dbError(error);
  }

  return { saved: assertPersisted(persisted, rows.length, "marks") };
}

export async function saveMarks(params: SaveMarksParams) {
  // 'hod' — see the identical widening in teacher/attendance/actions.ts.
  const actor = await requireRole(["teacher", "hod", "admin"]);
  const supabase = await createClient();
  const result = await saveMarksCore(supabase, actor, params);
  revalidatePath("/teacher/grading");
  return result;
}

/** Called by app/api/mobile/grading/save/route.ts. */
export async function saveMarksViaRequest(request: Request, params: SaveMarksParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["teacher", "hod", "admin"]);
  return saveMarksCore(supabase, actor, params);
}
