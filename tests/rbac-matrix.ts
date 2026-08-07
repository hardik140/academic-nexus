import type { UserRole } from "@/types/database";

export const ALL_ROLES: UserRole[] = [
  "student",
  "teacher",
  "hod",
  "finance",
  "director",
  "admin",
  "warden",
];

/**
 * The RBAC policy matrix: role × action → allow/deny.
 *
 * This is the single source of truth for who may call each guarded Server
 * Action (see the corresponding lib/rbac.ts `requireRole([...])` call in
 * each `actions.ts`). Any PR that changes a role or permission must update
 * this file, the RLS policy, and the backend check together — a PR that
 * touches only one is incomplete (see .agent/.rules/rules.md §3).
 */
export const ACTION_ALLOWED_ROLES: Record<string, UserRole[]> = {
  updateUserProfile: ["admin"],
  updateUserStatus: ["admin"],
  actOnLeaveRequest: ["hod", "admin"],
  actOnGatePass: ["warden", "admin"],
  saveMarks: ["teacher", "admin"],
};

export interface RbacMatrixRow {
  role: UserRole;
  action: string;
  expected: "allow" | "deny";
}

export const RBAC_MATRIX: RbacMatrixRow[] = Object.entries(ACTION_ALLOWED_ROLES).flatMap(
  ([action, allowedRoles]) =>
    ALL_ROLES.map((role) => ({
      role,
      action,
      expected: allowedRoles.includes(role) ? "allow" : "deny",
    }))
);
