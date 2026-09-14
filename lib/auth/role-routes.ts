import type { UserRole } from "@/types/database";

/**
 * Single source of truth for role → portal route-prefix mapping.
 * Previously duplicated (and drifted out of sync) between middleware.ts
 * and app/page.tsx — `parent` and `warden` were missing from one copy,
 * which let those two roles bypass route-prefix enforcement entirely.
 */
export const ROLE_ROUTES: Record<UserRole, string> = {
  student: "/student",
  teacher: "/teacher",
  hod: "/hod",
  finance: "/finance",
  director: "/director",
  admin: "/admin",
  warden: "/warden",
  super_admin: "/super-admin",
  placement_cell: "/placement-cell",
  gate_security: "/security",
};

export const DEFAULT_ROLE: UserRole = "student";

export function routePrefixFor(role: string | null | undefined): string | undefined {
  return ROLE_ROUTES[role as UserRole];
}

export function dashboardPathFor(role: string | null | undefined): string {
  const prefix = routePrefixFor(role) ?? ROLE_ROUTES[DEFAULT_ROLE];
  return `${prefix}/dashboard`;
}
