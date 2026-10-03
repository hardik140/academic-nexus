"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { assertRead } from "@/lib/read-result-server";
import { inviteStudentCore, type StudentInviteParams } from "@/lib/student-invitations";
import type { MyClass } from "@/lib/academic/types";

/**
 * The Class In-Charge's own sections for the active term (migration 055).
 * Being In-Charge is an explicit assignment by the HOD — teaching a section
 * does not make anyone its In-Charge — so a teacher with no assignment sees
 * an empty page, not their teaching sections.
 */
export async function getMyClasses(): Promise<{ term: string | null; classes: MyClass[] }> {
  const actor = await requireRole(PERMISSIONS.student_invite);
  const supabase = await createClient();

  const { data: term, error: termError } = await supabase
    .from("semesters")
    .select("id, name")
    .eq("college_id", actor.collegeId)
    .eq("status", "active")
    .maybeSingle();
  assertRead(termError);
  if (!term) return { term: null, classes: [] };

  const { data: rows, error } = await supabase
    .from("section_class_incharges")
    .select("section_id, sections:section_id(id, name, batch_year, programmes:programme_id(code, duration_semesters))")
    .eq("teacher_id", actor.userId)
    .eq("semester_id", term.id)
    .is("ended_at", null);
  assertRead(error);
  const sections = ((rows ?? []) as unknown as {
    section_id: string;
    sections: { id: string; name: string; batch_year: number; programmes: { code: string; duration_semesters: number } };
  }[]);
  if (sections.length === 0) return { term: term.name, classes: [] };

  const { data: members, error: membersError } = await supabase
    .from("student_section_assignments")
    .select("section_id, students:student_id(id, enrollment_number, semester, status, profiles:user_id(full_name))")
    .is("ended_at", null)
    .in("section_id", sections.map((s) => s.section_id).filter(Boolean));
  assertRead(membersError);
  const bySection = new Map<string, MyClass["students"]>();
  for (const m of (members ?? []) as unknown as {
    section_id: string;
    students: { id: string; enrollment_number: string; semester: number; status: string; profiles: { full_name: string } | null };
  }[]) {
    if (!m.students?.id) continue;
    const list = bySection.get(m.section_id) ?? [];
    list.push({
      student_id: m.students.id,
      full_name: m.students.profiles?.full_name ?? null,
      enrollment_number: m.students.enrollment_number ?? "",
      semester: m.students.semester,
      status: m.students.status,
    });
    bySection.set(m.section_id, list);
  }

  return {
    term: term.name,
    classes: sections.map((s) => ({
      section_id: s.section_id,
      label: `${s.sections?.programmes?.code ?? ""} ${s.sections?.name ?? ""} (${s.sections?.batch_year ?? ""})`.trim(),
      duration_semesters: s.sections?.programmes?.duration_semesters ?? 1,
      students: (bySection.get(s.section_id) ?? []).sort((a, b) => a.enrollment_number.localeCompare(b.enrollment_number)),
    })),
  };
}

/**
 * Invites a student into the caller's own section. The database decides
 * that the caller is that section's CURRENT Class In-Charge (or its
 * department's HOD); any other section is refused there, whatever the
 * client sent.
 */
export async function inviteStudentToMyClass(params: StudentInviteParams) {
  const actor = await requireRole(PERMISSIONS.student_invite);
  const supabase = await createClient();
  const result = await inviteStudentCore(supabase, actor, params);
  revalidatePath("/teacher/class");
  return { sectionLabel: result.sectionLabel };
}
