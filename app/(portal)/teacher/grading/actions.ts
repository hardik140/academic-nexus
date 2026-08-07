"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import type { Database } from "@/types/database";

type ExamType = Database["public"]["Tables"]["marks"]["Row"]["exam_type"];

export interface MarkEntry {
  studentDbId: string;
  obtainedMarks: number;
}

export async function saveMarks(params: {
  courseId: string;
  examType: ExamType;
  maxMarks: number;
  entries: MarkEntry[];
}) {
  const { courseId, examType, maxMarks, entries } = params;
  const actor = await requireRole(["teacher", "admin"]);
  const supabase = await createClient();

  const { data: course } = await supabase
    .from("courses")
    .select("instructor_id")
    .eq("id", courseId)
    .single();

  if (!course) {
    throw new Error("Course not found.");
  }

  // A teacher may only grade their own course; admin can grade any.
  // RLS (marks_teacher_manage) only checks role, not course ownership —
  // this is the layer that actually closes that gap.
  if (actor.role === "teacher" && course.instructor_id !== actor.userId) {
    throw new Error("You can only enter marks for courses you teach.");
  }

  if (!(maxMarks > 0)) {
    throw new Error("Max marks must be greater than zero.");
  }

  const rows = entries
    .filter((e) => Number.isFinite(e.obtainedMarks))
    .map((e) => ({
      college_id: actor.collegeId,
      student_id: e.studentDbId,
      course_id: courseId,
      exam_type: examType,
      max_marks: maxMarks,
      obtained_marks: Math.min(Math.max(e.obtainedMarks, 0), maxMarks),
      entered_by: actor.userId,
    }));

  if (rows.length === 0) {
    return { saved: 0 };
  }

  const { error } = await supabase
    .from("marks")
    .upsert(rows, { onConflict: "student_id,course_id,exam_type" });

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath("/teacher/grading");
  return { saved: rows.length };
}
