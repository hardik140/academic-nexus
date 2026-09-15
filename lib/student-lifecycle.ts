/**
 * Pure, deterministic student-lifecycle helpers — no AI, no DB access.
 *
 * `students.status` and `profiles.status` answer two different questions
 * ("what is this student's academic standing" vs. "can this person log in")
 * and use two different value sets — they were never meant to be a blind
 * mirror of each other. This resolves the one mapping between them that's
 * actually unambiguous, so app/(portal)/admin/users/actions.ts's
 * updateStudentAcademicStatusCore doesn't have to invent institutional
 * policy inline.
 */

export type StudentAcademicStatus = "active" | "suspended" | "graduated" | "dropped" | "on_leave";
export type ProfileAccessStatus = "alumni";

/**
 * Only 'graduated' has an unambiguous profiles.status mapping ('alumni' —
 * a value that already exists in the schema with no prior write-path).
 * Everything else returns null — deliberately not inventing a broader
 * access-revocation policy this codebase has no basis to assume. An admin
 * who also wants to revoke login for a dropped/suspended student uses the
 * existing, separate Suspend button.
 */
export function resolveProfileStatusForAcademicTransition(newStatus: StudentAcademicStatus): ProfileAccessStatus | null {
  return newStatus === "graduated" ? "alumni" : null;
}
