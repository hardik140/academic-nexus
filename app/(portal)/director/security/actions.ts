"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { assertClaimed } from "@/lib/concurrent-claim";
import {
  PERMISSIONS,
  GATE_SECURITY_CAPABILITIES,
  DEFAULT_GATE_SECURITY_CAPABILITIES,
} from "@/lib/permissions";
import { inviteUserCore, type InviteUserParams } from "@/lib/invitations";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * Director-side security administration.
 *
 * The shape of every function here is the same, and it is the shape §11
 * asks for: the Director decides WHO may operate a gate, WHICH gate, and
 * WITH WHAT capability — and every one of those decisions leaves an audit
 * row naming the actor, the target, the change and the time.
 *
 * What is deliberately NOT here: any way to record a movement, scan a
 * credential, or move a gate pass. Authorising the people who do that and
 * doing it yourself are different jobs, and a Director who could do both
 * would make the separation the module is built on decorative.
 */

const CapabilitySchema = z.array(z.enum(GATE_SECURITY_CAPABILITIES)).max(GATE_SECURITY_CAPABILITIES.length);

export interface SecurityPersonnelRow {
  id: string;
  profile_id: string;
  employee_code: string | null;
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
  permissions: string[];
  authorized_at: string | null;
  deactivation_reason: string | null;
  full_name: string;
  email: string;
  gates: { assignmentId: string; gateId: string; code: string; name: string }[];
}

/** The roster, with each guard's live gate assignments attached. */
export async function listSecurityPersonnel(): Promise<SecurityPersonnelRow[]> {
  const actor = await requireRole(PERMISSIONS.security_admin_read);
  const supabase = await createClient();

  const { data: people } = await supabase
    .from("security_personnel")
    .select("id, profile_id, employee_code, status, permissions, authorized_at, deactivation_reason")
    .eq("college_id", actor.collegeId)
    .order("created_at", { ascending: false });

  const rows = people ?? [];
  if (rows.length === 0) return [];

  const [{ data: profiles }, { data: assignments }, { data: gates }] = await Promise.all([
    supabase.from("profiles").select("id, full_name, email").in("id", rows.map((r) => r.profile_id)),
    supabase
      .from("security_gate_assignments")
      .select("id, security_personnel_id, gate_id")
      .in("security_personnel_id", rows.map((r) => r.id))
      .is("revoked_at", null),
    supabase.from("gates").select("id, code, name").eq("college_id", actor.collegeId),
  ]);

  const byProfile = new Map((profiles ?? []).map((p) => [p.id, p]));
  const byGate = new Map((gates ?? []).map((g) => [g.id, g]));

  return rows.map((r) => ({
    ...r,
    full_name: byProfile.get(r.profile_id)?.full_name ?? "—",
    email: byProfile.get(r.profile_id)?.email ?? "—",
    gates: (assignments ?? [])
      .filter((a) => a.security_personnel_id === r.id)
      .map((a) => ({
        assignmentId: a.id,
        gateId: a.gate_id,
        code: byGate.get(a.gate_id)?.code ?? "—",
        name: byGate.get(a.gate_id)?.name ?? "—",
      })),
  }));
}

/**
 * Accounts that hold the gate_security role but have never been authorized
 * for gate duty.
 *
 * These are the two halves §11 separates: an invitation creates the login,
 * an authorization creates the ability to operate a gate. Between them the
 * account can sign in and see a screen that tells it to wait, which is the
 * correct state for a guard who has been hired but not yet issued.
 */
export async function listUnauthorizedSecurityAccounts() {
  const actor = await requireRole(PERMISSIONS.security_admin_read);
  const supabase = await createClient();

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, full_name, email, status")
    .eq("college_id", actor.collegeId)
    .eq("role", "gate_security");

  const { data: existing } = await supabase
    .from("security_personnel")
    .select("profile_id")
    .eq("college_id", actor.collegeId);

  const taken = new Set((existing ?? []).map((e) => e.profile_id));
  return (profiles ?? []).filter((p) => !taken.has(p.id));
}

