import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { academicRpc } from "@/lib/academic/rpc";
import { createInvitationCore, deliverInvitation, discardInvitation } from "@/lib/invitations";

/**
 * Inviting a STUDENT (ACADEMIC_LIFECYCLE_CONTRACT.md §11, decision 3).
 *
 * Shared by the HOD's team page, the Class In-Charge's class page and the
 * mobile HOD invite route, so the three cannot disagree. The placement — the
 * department, programme, class and section the student will join — is
 * resolved by the database from the SECTION the inviter chose, and the
 * database decides whether this inviter may place a student there at all
 * (the HOD of the section's department, or the section's current Class
 * In-Charge). The client never supplies a department.
 *
 *   1. preflight   read-only: may this actor place a student in this
 *                  section; is the enrollment number free; is the programme
 *                  semester in range. Nothing exists yet, so a refusal here
 *                  leaves nothing behind.
 *   2. create      the auth account, the pending profile (with the RESOLVED
 *                  department) and the bookkeeping invitation row.
 *   3. place       the authoritative placement, re-verified by the database.
 *                  If it fails, step 2 is discarded — account removed,
 *                  invitation revoked — BEFORE anyone is emailed (defect 1).
 *   4. deliver     the email, only after the placement committed.
 *
 * Acceptance (accept_student_invitation, 055 §14) then creates the student
 * record, the section assignment and the enrolments in one transaction.
 */

export const StudentInviteSchema = z.object({
  email: z.string().trim().email({ message: "Enter a valid email address." }),
  fullName: z.string().trim().min(1, { message: "Full name is required." }).max(200),
  sectionId: z.string().guid({ message: "Choose a section." }),
  enrollmentNumber: z.string().trim().min(1, { message: "Enrollment number is required." }).max(50),
  programmeSemester: z.number().int().min(1, { message: "Choose the student's semester." }).max(20),
  parentName: z.string().trim().max(200).optional(),
  parentEmail: z.string().trim().max(200).optional(),
  parentPhone: z.string().trim().max(20).optional(),
});

export type StudentInviteParams = z.infer<typeof StudentInviteSchema>;

export interface StudentPlacementPreview {
  department_id: string;
  programme_id: string;
  section_id: string;
  semester_id: string;
  batch_year: number;
  section_label: string;
}

export async function inviteStudentCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  raw: StudentInviteParams
): Promise<{ userId: string; sectionLabel: string }> {
  const params = StudentInviteSchema.parse(raw);
  await checkRateLimit(`inviteStudent:${actor.userId}`, 20, 60);

  const preview = await academicRpc<StudentPlacementPreview>(supabase, "student_invitation_preflight", {
    p_section_id: params.sectionId,
    p_enrollment_number: params.enrollmentNumber,
    p_programme_semester: params.programmeSemester,
  });

  const created = await createInvitationCore(supabase, actor, {
    email: params.email,
    fullName: params.fullName,
    role: "student",
    departmentId: preview.department_id,
  });

  try {
    await academicRpc(supabase, "create_student_invitation_placement", {
      p_invitation_id: created.invitationId,
      p_section_id: params.sectionId,
      p_enrollment_number: params.enrollmentNumber,
      p_programme_semester: params.programmeSemester,
      p_parent_name: params.parentName || null,
      p_parent_email: params.parentEmail || null,
      p_parent_phone: params.parentPhone || null,
    });
  } catch (e) {
    await discardInvitation(supabase, created);
    throw e;
  }

  await deliverInvitation(supabase, actor, created);
  return { userId: created.userId, sectionLabel: preview.section_label };
}
