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

  it("only hod can invite teacher or student", () => {
    for (const target of ["teacher", "student"] as UserRole[]) {
      for (const role of ALL_ROLES) {
        expect(canInvite(role, target)).toBe(role === "hod");
      }
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

  it("teacher, finance, warden, student, and placement_cell invite no one", () => {
    for (const role of ["teacher", "finance", "warden", "student", "placement_cell"] as UserRole[]) {
      expect(INVITE_PERMISSIONS[role]).toEqual([]);
    }
  });
});
