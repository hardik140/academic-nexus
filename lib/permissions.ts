import type { UserRole } from "@/types/database";

/**
 * Named, centralized permission table for the actions covered by this pass
 * — not a project-wide replacement for every `requireRole([...])` call site
 * (there are ~20 of those across the app; rebuilding all of them into this
 * shape is a much larger change than what was asked for here, and
 * `role_permissions` already exists in the schema as a seeded-but-unenforced
 * first step toward a fully dynamic version of this — see
 * Implementation Status.md). What this *does* fix: assign_hod's authority
 * was previously encoded only as a hardcoded role array inline at its one
 * call site, with no single place that named the actual business rule or
 * let the UI ask the same question the server enforces.
 *
 * Extend this table (not a scattered `if (role === "x")`) as more of the
 * app's authorization decisions get named rather than inlined.
 */
export const PERMISSIONS = {
  assign_hod: ["director"],
  create_department: ["admin"],
  create_course: ["admin", "hod", "director"],
  assign_placement_cell: ["director"],
  revoke_placement_cell: ["director"],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof PERMISSIONS;

/**
 * Client-side only — decides what the UI offers, never what the server
 * accepts. The matching `requireRole(PERMISSIONS.x)` call at the actual
 * Server Action is the real boundary; this just keeps the two from silently
 * drifting apart by reading the same table instead of a second hardcoded list.
 */
export function can(role: UserRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly UserRole[]).includes(role);
}