/** Invite a new guard. The role is forced server-side, never taken from the form. */
export async function inviteSecurityPersonnel(params: Omit<InviteUserParams, "role">) {
  const actor = await requireRole(PERMISSIONS.security_admin_manage);
  const supabase = await createClient();
  await inviteUserCore(supabase, actor, { ...params, role: "gate_security" });
  revalidatePath("/director/security");
}

const AuthorizeSchema = z.object({
  profileId: z.string().guid(),
  employeeCode: z.string().trim().max(40).optional(),
  permissions: CapabilitySchema.optional(),
});

/**
 * Authorize an account for gate duty (§11).
 *
 * The candidate is re-verified here against the Director's own college and
 * against the gate_security role — never trusted from the form, because the
 * id in the form is the client's to choose. Writing the row as ACTIVE with
 * authorized_by set is what the sp_active_was_authorized CHECK and the
 * lifecycle trigger in 050 §9 require; there is no way to produce an active
 * guard with nobody's name against it.
 */
export async function authorizeSecurityPersonnel(params: {
  profileId: string;
  employeeCode?: string;
  permissions?: string[];
}) {
  const actor = await requireRole(PERMISSIONS.security_admin_manage);
  const { profileId, employeeCode, permissions } = AuthorizeSchema.parse(params);
  await checkRateLimit(`authorizeSecurity:${actor.userId}`, 20, 60);
  const supabase = await createClient();

  const { data: candidate } = await supabase
    .from("profiles")
    .select("id, role, college_id")
    .eq("id", profileId)
    .maybeSingle();

  if (!candidate || candidate.college_id !== actor.collegeId) {
    throw new Error("That account is not in your college.");
  }
  if (candidate.role !== "gate_security") {
    throw new Error("Only an account with the Gate Security role can be authorized for gate duty.");
  }

  const granted = permissions?.length ? permissions : DEFAULT_GATE_SECURITY_CAPABILITIES;

  const { data: created, error } = await supabase
    .from("security_personnel")
    .insert({
      college_id: actor.collegeId,
      profile_id: profileId,
      employee_code: employeeCode?.trim() || null,
      status: "ACTIVE",
      permissions: granted,
      authorized_by: actor.userId,
      authorized_at: new Date().toISOString(),
    })
    .select("id");

  if (error) throw new Error(error.message);
  assertClaimed(created, "security account");

  await logAudit(supabase, actor, "security_user_activated", "security_personnel", created![0].id, {
    newValue: { profile_id: profileId, employee_code: employeeCode ?? null, permissions: granted, status: "ACTIVE" },
  });

  revalidatePath("/director/security");
  return created![0].id;
}

