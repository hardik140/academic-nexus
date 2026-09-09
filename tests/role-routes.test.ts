import { describe, it, expect } from "vitest";
import { ROLE_ROUTES, routePrefixFor, dashboardPathFor } from "@/lib/auth/role-routes";
import { ALL_ROLES } from "./rbac-matrix";

/**
 * Route enforcement in lib/supabase/middleware.ts now fails CLOSED: a role
 * with no ROLE_ROUTES entry is redirected to /login rather than falling
 * through the prefix check.
 *
 * That change removes the *consequence* of a missing entry, but not the
 * mistake itself — a role added to profiles.role's CHECK constraint and to
 * UserRole without a ROLE_ROUTES entry would now be locked out of the app
 * entirely, which is safe but confusing. This test is what catches that at
 * build time instead of at login.
 *
 * (The historical case: `parent` has been a valid profiles.role since
 * migration 001 and has its own RLS policies from migration 009, but was
 * never given a route prefix — so under the old fail-open check it could
 * load every portal shell in the app.)
 */
describe("ROLE_ROUTES completeness", () => {
  it.each(ALL_ROLES)("role '%s' has a route prefix", (role) => {
    expect(routePrefixFor(role), `${role} is missing from ROLE_ROUTES`).toBeTruthy();
  });

  it("every prefix is absolute and distinct", () => {
    const prefixes = Object.values(ROLE_ROUTES);
    for (const p of prefixes) expect(p.startsWith("/")).toBe(true);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("an unknown role resolves to no prefix, so middleware can reject it", () => {
    // This is the value middleware now treats as "fail closed".
    expect(routePrefixFor("parent")).toBeUndefined();
    expect(routePrefixFor("not_a_role")).toBeUndefined();
    expect(routePrefixFor(null)).toBeUndefined();
  });

  it("dashboardPathFor falls back to the student dashboard for an unknown role", () => {
    // Kept deliberate and separate: this is only used for the post-login
    // redirect target, never as an access decision.
    expect(dashboardPathFor("not_a_role")).toBe("/student/dashboard");
    expect(dashboardPathFor("warden")).toBe("/warden/dashboard");
  });
});
