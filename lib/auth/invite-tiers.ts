import type { UserRole } from "@/types/database";

/**
 * Single source of truth for which role may invite which other role(s) —
 * mirrors lib/auth/role-routes.ts's "one shared map, not duplicated logic"
 * pattern. Enforced server-side in lib/invitations.ts's inviteUserCore,
 * never trust a client-supplied target role against anything else.
 *
 * The cascade: Super Admin -> College Admin -> Director -> Finance/HOD/Warden,
 * and HOD -> Teacher/Student. Every other role invites no one.
 */
export const INVITE_PERMISSIONS: Record<UserRole, UserRole[]> = {
  super_admin: ["admin"],
  admin: ["director"],
  director: ["finance", "hod", "warden"],
  hod: ["teacher", "student"],
  teacher: [],
  finance: [],
  warden: [],
  student: [],
};

export function canInvite(actorRole: UserRole, targetRole: UserRole): boolean {
  return INVITE_PERMISSIONS[actorRole].includes(targetRole);
}
