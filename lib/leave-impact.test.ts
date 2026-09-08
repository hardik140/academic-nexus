import { describe, it, expect } from "vitest";
import { computeAffectedClasses, type TimetableSlotForImpact } from "@/lib/leave-impact";

function slot(overrides: Partial<TimetableSlotForImpact> = {}): TimetableSlotForImpact {
  return {
    id: "slot-1",
    course_id: "course-1",
    day_of_week: 1, // Monday
    start_time: "09:00:00",
    end_time: "10:00:00",
    ...overrides,
  };
}

describe("computeAffectedClasses", () => {
  it("returns one affected class per matching day within a single-day range", () => {
    // 2026-03-02 is a Monday
    const result = computeAffectedClasses("2026-03-02", "2026-03-02", [slot()]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ date: "2026-03-02", slotId: "slot-1", courseId: "course-1" });
  });

  it("matches every occurrence of the slot's day-of-week across a multi-week range", () => {
    // Monday 2026-03-02 through Sunday 2026-03-15 (two full weeks) contains two Mondays
    const result = computeAffectedClasses("2026-03-02", "2026-03-15", [slot()]);
    expect(result.map((r) => r.date)).toEqual(["2026-03-02", "2026-03-09"]);
  });

  it("returns no affected classes when the range contains no matching day-of-week", () => {
    // 2026-03-03 through 2026-03-03 is a Tuesday; slot is Monday-only
    const result = computeAffectedClasses("2026-03-03", "2026-03-03", [slot()]);
    expect(result).toHaveLength(0);
  });

  it("returns no affected classes for a teacher with no timetable slots", () => {
    const result = computeAffectedClasses("2026-03-02", "2026-03-08", []);
    expect(result).toHaveLength(0);
  });

  it("includes multiple slots on the same matching day", () => {
    const result = computeAffectedClasses("2026-03-02", "2026-03-02", [
      slot({ id: "slot-1", course_id: "course-1" }),
      slot({ id: "slot-2", course_id: "course-2", start_time: "11:00:00", end_time: "12:00:00" }),
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.courseId).sort()).toEqual(["course-1", "course-2"]);
  });

  it("is inclusive of both the start and end date", () => {
    // 2026-03-02 (Mon) through 2026-03-03 (Tue) — only the Monday matches
    const result = computeAffectedClasses("2026-03-02", "2026-03-03", [slot()]);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("2026-03-02");
  });
});
