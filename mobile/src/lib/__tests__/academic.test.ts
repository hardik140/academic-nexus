import { currentTermEnrolledOfferingIds, currentTermTaughtOfferingIds } from "../academic";

/**
 * Defect 2 (migration 055): the student timetable listed every slot in the
 * college. The mobile screen now shows only the student's own enrolled
 * offerings in the active term — the same rule as the web and the database.
 */
describe("timetable offering selection", () => {
  const term = (status: string) => ({ semesters: { status } });

  it("a student sees only enrolled offerings of the ACTIVE term", () => {
    expect(
      currentTermEnrolledOfferingIds([
        { offering_id: "now", status: "enrolled", course_offerings: term("active") },
        { offering_id: "history", status: "enrolled", course_offerings: term("closed") },
        { offering_id: "next", status: "enrolled", course_offerings: term("planned") },
        { offering_id: "dropped", status: "dropped", course_offerings: term("active") },
        { offering_id: "now", status: "enrolled", course_offerings: term("active") },
      ])
    ).toEqual(["now"]);
  });

  it("nothing enrolled, or rows without a term, shows nothing — never the whole college", () => {
    expect(currentTermEnrolledOfferingIds([])).toEqual([]);
    expect(currentTermEnrolledOfferingIds(null)).toEqual([]);
    expect(currentTermEnrolledOfferingIds([{ offering_id: "x", status: "enrolled", course_offerings: null }])).toEqual([]);
  });

  it("a teacher sees only non-cancelled offerings of the active term", () => {
    expect(
      currentTermTaughtOfferingIds([
        { id: "now", status: "active", ...term("active") },
        { id: "cancelled", status: "cancelled", ...term("active") },
        { id: "history", status: "completed", ...term("closed") },
      ])
    ).toEqual(["now"]);
  });
});
