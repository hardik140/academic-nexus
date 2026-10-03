import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currentTermEnrolledOfferingIds, currentTermTaughtOfferingIds } from "@/lib/academic/timetable";

/**
 * Defect 2 (migration 055) — a student's timetable is their own enrolled
 * offerings in the active term, never the college's.
 */
describe("timetable offering selection", () => {
  const term = (status: string) => ({ semesters: { status } });

  it("a student: enrolled + active term only, de-duplicated", () => {
    expect(
      currentTermEnrolledOfferingIds([
        { offering_id: "now", status: "enrolled", course_offerings: term("active") },
        { offering_id: "history", status: "enrolled", course_offerings: term("closed") },
        { offering_id: "reopened", status: "enrolled", course_offerings: term("reopened") },
        { offering_id: "dropped", status: "dropped", course_offerings: term("active") },
        { offering_id: "now", status: "enrolled", course_offerings: term("active") },
      ])
    ).toEqual(["now"]);
    expect(currentTermEnrolledOfferingIds(undefined)).toEqual([]);
  });

  it("a teacher: active term, cancelled excluded", () => {
    expect(
      currentTermTaughtOfferingIds([
        { id: "now", status: "active", ...term("active") },
        { id: "planned-now", status: "planned", ...term("active") },
        { id: "cancelled", status: "cancelled", ...term("active") },
        { id: "history", status: "completed", ...term("closed") },
      ])
    ).toEqual(["now", "planned-now"]);
  });

  it("the mobile copy states the same rule (they cannot import each other)", () => {
    const strip = (p: string) =>
      readFileSync(join(process.cwd(), p), "utf8")
        .replace(/\r\n/g, "\n")
        .replace(/\/\*\*[\s\S]*?\*\//g, "")
        .replace(/export const DAY_NAMES[^\n]*\n/, "")
        .trim();
    expect(strip("mobile/src/lib/academic.ts")).toBe(strip("lib/academic/timetable.ts"));
  });
});
