/**
 * Which offerings a timetable should show (migration 055, defect 2).
 *
 * A student's timetable is the slots of the offerings they are ENROLLED in
 * during the ACTIVE term; a teacher's is the slots of the offerings they
 * teach in the active term. History stays attached to its own offerings and
 * is never shown as this week's classes.
 *
 * This is the same rule as my_academic_context().offering_ids in 055 — and
 * the same rule as mobile/src/lib/academic.ts — stated over rows the screens
 * already read, so the schedule keeps working on a database that predates
 * 055. Web and mobile therefore cannot show different weeks.
 */

export interface EnrollmentWithTerm {
  offering_id: string;
  status: string;
  course_offerings?: { semesters?: { status?: string | null } | null } | null;
}

export interface OfferingWithTerm {
  id: string;
  status?: string | null;
  semesters?: { status?: string | null } | null;
}

export function currentTermEnrolledOfferingIds(rows: readonly EnrollmentWithTerm[] | null | undefined): string[] {
  const ids = new Set<string>();
  for (const row of rows ?? []) {
    if (row.status === "enrolled" && row.course_offerings?.semesters?.status === "active") ids.add(row.offering_id);
  }
  return [...ids];
}

export function currentTermTaughtOfferingIds(rows: readonly OfferingWithTerm[] | null | undefined): string[] {
  const ids = new Set<string>();
  for (const row of rows ?? []) {
    if (row.semesters?.status === "active" && row.status !== "cancelled") ids.add(row.id);
  }
  return [...ids];
}

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
