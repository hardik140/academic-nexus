/**
 * Which offerings a timetable shows — the mobile copy of the web's
 * lib/academic/timetable.ts, and the same rule as the database's
 * my_academic_context() (migration 055). The mobile app is a separate
 * package and cannot import the web module, so the rule is restated here and
 * pinned by its own test; any change must be made in both places.
 *
 *   student  slots of offerings they are ENROLLED in during the ACTIVE term
 *   teacher  slots of offerings they teach in the ACTIVE term
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
