import { describe, it, expect } from "vitest";
import { resolveProfileStatusForAcademicTransition, type StudentAcademicStatus } from "@/lib/student-lifecycle";

describe("resolveProfileStatusForAcademicTransition", () => {
  it("maps 'graduated' to 'alumni'", () => {
    expect(resolveProfileStatusForAcademicTransition("graduated")).toBe("alumni");
  });

  it.each<StudentAcademicStatus>(["active", "suspended", "dropped", "on_leave"])(
    "does not touch profiles.status for '%s' — narrow mapping, not a blanket policy",
    (status) => {
      expect(resolveProfileStatusForAcademicTransition(status)).toBeNull();
    }
  );
});