const StatusSchema = z.object({
  personnelId: z.string().guid(),
  status: z.enum(["ACTIVE", "SUSPENDED", "DEACTIVATED"]),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Move a guard through the lifecycle (§12).
 *
 * The transition table lives in the database (050 §9), so an illegal move
 * fails here rather than being validated twice and drifting. What this adds
 * is the compare-and-swap and the audit row — the same discipline every
 * other status change in this codebase uses.
 */
export async function setSecurityPersonnelStatus(params: {
  personnelId: string;
  status: "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
  reason?: string;
}) {
  const actor = await requireRole(PERMISSIONS.security_admin_manage);
  const { personnelId, status, reason } = StatusSchema.parse(params);
  await checkRateLimit(`securityStatus:${actor.userId}`, 30, 60);
  const supabase = await createClient();

  const { data: person } = await supabase
    .from("security_personnel")
    .select("id, status")
    .eq("id", personnelId)
    .eq("college_id", actor.collegeId)
    .maybeSingle();
  if (!person) throw new Error("Security account not found in your college.");
  if (person.status === status) return;

  if (status === "DEACTIVATED" && (!reason || reason.length < 5)) {
    throw new Error("Deactivating a guard needs a reason.");
  }

  const patch: Database["public"]["Tables"]["security_personnel"]["Update"] =
    status === "ACTIVE"
      ? { status, authorized_by: actor.userId, authorized_at: new Date().toISOString() }
      : status === "DEACTIVATED"
        ? { status, deactivated_by: actor.userId, deactivation_reason: reason ?? null }
        : { status };

  const { data: claimed, error } = await supabase
    .from("security_personnel")
    .update(patch)
    .eq("id", personnelId)
    .eq("college_id", actor.collegeId)
    .eq("status", person.status)
    .select("id");
  if (error) throw new Error(error.message);
  assertClaimed(claimed, "security account");

  await logAudit(
    supabase,
    actor,
    status === "ACTIVE" ? "security_user_activated" : status === "SUSPENDED" ? "security_user_suspended" : "security_user_deactivated",
    "security_personnel",
    personnelId,
    { oldValue: { status: person.status }, newValue: { status, reason: reason ?? null } }
  );

  revalidatePath("/director/security");
}

/** Narrow or widen what one guard may do, within the closed vocabulary. */
export async function setSecurityPermissions(personnelIdRaw: string, permissionsRaw: string[]) {
  const actor = await requireRole(PERMISSIONS.security_admin_manage);
  const personnelId = z.string().guid().parse(personnelIdRaw);
  const permissions = CapabilitySchema.parse(permissionsRaw);
  const supabase = await createClient();

  const { data: person } = await supabase
    .from("security_personnel")
    .select("id, permissions")
    .eq("id", personnelId)
    .eq("college_id", actor.collegeId)
    .maybeSingle();
  if (!person) throw new Error("Security account not found in your college.");

  const { data: claimed, error } = await supabase
    .from("security_personnel")
    .update({ permissions })
    .eq("id", personnelId)
    .eq("college_id", actor.collegeId)
    .select("id");
  if (error) throw new Error(error.message);
  assertClaimed(claimed, "security account");

  await logAudit(supabase, actor, "security_permission_changed", "security_personnel", personnelId, {
    oldValue: { permissions: person.permissions },
    newValue: { permissions },
  });
  revalidatePath("/director/security");
}

// ─────────────────────────────────────────────────────────────
// Gates and assignments
// ─────────────────────────────────────────────────────────────

export async function listGates() {
  const actor = await requireRole(PERMISSIONS.security_admin_read);
  const supabase = await createClient();
  const { data } = await supabase
    .from("gates")
    .select("id, code, name, description, is_active")
    .eq("college_id", actor.collegeId)
    .order("code");
  return data ?? [];
}

const GateSchema = z.object({
  code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/, "Use letters, digits, - and _ only."),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(300).optional(),
});

export async function createGate(params: { code: string; name: string; description?: string }) {
  const actor = await requireRole(PERMISSIONS.gate_manage);
  const { code, name, description } = GateSchema.parse(params);
  const supabase = await createClient();

  const { data: created, error } = await supabase
    .from("gates")
    .insert({
      college_id: actor.collegeId,
      code: code.toUpperCase(),
      name,
      description: description || null,
      created_by: actor.userId,
    })
    .select("id");
  if (error) throw new Error(error.message);
  assertClaimed(created, "gate");

  await logAudit(supabase, actor, "gate_created", "gates", created![0].id, { newValue: { code, name } });
  revalidatePath("/director/security");
}

/**
 * Retiring a gate is is_active = false, never a delete: movements recorded
 * at it are history, and history that points at a missing gate reads as a
 * gap in the record.
 */
export async function setGateActive(gateIdRaw: string, isActive: boolean) {
  const actor = await requireRole(PERMISSIONS.gate_manage);
  const gateId = z.string().guid().parse(gateIdRaw);
  const supabase = await createClient();

  const { data: claimed, error } = await supabase
    .from("gates")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("id", gateId)
    .eq("college_id", actor.collegeId)
    .select("id");
  if (error) throw new Error(error.message);
  assertClaimed(claimed, "gate");

  await logAudit(supabase, actor, isActive ? "gate_reopened" : "gate_retired", "gates", gateId, {
    newValue: { is_active: isActive },
  });
  revalidatePath("/director/security");
}

export async function assignGate(personnelIdRaw: string, gateIdRaw: string) {
  const actor = await requireRole(PERMISSIONS.security_admin_manage);
  const personnelId = z.string().guid().parse(personnelIdRaw);
  const gateId = z.string().guid().parse(gateIdRaw);
  await checkRateLimit(`assignGate:${actor.userId}`, 40, 60);
  const supabase = await createClient();

  // Both ends re-verified against the Director's college. The composite FKs
  // in 050 §4 refuse a cross-college pairing anyway; this is the message.
  const [{ data: person }, { data: gate }] = await Promise.all([
    supabase.from("security_personnel").select("id").eq("id", personnelId).eq("college_id", actor.collegeId).maybeSingle(),
    supabase.from("gates").select("id, code").eq("id", gateId).eq("college_id", actor.collegeId).maybeSingle(),
  ]);
  if (!person) throw new Error("Security account not found in your college.");
  if (!gate) throw new Error("Gate not found in your college.");

  const { data: created, error } = await supabase
    .from("security_gate_assignments")
    .insert({
      college_id: actor.collegeId,
      security_personnel_id: personnelId,
      gate_id: gateId,
      assigned_by: actor.userId,
    })
    .select("id");
  if (error) {
    // idx_sga_live — already assigned and not revoked.
    if (error.message.includes("idx_sga_live") || error.message.includes("duplicate key")) {
      throw new Error("That guard is already assigned to this gate.");
    }
    throw new Error(error.message);
  }
  assertClaimed(created, "gate assignment");

  await logAudit(supabase, actor, "gate_assigned", "security_personnel", personnelId, {
    newValue: { gate_id: gateId, gate_code: gate.code, assignment_id: created![0].id },
  });
  revalidatePath("/director/security");
}

export async function revokeGateAssignment(assignmentIdRaw: string) {
  const actor = await requireRole(PERMISSIONS.security_admin_manage);
  const assignmentId = z.string().guid().parse(assignmentIdRaw);
  const supabase = await createClient();

  const { data: claimed, error } = await supabase
    .from("security_gate_assignments")
    .update({ revoked_at: new Date().toISOString(), revoked_by: actor.userId })
    .eq("id", assignmentId)
    .eq("college_id", actor.collegeId)
    .is("revoked_at", null)
    .select("id, security_personnel_id, gate_id");
  if (error) throw new Error(error.message);
  assertClaimed(claimed, "gate assignment");

  await logAudit(supabase, actor, "gate_unassigned", "security_personnel", claimed![0].security_personnel_id, {
    newValue: { gate_id: claimed![0].gate_id, assignment_id: assignmentId },
  });
  revalidatePath("/director/security");
}

// ─────────────────────────────────────────────────────────────
// Instructions
// ─────────────────────────────────────────────────────────────

const InstructionSchema = z.object({
  title: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(2000),
  priority: z.enum(["normal", "high", "emergency"]),
  audience: z.enum(["all", "gate", "person"]),
  gateId: z.string().guid().nullable().optional(),
  personnelId: z.string().guid().nullable().optional(),
});

/**
 * Issue a standing instruction, and notify the guards it applies to.
 *
 * TWO writes, on purpose, and neither is a duplicate of the other:
 * security_instructions is the instruction as it stands, shown on the
 * guard's dashboard while it is in force; `notifications` (005) is the
 * existing delivery mechanism that tells them it arrived. Building a second
 * notification system for this would have been the duplication §3 warns
 * about; building neither would have meant an instruction nobody is told
 * about, or one that vanishes when its notification is marked read.
 */
export async function sendSecurityInstruction(params: {
  title: string;
  message: string;
  priority: "normal" | "high" | "emergency";
  audience: "all" | "gate" | "person";
  gateId?: string | null;
  personnelId?: string | null;
}) {
  const actor = await requireRole(PERMISSIONS.security_instruction_send);
  const input = InstructionSchema.parse(params);
  await checkRateLimit(`securityInstruction:${actor.userId}`, 20, 60);
  const supabase = await createClient();

  if (input.audience === "gate" && !input.gateId) throw new Error("Choose the gate this applies to.");
  if (input.audience === "person" && !input.personnelId) throw new Error("Choose the guard this applies to.");

  const { data: created, error } = await supabase
    .from("security_instructions")
    .insert({
      college_id: actor.collegeId,
      title: input.title,
      message: input.message,
      priority: input.priority,
      audience: input.audience,
      gate_id: input.audience === "gate" ? input.gateId! : null,
      security_personnel_id: input.audience === "person" ? input.personnelId! : null,
      created_by: actor.userId,
    })
    .select("id");
  if (error) throw new Error(error.message);
  assertClaimed(created, "security instruction");

  await notifyRecipients(supabase, actor, input, created![0].id);

  await logAudit(supabase, actor, "security_instruction_sent", "security_instructions", created![0].id, {
    newValue: { title: input.title, priority: input.priority, audience: input.audience },
  });
  revalidatePath("/director/security");
}

async function notifyRecipients(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  input: z.infer<typeof InstructionSchema>,
  instructionId: string
) {
  let personnelIds: string[] = [];

  if (input.audience === "person") {
    personnelIds = [input.personnelId!];
  } else if (input.audience === "gate") {
    const { data } = await supabase
      .from("security_gate_assignments")
      .select("security_personnel_id")
      .eq("gate_id", input.gateId!)
      .is("revoked_at", null);
    personnelIds = (data ?? []).map((a) => a.security_personnel_id);
  }

  let query = supabase
    .from("security_personnel")
    .select("profile_id")
    .eq("college_id", actor.collegeId)
    .eq("status", "ACTIVE");
  if (input.audience !== "all") {
    if (personnelIds.length === 0) return;
    query = query.in("id", personnelIds);
  }

  const { data: people } = await query;
  const recipients = (people ?? []).map((p) => p.profile_id);
  if (recipients.length === 0) return;

  await supabase.from("notifications").insert(
    recipients.map((receiver) => ({
      college_id: actor.collegeId,
      title: input.priority === "emergency" ? `EMERGENCY: ${input.title}` : input.title,
      message: input.message.slice(0, 500),
      receiver_id: receiver,
      sender_id: actor.userId,
      type: input.priority === "emergency" ? ("error" as const) : input.priority === "high" ? ("warning" as const) : ("info" as const),
      link: "/security/dashboard",
    }))
  );

  void instructionId;
}

export async function listSecurityInstructions() {
  const actor = await requireRole(PERMISSIONS.security_admin_read);
  const supabase = await createClient();
  const { data } = await supabase
    .from("security_instructions")
    .select("id, title, message, priority, audience, gate_id, security_personnel_id, status, created_at")
    .eq("college_id", actor.collegeId)
    .order("created_at", { ascending: false })
    .limit(50);
  return data ?? [];
}

export async function withdrawSecurityInstruction(instructionIdRaw: string) {
  const actor = await requireRole(PERMISSIONS.security_instruction_send);
  const instructionId = z.string().guid().parse(instructionIdRaw);
  const supabase = await createClient();

  const { data: claimed, error } = await supabase
    .from("security_instructions")
    .update({ status: "withdrawn", withdrawn_by: actor.userId })
    .eq("id", instructionId)
    .eq("college_id", actor.collegeId)
    .eq("status", "active")
    .select("id");
  if (error) throw new Error(error.message);
  assertClaimed(claimed, "security instruction");

  await logAudit(supabase, actor, "security_instruction_withdrawn", "security_instructions", instructionId);
  revalidatePath("/director/security");
}

// ─────────────────────────────────────────────────────────────
// Monitoring (§36)
// ─────────────────────────────────────────────────────────────

export interface SecurityOverview {
  exitsToday: number;
  returnsToday: number;
  currentlyOutside: number;
  overdue: number;
  pendingPasses: number;
  activeGuards: number;
  activeGates: number;
  rejectedScans: number;
  invalidQrAttempts: number;
}

function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * The Director's security tiles.
 *
 * Every number here is counted from a row that exists: movements from the
 * ledger, outside/overdue from gate_passes, refusals from the audit rows the
 * movement recorder wrote. None of them is derived from a number that was
 * itself estimated, and there is no tile for anything this schema cannot
 * answer — the same refusal-to-invent-a-number the hostel rollup and the
 * faculty workload already make.
 */
export async function securityOverview(): Promise<SecurityOverview> {
  const actor = await requireRole(PERMISSIONS.security_admin_read);
  const supabase = await createClient();
  const since = startOfToday();

  const [movements, passes, guards, gates, refusals] = await Promise.all([
    supabase
      .from("gate_movements")
      .select("movement_type")
      .eq("college_id", actor.collegeId)
      .gte("occurred_at", since),
    supabase
      .from("gate_passes")
      .select("status, return_time")
      .eq("college_id", actor.collegeId)
      .in("status", ["pending", "active"]),
    supabase
      .from("security_personnel")
      .select("id", { count: "exact", head: true })
      .eq("college_id", actor.collegeId)
      .eq("status", "ACTIVE"),
    supabase
      .from("gates")
      .select("id", { count: "exact", head: true })
      .eq("college_id", actor.collegeId)
      .eq("is_active", true),
    supabase
      .from("audit_logs")
      .select("action")
      .eq("college_id", actor.collegeId)
      .eq("table_name", "gate_movements")
      .gte("created_at", since),
  ]);

  const moves = movements.data ?? [];
  const open = passes.data ?? [];
  const now = Date.now();
  const events = refusals.data ?? [];

  return {
    exitsToday: moves.filter((m) => m.movement_type === "OUT").length,
    returnsToday: moves.filter((m) => m.movement_type === "IN").length,
    currentlyOutside: open.filter((p) => p.status === "active").length,
    overdue: open.filter((p) => p.status === "active" && Date.parse(p.return_time) < now).length,
    pendingPasses: open.filter((p) => p.status === "pending").length,
    activeGuards: guards.count ?? 0,
    activeGates: gates.count ?? 0,
    // A refusal is any scan event that is not a recorded movement. Split out
    // because "someone presented something we did not recognise" and
    // "someone presented a pass that was not usable yet" are different
    // signals to a Director.
    rejectedScans: events.filter((e) => e.action.startsWith("gate_scan_")).length,
    invalidQrAttempts: events.filter(
      (e) =>
        e.action === "gate_scan_invalid_qr" ||
        e.action === "gate_scan_bad_signature" ||
        e.action === "gate_scan_unparseable" ||
        e.action === "gate_scan_unknown_credential" ||
        e.action === "gate_scan_cross_college"
    ).length,
  };
}

export interface MovementLogRow {
  id: string;
  movement_type: "OUT" | "IN";
  occurred_at: string;
  is_override: boolean;
  override_reason: string | null;
  recorded_role: string;
  student_name: string;
  enrollment_number: string;
  gate_name: string;
  recorded_by_name: string;
  pass_code: string;
  destination: string;
}

/**
 * The movement ledger, joined up for a human (§38).
 *
 * The Director has a real SELECT policy on gate_movements, students and
 * profiles, so unlike the guard's feed this does not need a SECURITY
 * DEFINER projection — the joins run under the Director's own RLS and stop
 * at their own college on their own.
 */
export async function listGateMovements(limit = 100): Promise<MovementLogRow[]> {
  const actor = await requireRole(PERMISSIONS.gate_movement_read);
  const supabase = await createClient();
  const bounded = Math.min(Math.max(limit, 1), 300);

  const { data: movements } = await supabase
    .from("gate_movements")
    .select("id, movement_type, occurred_at, is_override, override_reason, recorded_role, student_id, gate_id, recorded_by, gate_pass_id")
    .eq("college_id", actor.collegeId)
    .order("occurred_at", { ascending: false })
    .limit(bounded);

  const rows = movements ?? [];
  if (rows.length === 0) return [];

  const [{ data: students }, { data: gates }, { data: actors }, { data: passes }] = await Promise.all([
    supabase.from("students").select("id, user_id, enrollment_number").in("id", rows.map((r) => r.student_id)),
    supabase.from("gates").select("id, name").in("id", rows.map((r) => r.gate_id).filter((g): g is string => !!g)),
    supabase.from("profiles").select("id, full_name").in("id", rows.map((r) => r.recorded_by)),
    supabase.from("gate_passes").select("id, destination").in("id", rows.map((r) => r.gate_pass_id)),
  ]);

  const studentById = new Map((students ?? []).map((s) => [s.id, s]));
  const nameByProfile = new Map((actors ?? []).map((p) => [p.id, p.full_name]));
  const gateById = new Map((gates ?? []).map((g) => [g.id, g.name]));
  const passById = new Map((passes ?? []).map((p) => [p.id, p.destination]));

  // Student names come from profiles too; one more lookup rather than an
  // embedded join, which the hand-maintained Database type cannot infer.
  const studentUserIds = (students ?? []).map((s) => s.user_id);
  const { data: studentProfiles } = studentUserIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", studentUserIds)
    : { data: [] };
  const nameByStudentUser = new Map((studentProfiles ?? []).map((p) => [p.id, p.full_name]));

  return rows.map((r) => {
    const student = studentById.get(r.student_id);
    return {
      id: r.id,
      movement_type: r.movement_type,
      occurred_at: r.occurred_at,
      is_override: r.is_override,
      override_reason: r.override_reason,
      recorded_role: r.recorded_role,
      student_name: (student && nameByStudentUser.get(student.user_id)) || "—",
      enrollment_number: student?.enrollment_number ?? "—",
      gate_name: (r.gate_id && gateById.get(r.gate_id)) || "—",
      recorded_by_name: nameByProfile.get(r.recorded_by) ?? "—",
      pass_code: `GP-${r.gate_pass_id.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      destination: passById.get(r.gate_pass_id) ?? "—",
    };
  });
}

/** The security audit trail — the gate_* actions, newest first (§30). */
export async function listSecurityAuditEvents(limit = 100) {
  const actor = await requireRole(PERMISSIONS.security_admin_read);
  const supabase = await createClient();
  const bounded = Math.min(Math.max(limit, 1), 300);

  const { data } = await supabase
    .from("audit_logs")
    .select("id, action, record_id, new_value, created_at, user_id")
    .eq("college_id", actor.collegeId)
    .in("table_name", ["gate_movements", "gate_pass_credentials", "security_personnel", "gates", "security_instructions"])
    .order("created_at", { ascending: false })
    .limit(bounded);

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const { data: actors } = await supabase
    .from("profiles")
    .select("id, full_name")
    .in("id", rows.map((r) => r.user_id));
  const nameById = new Map((actors ?? []).map((p) => [p.id, p.full_name]));

  return rows.map((r) => ({ ...r, actor_name: nameById.get(r.user_id) ?? "—" }));
}
