import { describe, it, expect } from "vitest";
import { canInvite, INVITE_PERMISSIONS } from "@/lib/auth/invite-tiers";
import type { UserRole } from "@/types/database";

const ALL_ROLES: UserRole[] = [
  "student",
  "teacher",
  "hod",
  "finance",
  "director",
  "admin",
  "warden",
  "super_admin",
  "placement_cell",
];

/**
 * The actor-role x target-role dimension doesn't fit tests/rbac-matrix.ts's
 * flat role x action shape (that file's cross-product assumes one
 * allow-list per action, not per (actor, target) pair) — a small dedicated
 * suite instead of distorting the existing one.
 */
describe("canInvite — INVITE_PERMISSIONS cascade", () => {
  const cases: Array<[UserRole, UserRole]> = ALL_ROLES.flatMap((actorRole) =>
    ALL_ROLES.map((targetRole) => [actorRole, targetRole] as [UserRole, UserRole])
  );

  it.each(cases)("actor=%s inviting target=%s matches INVITE_PERMISSIONS", (actorRole, targetRole) => {
    const expected = INVITE_PERMISSIONS[actorRole].includes(targetRole);
    expect(canInvite(actorRole, targetRole)).toBe(expected);
  });

  it("only super_admin can invite admin", () => {
    for (const role of ALL_ROLES) {
      expect(canInvite(role, "admin")).toBe(role === "super_admin");
    }
  });

  it("only admin can invite director", () => {
    for (const role of ALL_ROLES) {
      expect(canInvite(role, "director")).toBe(role === "admin");
    }
  });

  it("only director can invite finance, hod, or warden", () => {
    for (const target of ["finance", "hod", "warden"] as UserRole[]) {
      for (const role of ALL_ROLES) {
        expect(canInvite(role, target)).toBe(role === "director");
      }
    }
  });

  it("only hod can invite a teacher; hod and teacher (a Class In-Charge, 055) can invite a student", () => {
    for (const role of ALL_ROLES) {
      expect(canInvite(role, "teacher")).toBe(role === "hod");
      // The teacher grant is relationship-scoped in the database: only a
      // CURRENT Class In-Charge, and only into their own section.
      expect(canInvite(role, "student")).toBe(role === "hod" || role === "teacher");
    }
  });

  it("only director can invite placement_cell — Admin structurally cannot assign it", () => {
    for (const role of ALL_ROLES) {
      expect(canInvite(role, "placement_cell")).toBe(role === "director");
    }
  });

  it("no one can invite a super_admin — that's bootstrap-only", () => {
    for (const role of ALL_ROLES) {
      expect(canInvite(role, "super_admin")).toBe(false);
    }
  });

  it("finance, warden, student, and placement_cell invite no one; a teacher invites only students", () => {
    for (const role of ["finance", "warden", "student", "placement_cell"] as UserRole[]) {
      expect(INVITE_PERMISSIONS[role]).toEqual([]);
    }
    expect(INVITE_PERMISSIONS.teacher).toEqual(["student"]);
  });
});
