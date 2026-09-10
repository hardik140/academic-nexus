import type { Database } from "@/types/database";

type CourseEnrollmentRow = Database["public"]["Tables"]["course_enrollments"]["Row"];
type CourseRow = Database["public"]["Tables"]["courses"]["Row"];
type AttendanceRow = Database["public"]["Tables"]["attendance"]["Row"];
type MarksRow = Database["public"]["Tables"]["marks"]["Row"];
type CourseType = CourseRow["type"];

const COURSE_TYPES: CourseType[] = ["core", "elective", "lab", "project", "seminar"];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function attendancePctOf(rows: AttendanceRow[]): number | null {
  if (rows.length === 0) return null;
  const present = rows.filter((r) => r.status === "present" || r.status === "late").length;
  return round1((present / rows.length) * 100);
}

// ================================================================
// Academic Health — same weights/shape as the director Command Center's
// institution-level academic_score (app/api/cron/snapshot-health-score),
// just computed for one student instead of averaged across departments:
// attendance 50% + inverse-backlog-rate 30% + (cgpa/10) 20%. A signal that
// has no underlying data is `null`, never defaulted to 0 — matching the
// cron's "never fabricate" rule — and the final score renormalizes the
// weights across whichever signals actually have data, so one missing
// signal doesn't silently drag the score down.
// ================================================================

export interface AcademicHealthResult {
  score: number | null;
  contributingCount: number;
  possibleCount: number;
  breakdown: {
    attendancePct: number | null;
    backlogInversePct: number | null;
    cgpaPct: number | null;
  };
}

const HEALTH_WEIGHTS = { attendance: 0.5, backlog: 0.3, cgpa: 0.2 };

export function computeAcademicHealth(input: {
  attendance: AttendanceRow[];
  enrollments: CourseEnrollmentRow[];
  cgpa: number | null;
}): AcademicHealthResult {
  const attendancePct = attendancePctOf(input.attendance);

  const backlogInversePct =
    input.enrollments.length === 0
      ? null
      : round1(100 - (input.enrollments.filter((e) => e.status === "failed").length / input.enrollments.length) * 100);

  // students.cgpa defaults to 0.00 (not null) until at least one course is
  // actually graded — trusting it at face value for a brand-new student
  // would render as a fabricated "0/100" health score, not "no data yet".
  // Gate it on real evidence: at least one completed/failed enrollment.
  const hasGradedCoursework = input.enrollments.some((e) => e.status === "completed" || e.status === "failed");
  const cgpaPct = input.cgpa == null || !hasGradedCoursework ? null : round1((input.cgpa / 10) * 100);

  const signals: Array<[number | null, number]> = [
    [attendancePct, HEALTH_WEIGHTS.attendance],
    [backlogInversePct, HEALTH_WEIGHTS.backlog],
    [cgpaPct, HEALTH_WEIGHTS.cgpa],
  ];
  const available = signals.filter((s): s is [number, number] => s[0] != null);
  const weightSum = available.reduce((s, [, w]) => s + w, 0);
  const score = available.length === 0 ? null : round1(available.reduce((s, [v, w]) => s + v * w, 0) / weightSum);

  return {
    score,
    contributingCount: available.length,
    possibleCount: signals.length,
    breakdown: { attendancePct, backlogInversePct, cgpaPct },
  };
}

// ================================================================
// Per-subject Academic Risk Radar — thresholds are named constants (not
// magic numbers) precisely so the "why" behind a risk level is inspectable
// and explainable, per the no-hidden-algorithm requirement: every level is
// backed by plain-language reasons built from the actual numbers.
// ================================================================

export const RISK_THRESHOLDS = {
  attendanceHigh: 65,
  attendanceMedium: 75,
  marksHigh: 40,
  marksMedium: 60,
  trendDeclineMargin: 5,
} as const;

export type RiskLevel = "high" | "medium" | "low";

export interface SubjectRiskResult {
  /** The offering the risk was computed over, not the catalog course. */
  offeringId: string;
  level: RiskLevel;
  reasons: string[];
}

const EXAM_LABELS: Record<MarksRow["exam_type"], string> = {
  internal_1: "Internal-1",
  internal_2: "Internal-2",
  midterm: "Midterm",
  final: "Final",
  assignment: "Assignment",
  lab: "Lab",
  project: "Project",
  viva: "Viva",
};

/** Preferred exam to represent "current standing" — most comprehensive/recent first. */
const LATEST_EXAM_PRIORITY: MarksRow["exam_type"][] = ["final", "midterm", "internal_2", "internal_1"];

