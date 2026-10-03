import type { UserRole } from "@/types/database";

/**
 * Single source of truth for which role may invite which other role(s) —
 * mirrors lib/auth/role-routes.ts's "one shared map, not duplicated logic"
 * pattern. Enforced server-side in lib/invitations.ts's inviteUserCore,
 * never trust a client-supplied target role against anything else.
 *
 * The cascade: Super Admin -> College Admin -> Director -> Finance/HOD/Warden/
 * Placement Cell/Gate Security, and HOD -> Teacher/Student, and a Class
 * In-Charge (a teacher) -> Student for their own section (migration 055).
 * Every other role invites no one.
 *
 * Placement Cell is deliberately only reachable from Director, not Admin —
 * it's a Director-controlled functional role (see the Placement Cell plan),
 * not a System Admin one, and this cascade is the actual enforcement point
 * for that rule (Admin's own list simply never lists it).
 *
 * Gate Security follows the same rule for the same reason: authorising the
 * people who control physical access to the campus is the Director's, and
 * an invitation is only the first half of it — the invited account arrives
 * with no security_personnel row, so it can sign in and do nothing until a
 * Director authorises it (migration 050 §3).
 */
export const INVITE_PERMISSIONS: Record<UserRole, UserRole[]> = {
  super_admin: ["admin"],
  admin: ["director"],
  director: ["finance", "hod", "warden", "placement_cell", "gate_security"],
  hod: ["teacher", "student"],
  // Relationship-scoped (055): only while the teacher is a current Class
  // In-Charge, and only into THAT section — student_placement_check()
  // decides per invitation. The role grant alone admits nothing.
  teacher: ["student"],
  finance: [],
  warden: [],
  student: [],
  placement_cell: [],
  gate_security: [],
};

export function canInvite(actorRole: UserRole, targetRole: UserRole): boolean {
  return INVITE_PERMISSIONS[actorRole].includes(targetRole);
}
