import type { UserRole } from "@/types/database";

export const ALL_ROLES: UserRole[] = [
  "student",
  "teacher",
  "hod",
  "finance",
  "director",
  "admin",
  "warden",
  "super_admin",
  "placement_cell",
  "gate_security",
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
  // 'hod' added deliberately: HODs teach. Course ownership
  // (courses.instructor_id) is the real boundary and applies to hod
  // identically — see teacher/grading/actions.ts.
  saveMarks: ["teacher", "hod", "admin"],
  markAttendance: ["teacher", "hod", "admin"],
  // Invitation-based onboarding — super_admin is deliberately NOT implicitly
  // admin (inviteUserAsAdmin denies it), and each tier's invite action is
  // its own separate requireRole([...]) call, not a shared allow-list.
  createCollege: ["super_admin"],
  inviteUserAsSuperAdmin: ["super_admin"],
  inviteUserAsAdmin: ["admin"],
  inviteUserAsDirector: ["director"],
  inviteUserAsHod: ["hod"],
  // Placement Cell — a Director-controlled functional role (see the
  // Placement Cell plan). assign/revoke are Director-exclusive on purpose
  // (System Admin structurally can't reach them); operational CRUD on
  // companies/drives/applications/notifications is placement_cell + admin,
  // matching this codebase's existing "admin co-manages every domain
  // module" convention (fees, scholarships, hostel, the original
  // placements table); staff read (oversight) also includes director.
  assignPlacementCell: ["director"],
  revokePlacementCell: ["director"],
  managePlacementCompanies: ["placement_cell", "admin"],
  managePlacementDrives: ["placement_cell", "admin"],
  updatePlacementApplicationStatus: ["placement_cell", "admin"],
  updateStudentPlacementStatus: ["placement_cell", "admin"],
  sendPlacementNotification: ["placement_cell", "admin"],
  readPlacementCellData: ["placement_cell", "director", "admin"],
  applyToPlacementDrive: ["student"],
  // Academic period lifecycle — mirrors semesters_*_manage (047 §7k) and the
  // grant 046 gave academic_years_manage. hod is deliberately absent.
  createSemester: ["admin", "director"],
  transitionSemester: ["admin", "director"],
  // Gate Security (050). The rows that matter most in this block are the
  // DENIES the matrix generates for free: gate_security is absent from
  // every action above, and warden/director are absent from the scanner.
  // A guard who could approve a pass, or a warden who could stand in for
  // the gate, would collapse the separation the module is built on.
  authorizeSecurityPersonnel: ["director", "admin"],
  assignSecurityGate: ["director", "admin"],
  manageGates: ["director", "admin"],
  sendSecurityInstruction: ["director", "admin"],
  recordGateMovement: ["gate_security"],
  overrideGateMovement: ["warden", "admin"],
  revokeGateCredential: ["warden", "admin", "director"],
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