export function computeSubjectRisk(input: {
  /**
   * The delivery being assessed, not the catalog entry. Risk is a statement
   * about how a student is doing in a class they actually sit in — and a
   * student who retakes a course has two of those, each with its own
   * attendance and marks, which the course id alone cannot tell apart.
   */
  offering: { id: string };
  attendanceRows: AttendanceRow[];
  marksRows: MarksRow[];
}): SubjectRiskResult {
  const reasons: string[] = [];
  let level: RiskLevel = "low";
  const raiseTo = (l: RiskLevel) => {
    if (l === "high" || (l === "medium" && level === "low")) level = l;
  };

  const attendancePct = attendancePctOf(input.attendanceRows);
  if (attendancePct != null) {
    if (attendancePct < RISK_THRESHOLDS.attendanceHigh) {
      raiseTo("high");
      reasons.push(`Attendance ${attendancePct}% — well below the ${RISK_THRESHOLDS.attendanceMedium}% requirement`);
    } else if (attendancePct < RISK_THRESHOLDS.attendanceMedium) {
      raiseTo("medium");
      reasons.push(`Attendance ${attendancePct}% — below the ${RISK_THRESHOLDS.attendanceMedium}% requirement`);
    }
  }

  const marksByType = new Map(input.marksRows.map((m) => [m.exam_type, m]));
  const latestType = LATEST_EXAM_PRIORITY.find((t) => marksByType.has(t));
  if (latestType) {
    const m = marksByType.get(latestType)!;
    const pct = round1((m.obtained_marks / m.max_marks) * 100);
    if (pct < RISK_THRESHOLDS.marksHigh) {
      raiseTo("high");
      reasons.push(`${EXAM_LABELS[latestType]} score ${pct}% — below the pass threshold`);
    } else if (pct < RISK_THRESHOLDS.marksMedium) {
      raiseTo("medium");
      reasons.push(`${EXAM_LABELS[latestType]} score ${pct}% — trending low`);
    }
  }

  const i1 = marksByType.get("internal_1");
  const i2 = marksByType.get("internal_2");
  if (i1 && i2) {
    const pct1 = round1((i1.obtained_marks / i1.max_marks) * 100);
    const pct2 = round1((i2.obtained_marks / i2.max_marks) * 100);
    if (pct2 < pct1 - RISK_THRESHOLDS.trendDeclineMargin) {
      raiseTo("medium");
      reasons.push(`Internal marks trend declining (Internal-1 ${pct1}% → Internal-2 ${pct2}%)`);
    }
  }

  return { offeringId: input.offering.id, level, reasons };
}

// Shared by the dashboard's Attention Required panel and the Insights
// page's full Risk Radar so the two never compute risk differently —
// currently-enrolled courses only (a "failed"/"dropped" enrollment is a
// degree-progress concern, not an in-progress risk to react to today).
export interface EnrolledSubjectRisk {
  offeringId: string;
  /** Catalog details for display, resolved through the offering. */
  course: { id: string; name: string; code: string } | null;
  /** Which section and semester this delivery is, when the caller has them. */
  section: { name: string } | null;
  risk: SubjectRiskResult;
}

/**
 * One risk row per ENROLLED OFFERING.
 *
 * Keyed on offering_id rather than course_id, which is what makes two
 * simultaneous sections of the same course, and a retake in a later
 * semester, distinct rows instead of one row silently pooling both sets of
 * attendance. The course is carried alongside purely as the label a student
 * recognises.
 */
export function buildSubjectRisks(input: {
  enrollments: Array<{
    offering_id: string;
    status: CourseEnrollmentRow["status"];
    course_offerings?: {
      id: string;
      courses?: { id: string; name: string; code: string } | null;
      sections?: { name: string } | null;
    } | null;
  }>;
  attendance: AttendanceRow[];
  marks: MarksRow[];
}): EnrolledSubjectRisk[] {
  return input.enrollments
    .filter((e) => e.status === "enrolled")
    .map((e) => ({
      offeringId: e.offering_id,
      course: e.course_offerings?.courses ?? null,
      section: e.course_offerings?.sections ?? null,
      risk: computeSubjectRisk({
        offering: { id: e.offering_id },
        attendanceRows: input.attendance.filter((a) => a.offering_id === e.offering_id),
        marksRows: input.marks.filter((m) => m.offering_id === e.offering_id),
      }),
    }));
}

// ================================================================
// Degree Progress — buckets completed/in-progress/failed-or-dropped
// credits by courses.type. Purely a re-grouping of data the app already
// has (course_enrollments + courses.type/credits); no new schema.
// ================================================================

export interface DegreeProgressResult {
  creditsCompleted: number;
  creditsRequired: number;
  byCategory: Record<CourseType, { completed: number; inProgress: number; blocked: number }>;
}

export function computeDegreeProgress(input: {
  enrollments: Array<Pick<CourseEnrollmentRow, "offering_id" | "status">>;
  /**
   * offering id -> the course being delivered. Keyed by OFFERING because an
   * enrollment now names one; the caller resolves the hop once rather than
   * every consumer re-deriving it.
   *
   * A retake therefore counts its credits once per attempt, in whichever
   * bucket that attempt landed in — the failed one under `blocked`, the
   * later pass under `completed`. Under the old course-keyed shape the two
   * attempts collapsed into a single entry and one of them vanished.
   */
  coursesByOfferingId: Map<string, CourseRow>;
  creditsCompleted: number;
  creditsRequired: number;
}): DegreeProgressResult {
  const byCategory = Object.fromEntries(
    COURSE_TYPES.map((t) => [t, { completed: 0, inProgress: 0, blocked: 0 }])
  ) as DegreeProgressResult["byCategory"];

  for (const enrollment of input.enrollments) {
    const course = input.coursesByOfferingId.get(enrollment.offering_id);
    if (!course) continue;
    const bucket = byCategory[course.type];
    if (enrollment.status === "completed") bucket.completed += course.credits;
    else if (enrollment.status === "enrolled") bucket.inProgress += course.credits;
    else if (enrollment.status === "failed" || enrollment.status === "dropped") bucket.blocked += course.credits;
  }

  return { creditsCompleted: input.creditsCompleted, creditsRequired: input.creditsRequired, byCategory };
}

// ================================================================
// Attendance Forecast — pure linear projection over the real
// present/total counts already on hand. Always labeled "Projection" by
// callers so it's never read as a guarantee.
// ================================================================

export interface AttendanceProjection {
  projectedPct: number | null;
  label: "Projection";
}

export function projectAttendance(input: {
  present: number;
  total: number;
  nextClasses: number;
  attendRate: number;
}): AttendanceProjection {
  const projectedTotal = input.total + input.nextClasses;
  if (projectedTotal <= 0) return { projectedPct: null, label: "Projection" };
  const projectedPresent = input.present + input.nextClasses * input.attendRate;
  return { projectedPct: round1((projectedPresent / projectedTotal) * 100), label: "Projection" };
}
