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

  // Director Command Center — deliberately director-only, never widened to
  // ["director", "admin"] by default (director and admin stay disjoint here,
  // matching every other entry in this table).
  institution_health_read: ["director"],
  institution_analytics_read: ["director"],
  decision_submit: ["hod", "warden", "placement_cell"],
  decision_decide: ["director"],
  decision_audit_read: ["director"],
  risk_flag_create: ["director"],
  risk_flag_assign: ["director"],
  risk_flag_review: ["director"],
  department_risk_read: ["director", "hod"], // scope-narrowed to own department when role=hod
  institution_placement_funnel_read: ["director"],
  faculty_workload_read: ["director", "hod"], // scope-narrowed to own department when role=hod
  hostel_institution_rollup_read: ["director"],
  strategic_goal_manage: ["director"],
  strategic_goal_read: ["director", "hod"], // scope-narrowed to owner_id=self when role=hod
  ask_institution_read: ["director"],
  forecast_simulator_read: ["director"],
  forecast_scenario_save: ["director"],
  executive_briefing_read: ["director"],

  // Attendance correction — purely additive alongside teachers' existing
  // same-day direct-edit ability (attendance_teacher_update RLS); this is
  // the request/approve path for corrections to already-past records.
  attendance_correction_create: ["teacher"],
  attendance_correction_review: ["hod", "admin"],

  // Leave -> Substitution: created (status='needed') when a hod/admin
  // approves a leave request, then assigned by hod/admin. Same
  // department-ownership-in-app-code split as attendance_correction_review.
  substitution_manage: ["hod", "admin"],

  // Warden hostel operations — block ownership (hostel_blocks.warden_id)
  // enforced app-side, same split as every other staff table this session.
  hostel_room_read: ["warden", "admin"],
  gatepass_review: ["warden", "admin"],
  gatepass_verify_movement: ["warden", "admin"],
  hostel_complaint_manage: ["warden", "admin"],
  room_transfer_request: ["student"],
  room_transfer_review: ["warden", "admin"],

  // Downstream role actions on a risk_flags escalation assigned to them.
  // Role-check only — the actual *Core action still verifies
  // assigned_to === actor.userId (and, for hod, department ownership)
  // before allowing the mutation, same as hod/approvals.
  escalation_acknowledge: ["hod", "warden", "placement_cell", "teacher"],
  escalation_act: ["hod", "warden", "placement_cell", "teacher"],
  escalation_resolve: ["hod", "warden", "placement_cell", "teacher"],

  // Finance — existing fees/payments/scholarships actions predate this
  // table and used a raw requireRole(["finance","admin"]) inline; these
  // entries centralize that same effective rule, not a behavior change.
  invoice_read: ["finance", "admin"],
  invoice_create: ["finance", "admin"],
  payment_read: ["finance", "admin"],
  payment_record: ["finance", "admin"],
  scholarship_read: ["finance", "admin"],
  scholarship_manage: ["finance", "admin"],

  // Refund / Dispute — student-request, finance-approve, same shape as
  // room_transfer_request/room_transfer_review above.
  refund_request: ["student"],
  refund_review: ["finance", "admin"],
  dispute_submit: ["student"],
  dispute_manage: ["finance", "admin"],
  finance_exceptions_read: ["finance", "admin"],

  // Academic period lifecycle (academic years and the semesters inside
  // them) — the same grant 046 gave academic_years_manage and programmes,
  // mirrored by the semesters_*_manage policies in 047 §7k. Not hod: their
  // management rights stop at sections and their own department's offerings.
  academic_period_manage: ["admin", "director"],

  // ── Finance Integration Hub (migration 049) ─────────────────────────
  //
  // Split along the line that matters: CREDENTIAL CUSTODY is separated from
  // DAILY OPERATION. The person who posts and reconciles the books does not
  // also hold the accounting system's OAuth tokens, and the person who holds
  // them does not need to.
  //
  //   admin    — connections and credentials (institution configuration,
  //              alongside admin/settings and the colleges row)
  //   finance  — mappings, sync, reconciliation (the accounting work)
  //   both     — read
  //
  // DESIGN DECISION on the register: §74 asks for four finance tiers
  // (Viewer / Operator / Manager / Administrator). This product has ONE
  // `finance` role; adding three more means widening profiles.role's CHECK,
  // migration 042's privilege trigger, ROLE_ROUTES and every finance policy
  // — a role-model change, not a permission table entry. These names are the
  // capability vocabulary that split would attach to.
  finance_integration_read: ["finance", "admin"],
  finance_integration_connect: ["admin"],
  finance_integration_manage: ["admin"],
  finance_mapping_read: ["finance", "admin"],
  finance_mapping_manage: ["finance", "admin"],
  finance_sync_read: ["finance", "admin"],
  finance_sync_execute: ["finance", "admin"],
  finance_sync_retry: ["finance", "admin"],
  finance_reconciliation_read: ["finance", "admin"],
  finance_reconciliation_execute: ["finance", "admin"],
  finance_reconciliation_resolve: ["finance", "admin"],
  finance_integration_audit_read: ["finance", "admin"],
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
