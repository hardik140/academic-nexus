import { describe, it, expect } from "vitest";
import {
  computeAcademicHealth,
  computeSubjectRisk,
  computeDegreeProgress,
  projectAttendance,
  RISK_THRESHOLDS,
} from "@/lib/academic-scoring";
import type { Database } from "@/types/database";

type AttendanceRow = Database["public"]["Tables"]["attendance"]["Row"];
type MarksRow = Database["public"]["Tables"]["marks"]["Row"];
type CourseEnrollmentRow = Database["public"]["Tables"]["course_enrollments"]["Row"];
type CourseRow = Database["public"]["Tables"]["courses"]["Row"];

function attendance(status: AttendanceRow["status"], overrides: Partial<AttendanceRow> = {}): AttendanceRow {
  return {
    id: "a1",
    college_id: "c1",
    student_id: "s1",
    course_id: "course-1",
    date: "2026-01-01",
    status,
    marked_by: "t1",
    remarks: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function enrollment(status: CourseEnrollmentRow["status"], overrides: Partial<CourseEnrollmentRow> = {}): CourseEnrollmentRow {
  return {
    id: "e1",
    college_id: "c1",
    student_id: "s1",
    course_id: "course-1",
    semester_id: null,
    status,
    grade: null,
    grade_points: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function course(overrides: Partial<CourseRow> = {}): CourseRow {
  return {
    id: "course-1",
    college_id: "c1",
    department_id: "d1",
    name: "Databases",
    code: "CS301",
    credits: 4,
    semester: 3,
    year: 2,
    type: "core",
    instructor_id: null,
    max_students: 60,
    description: null,
    syllabus_url: null,
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function marks(exam_type: MarksRow["exam_type"], obtained_marks: number, max_marks = 100, overrides: Partial<MarksRow> = {}): MarksRow {
  return {
    id: "m1",
    college_id: "c1",
    student_id: "s1",
    course_id: "course-1",
    exam_type,
    max_marks,
    obtained_marks,
    semester: 3,
    remarks: null,
    entered_by: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("computeAcademicHealth", () => {
  it("returns null when there is no data at all", () => {
    const result = computeAcademicHealth({ attendance: [], enrollments: [], cgpa: null });
    expect(result.score).toBeNull();
    expect(result.contributingCount).toBe(0);
    expect(result.possibleCount).toBe(3);
  });

  it("renormalizes weights when only one signal is available", () => {
    const result = computeAcademicHealth({
      attendance: [attendance("present"), attendance("absent")],
      enrollments: [],
      cgpa: null,
    });
    // Only attendance (50%) is available -> score should equal attendancePct itself.
    expect(result.breakdown.attendancePct).toBe(50);
    expect(result.score).toBe(50);
    expect(result.contributingCount).toBe(1);
  });

  it("combines all three signals with the documented weights", () => {
    const result = computeAcademicHealth({
      attendance: [attendance("present"), attendance("present"), attendance("present"), attendance("absent")],
      enrollments: [enrollment("completed"), enrollment("failed", { id: "e2", course_id: "course-2" })],
      cgpa: 8,
    });
    // attendance 75%, backlog inverse 50% (1 of 2 failed), cgpa 80%
    const expected = 75 * 0.5 + 50 * 0.3 + 80 * 0.2;
    expect(result.score).toBeCloseTo(expected, 5);
    expect(result.contributingCount).toBe(3);
  });

  it("does not treat a brand-new student's default cgpa of 0 as a real signal", () => {
    // students.cgpa defaults to 0.00 before any course is graded — with no
    // completed/failed enrollments backing it, this must read as "no data
    // yet", not a fabricated failing score.
    const result = computeAcademicHealth({ attendance: [], enrollments: [], cgpa: 0 });
    expect(result.breakdown.cgpaPct).toBeNull();
    expect(result.score).toBeNull();
  });

  it("trusts a real computed cgpa of 0 once there is graded coursework behind it", () => {
    const result = computeAcademicHealth({
      attendance: [],
      enrollments: [enrollment("failed")],
      cgpa: 0,
    });
    expect(result.breakdown.cgpaPct).toBe(0);
  });
});

describe("computeSubjectRisk", () => {
  it("flags high risk on low attendance", () => {
    const rows = [attendance("absent"), attendance("absent"), attendance("present")];
    const result = computeSubjectRisk({ course: { id: "course-1" }, attendanceRows: rows, marksRows: [] });
    expect(result.level).toBe("high");
    expect(result.reasons[0]).toContain("Attendance");
  });

  it("is low risk when attendance and marks are healthy", () => {
    const rows = Array.from({ length: 10 }, () => attendance("present"));
    const result = computeSubjectRisk({
      course: { id: "course-1" },
      attendanceRows: rows,
      marksRows: [marks("internal_1", 80)],
    });
    expect(result.level).toBe("low");
    expect(result.reasons).toHaveLength(0);
  });

  it("flags medium risk on a declining internal trend even with fine attendance", () => {
    const rows = Array.from({ length: 10 }, () => attendance("present"));
    const result = computeSubjectRisk({
      course: { id: "course-1" },
      attendanceRows: rows,
      marksRows: [marks("internal_1", 80), marks("internal_2", 60, 100, { id: "m2" })],
    });
    expect(result.level).toBe("medium");
    expect(result.reasons.some((r) => r.includes("declining"))).toBe(true);
  });

  it("treats the exact threshold boundary as not-yet-at-risk", () => {
    // Exactly attendanceMedium% present (75/100) — the condition is a
    // strict "<", so this boundary value itself must not be flagged.
    const present = Array.from({ length: RISK_THRESHOLDS.attendanceMedium }, () => attendance("present"));
    const absent = Array.from({ length: 100 - RISK_THRESHOLDS.attendanceMedium }, () => attendance("absent"));
    const result = computeSubjectRisk({
      course: { id: "course-1" },
      attendanceRows: [...present, ...absent],
      marksRows: [],
    });
    expect(result.level).toBe("low");
  });
});

describe("computeDegreeProgress", () => {
  it("buckets credits by course type and enrollment status", () => {
    const courses = [
      course({ id: "core-1", type: "core", credits: 4 }),
      course({ id: "elective-1", type: "elective", credits: 3 }),
    ];
    const enrollments = [
      enrollment("completed", { course_id: "core-1" }),
      enrollment("enrolled", { course_id: "elective-1", id: "e2" }),
      enrollment("failed", { course_id: "core-1", id: "e3" }),
    ];
    const result = computeDegreeProgress({
      enrollments,
      coursesById: new Map(courses.map((c) => [c.id, c])),
      creditsCompleted: 4,
      creditsRequired: 160,
    });
    expect(result.byCategory.core).toEqual({ completed: 4, inProgress: 0, blocked: 4 });
    expect(result.byCategory.elective).toEqual({ completed: 0, inProgress: 3, blocked: 0 });
    expect(result.byCategory.lab).toEqual({ completed: 0, inProgress: 0, blocked: 0 });
  });
});

describe("projectAttendance", () => {
  it("projects forward assuming full attendance", () => {
    const result = projectAttendance({ present: 7, total: 10, nextClasses: 5, attendRate: 1 });
    expect(result.projectedPct).toBe(80); // (7+5)/(10+5)
    expect(result.label).toBe("Projection");
  });

  it("projects forward assuming zero attendance", () => {
    const result = projectAttendance({ present: 7, total: 10, nextClasses: 5, attendRate: 0 });
    expect(result.projectedPct).toBeCloseTo(46.7, 1); // 7/15
  });

  it("returns null when there is nothing to project over", () => {
    const result = projectAttendance({ present: 0, total: 0, nextClasses: 0, attendRate: 1 });
    expect(result.projectedPct).toBeNull();
  });
});
