"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCacheFamily, versionedKey } from "@/lib/cache";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import { logAudit } from "@/lib/audit";
import { assertClaimed } from "@/lib/concurrent-claim";
import { PERMISSIONS } from "@/lib/permissions";
import { callRpc } from "@/lib/gate-security/rpc";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { DataTableQuery } from "@/components/ui/data-table";
import { dbError } from "@/lib/internal-error";
import { assertRead } from "@/lib/read-result-server";

const PROCESSED_PAGE_SIZE = 10;
const PROCESSED_SORT_COLUMNS = ["exit_time", "destination"] as const;
const PROCESSED_CACHE_PREFIX = "list:gatepasses";

/** Pending and processed gate passes: one family per college, read per warden scope. */
const GATEPASS_FAMILY = "gatepasses";

function pendingCacheKey(scopeKey: string, collegeId: string) {
  return versionedKey(`pending:gatepasses:${scopeKey}`, GATEPASS_FAMILY, collegeId);
}

/**
 * Single-record version of the same check, used by the act/verify
 * functions below — a warden must own the block the pass's STUDENT is
 * currently allocated to. Throws for warden if out of scope; no-ops
 * (returns) for admin. This is the app-layer close of a real, pre-existing
 * IDOR-class gap: gate_passes_staff RLS is college-wide FOR ALL for any
 * warden, with no block restriction at all.
 */
async function assertGatePassInWardenScope(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  studentId: string
) {
  if (actor.role === "admin") return;

  const { data: allocation } = await supabase
    .from("hostel_allocations")
    .select("room_id, hostel_rooms:room_id(block_id)")
    .eq("student_id", studentId)
    .eq("status", "active")
    .single();
  const blockId = (allocation as unknown as { hostel_rooms: { block_id: string } | null } | null)?.hostel_rooms
    ?.block_id;

  if (!blockId) {
    throw new Error("This student has no active hostel allocation in your scope.");
  }
  const { data: block } = await supabase
    .from("hostel_blocks")
    .select("id")
    .eq("id", blockId)
    .eq("warden_id", actor.userId)
    .single();
  if (!block) {
    throw new Error("You can only act on gate passes for students in your own hostel block(s).");
  }
}

/** The "needs your attention now" queue — short TTL (15s), block-scoped. */
export async function listPendingGatePasses() {
  const actor = await requireRole(PERMISSIONS.gatepass_review);
  const supabase = await createClient();

  return getCached(pendingCacheKey(actor.role === "admin" ? actor.collegeId : actor.userId, actor.collegeId), 15, async () => {
    // Block scope is PostgreSQL's (gate_passes_staff_read, migration 050:
    // a warden reads only passes of students allocated in their own rooms;
    // an admin, the college). The old app-side copy of that scope resolved
    // the warden's students into an id list — capped at PostgREST's 1,000
    // rows — and sent it back as a URL filter, so in a large block some
    // students' passes were silently out of scope.
    const { data, error: dataError } = await supabase
      .from("gate_passes")
      .select("*, students:student_id(enrollment_number, profiles:user_id(full_name))")
      .eq("status", "pending")
      .eq("college_id", actor.collegeId)
      .order("created_at", { ascending: false });
    assertRead(dataError);
    return data || [];
  });
}

export async function listProcessedGatePasses(q: DataTableQuery) {
  const actor = await requireRole(PERMISSIONS.gatepass_review);
  const supabase = await createClient();

  const { column, ascending } = resolveListSort(PROCESSED_SORT_COLUMNS, "created_at", false, q);
  const cacheKey = versionedKey(
    listCacheKey(PROCESSED_CACHE_PREFIX, actor.role === "admin" ? actor.collegeId : actor.userId, q, column),
    GATEPASS_FAMILY,
    actor.collegeId
  );

  return getCached(cacheKey, 30, async () => {
    // Block scope is PostgreSQL's (gate_passes_staff_read, migration 050:
    // a warden reads only passes of students allocated in their own rooms;
    // an admin, the college). The old app-side copy of that scope resolved
    // the warden's students into an id list — capped at PostgREST's 1,000
    // rows — and sent it back as a URL filter, so in a large block some
    // students' passes were silently out of scope.
    const { data, count, error: dataError } = await supabase
      .from("gate_passes")
      .select("*, students:student_id(enrollment_number, profiles:user_id(full_name))", { count: "exact" })
      .neq("status", "pending")
      .eq("college_id", actor.collegeId)
      .order(column, { ascending })
      .range(q.page * PROCESSED_PAGE_SIZE, q.page * PROCESSED_PAGE_SIZE + PROCESSED_PAGE_SIZE - 1);
    assertRead(dataError);
    return { data: data || [], count: count ?? 0 };
  });
}

const ActOnGatePassSchema = z.object({
  passId: z.string().guid(),
  action: z.enum(["approved", "rejected"]),
});

/**
 * Shared by the web Server Action below and app/api/mobile/gatepass/act's
 * Route Handler — same guarded logic either way, just a different transport.
 */
export async function actOnGatePassCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  passId: string,
  action: "approved" | "rejected"
) {
  ({ passId, action } = ActOnGatePassSchema.parse({ passId, action }));
  await checkRateLimit(`actOnGatePass:${actor.userId}`, 30, 60);

  // Cast: the hand-maintained Database type declares no Relationships, so
  // supabase-js can't infer this embedded-select shape — same workaround
  // every other actions.ts file with an embedded select already uses (see
  // placements/actions.ts's DriveWithCompany comment).
  type PassWithStudent = {
    student_id: string;
    status: string;
    destination: string;
    students: { profiles: { id: string; full_name: string } | null } | null;
  };
  const { data: passRaw } = await supabase
    .from("gate_passes")
    .select("student_id, status, destination, students:student_id(profiles:user_id(id, full_name))")
    .eq("id", passId)
    .eq("college_id", actor.collegeId)
    .single();
  const pass = passRaw as unknown as PassWithStudent | null;
  if (!pass || pass.status !== "pending") {
    throw new Error("Gate pass not found or already processed.");
  }
  await assertGatePassInWardenScope(supabase, actor, pass.student_id);

  // Compare-and-swap on the status read above, so two wardens acting on the
  // same pass at once can't both pass the pending check and both notify the
  // student. See lib/concurrent-claim.ts.
  const { data: claimed, error } = await supabase
    .from("gate_passes")
    .update({
      status: action,
      approved_by: actor.userId,
      approved_at: new Date().toISOString(),
    })
    .eq("id", passId)
    .eq("college_id", actor.collegeId)
    .eq("status", "pending")
    .select("id");

  if (error) {
    throw dbError(error);
  }
  assertClaimed(claimed, "gate pass");

  await logAudit(supabase, actor, `gate_pass_${action}`, "gate_passes", passId, {
    oldValue: { status: pass.status },
    newValue: { status: action },
  });

  const studentUserId = (pass as unknown as { students: { profiles: { id: string; full_name: string } | null } | null })
    .students?.profiles?.id;
  if (studentUserId) {
    await supabase.from("notifications").insert({
      college_id: actor.collegeId,
      title: action === "approved" ? "Gate pass approved" : "Gate pass rejected",
      message:
        action === "approved"
          ? `Your gate pass for ${pass.destination} has been approved.`
          : `Your gate pass for ${pass.destination} was rejected.`,
      receiver_id: studentUserId,
      sender_id: actor.userId,
      type: action === "approved" ? "success" : "error",
      link: "/student/gatepass",
    });
  }
}

export async function actOnGatePass(
  passId: string,
  action: "approved" | "rejected") {
  const actor = await requireRole(PERMISSIONS.gatepass_review);
  const supabase = await createClient();
  await actOnGatePassCore(supabase, actor, passId, action);
  revalidatePath("/warden/gatepasses");
  revalidatePath("/warden/dashboard");

  await invalidateCacheFamily(GATEPASS_FAMILY, actor.collegeId);
}

/** Called by app/api/mobile/gatepass/act/route.ts. */
export async function actOnGatePassViaRequest(
  request: Request,
  passId: string,
  action: "approved" | "rejected"
) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["warden", "admin"]);
  await actOnGatePassCore(supabase, actor, passId, action);
}

const VerifyMovementSchema = z.object({
  passId: z.string().guid(),
  action: z.enum(["exit", "return"]),
  gateId: z.string().guid().nullable().optional(),
  reason: z.string().trim().min(10).max(500),
});

/**
 * The manual movement override (migration 050 §13).
 *
 * WHAT THIS USED TO BE
 *
 * This function wrote gate_passes.status and actual_exit/actual_return
 * directly, because when it was written there was no gate security role and
 * no ledger — the warden was the only person who could record that a
 * student had left. Migration 050 removes that write: approved -> active
 * and active -> returned are granted to no authenticated role, and the
 * ordinary path is a guard scanning a QR at a gate.
 *
 * WHAT IT IS NOW
 *
 * The same button, doing something honest. A phone with a flat battery, a
 * cracked screen or a pass issued before the QR rollout is a real event at
 * a real gate, and the alternative to recording it is a student waved
 * through with nothing written down. So the override stays — but it now
 * demands a reason, records the gate if there is one, stamps the server
 * clock, writes a ledger row marked is_override, and audits itself. The
 * database still refuses an out-of-order movement and still refuses a
 * second exit.
 *
 * The block-ownership check below is kept even though the function
 * re-checks it in SQL: this one produces the message the warden reads, the
 * one in SQL is the boundary.
 */
export async function recordManualGateMovementCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: { passId: string; action: "exit" | "return"; gateId?: string | null; reason: string }
) {
  const { passId, action, gateId, reason } = VerifyMovementSchema.parse(params);
  await checkRateLimit(`manualGateMovement:${actor.userId}`, 30, 60);

  const { data: pass } = await supabase
    .from("gate_passes")
    .select("student_id, status")
    .eq("id", passId)
    .eq("college_id", actor.collegeId)
    .single();
  if (!pass) {
    throw new Error("Gate pass not found.");
  }
  await assertGatePassInWardenScope(supabase, actor, pass.student_id);

  const requiredStatus = action === "exit" ? "approved" : "active";
  if (pass.status !== requiredStatus) {
    throw new Error(
      action === "exit"
        ? "This gate pass must be approved before an exit can be recorded."
        : "This gate pass must have a recorded exit before a return can be recorded."
    );
  }

  const rows = await callRpc<{ outcome: string; movement: string; occurred_at: string | null; detail: string }>(
    supabase,
    "record_manual_gate_movement",
    {
      p_gate_pass_id: passId,
      p_movement: action === "exit" ? "OUT" : "IN",
      p_gate_id: gateId ?? null,
      p_reason: reason,
    }
  );

  const result = rows[0];
  if (!result) throw new Error("The movement could not be recorded.");
  if (result.outcome !== "RECORDED") throw new Error(result.detail);

  await logAudit(supabase, actor, `gate_movement_override_${action}`, "gate_movements", passId, {
    oldValue: { status: pass.status },
    newValue: {
      movement: result.movement,
      occurred_at: result.occurred_at,
      gate_id: gateId ?? null,
      reason,
      override: true,
    },
  });

  return result;
}

export async function recordManualGateMovement(params: {
  passId: string;
  action: "exit" | "return";
  gateId?: string | null;
  reason: string;
}) {
  const actor = await requireRole(PERMISSIONS.gate_movement_override);
  const supabase = await createClient();
  const result = await recordManualGateMovementCore(supabase, actor, params);
  revalidatePath("/warden/gatepasses");
  revalidatePath("/warden/dashboard");
  await invalidateCacheFamily(GATEPASS_FAMILY, actor.collegeId);
  return result;
}

/** Called by app/api/mobile/gatepass/verify-movement/route.ts. */
export async function recordManualGateMovementViaRequest(
  request: Request,
  params: { passId: string; action: "exit" | "return"; gateId?: string | null; reason: string }
) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, PERMISSIONS.gate_movement_override);
  return recordManualGateMovementCore(supabase, actor, params);
}

/**
 * Pull a student's QR without touching the decision behind it (§19).
 *
 * A lost phone or a screenshot shared in a group chat is a credential
 * problem, not an approval problem — the warden still thinks the student
 * may go out. Revoking issues nothing new; the student asks for a fresh
 * pass if they still need one.
 */
export async function revokeGatePassCredential(passIdRaw: string, reasonRaw: string) {
  const actor = await requireRole(PERMISSIONS.gate_credential_revoke);
  const passId = z.string().guid().parse(passIdRaw);
  const reason = z.string().trim().min(5).max(500).parse(reasonRaw);
  await checkRateLimit(`revokeGateCredential:${actor.userId}`, 30, 60);
  const supabase = await createClient();

  const rows = await callRpc<{ revoked: number }>(supabase, "revoke_gate_pass_credential", {
    p_gate_pass_id: passId,
    p_reason: reason,
  });
  const revoked = rows[0]?.revoked ?? 0;

  if (revoked > 0) {
    await logAudit(supabase, actor, "gate_credential_revoked", "gate_pass_credentials", passId, {
      newValue: { reason, credentials: revoked },
    });
  }
  revalidatePath("/warden/gatepasses");
  return { revoked };
}

/** The gates a manual movement can be attributed to. */
export async function listGatesForOverride() {
  const actor = await requireRole(PERMISSIONS.gate_movement_override);
  const supabase = await createClient();
  const { data, error: dataError } = await supabase
    .from("gates")
    .select("id, code, name")
    .eq("college_id", actor.collegeId)
    .eq("is_active", true)
    .order("code");
  assertRead(dataError);
  return data ?? [];
}

/** The crossings recorded against one pass, newest last. */
export async function listGatePassMovements(passIdRaw: string) {
  const actor = await requireRole(PERMISSIONS.gate_movement_read);
  const passId = z.string().guid().parse(passIdRaw);
  const supabase = await createClient();
  const { data, error: dataError } = await supabase
    .from("gate_movements")
    .select("id, movement_type, occurred_at, is_override, override_reason, recorded_role, gate_id")
    .eq("gate_pass_id", passId)
    .eq("college_id", actor.collegeId)
    .order("occurred_at", { ascending: true });
  assertRead(dataError);
  return data ?? [];
}

// An 'active' pass whose return_time + grace has passed with no
// actual_return yet — matches the spec's own worked example (30 min grace).
const LATE_RETURN_GRACE_MINUTES = 30;

export interface GateOperationsSnapshot {
  inHostelCount: number;
  outsideCount: number;
  lateReturns: { passId: string; studentName: string; returnTime: string; minutesLate: number }[];
  pendingExitVerifications: { passId: string; studentName: string; exitTime: string; minutesOverdue: number }[];
  /** How many there are in all; each list above holds at most GATE_OPS_LIST_LIMIT, oldest first. */
  lateReturnCount: number;
  pendingExitCount: number;
}

/** Entries listed per exception list; the counts are always complete. */
const GATE_OPS_LIST_LIMIT = 100;

/**
 * Residential Presence + Hostel Exceptions in one pass, block-scoped.
 * Deliberately only two presence buckets (In Hostel / Outside) — not
 * fabricating "On Duty"/"Emergency"/"Unknown" categories the spec lists
 * but that nothing in this schema can honestly back with real data (same
 * refusal-to-invent-a-number precedent as getStudentRiskOverview and the
 * HOD faculty-workload computation).
 */
export async function getGateOperationsSnapshot(): Promise<GateOperationsSnapshot> {
  const actor = await requireRole(PERMISSIONS.gatepass_review);
  const supabase = await createClient();

  return getCached(`gate-ops:${actor.role === "admin" ? actor.collegeId : actor.userId}`, 30, async () => {
    // Block scope is PostgreSQL's: since 047/050 RLS shows a warden only the
    // allocations of their own rooms and the passes of students allocated
    // there (hostel_allocations_staff_manage, gate_passes_staff_read via
    // wardens_room / wardens_student), and an admin the whole college.
    //
    // Every number is a count PostgreSQL makes, and each exception list is a
    // bounded, oldest-first page. This used to resolve the warden's students
    // into an id list (capped at PostgREST's 1,000 rows, then sent back as a
    // URL filter) and read every active and approved pass to count here, so
    // a large block undercounted who was outside and could miss a late
    // return entirely.
    const now = Date.now();
    const lateCutoff = new Date(now - LATE_RETURN_GRACE_MINUTES * 60 * 1000).toISOString();
    const nowIso = new Date(now).toISOString();
    const name = "students:student_id(profiles:user_id(full_name))";

    const [residentsRes, outsideRes, lateRes, exitRes] = await Promise.all([
      supabase
        .from("hostel_allocations")
        .select("student_id", { count: "exact", head: true })
        .eq("college_id", actor.collegeId)
        .eq("status", "active"),
      supabase
        .from("gate_passes")
        .select("id", { count: "exact", head: true })
        .eq("college_id", actor.collegeId)
        .eq("status", "active"),
      supabase
        .from("gate_passes")
        .select(`id, return_time, ${name}`, { count: "exact" })
        .eq("college_id", actor.collegeId)
        .eq("status", "active")
        .lt("return_time", lateCutoff)
        .order("return_time", { ascending: true })
        .range(0, GATE_OPS_LIST_LIMIT - 1),
      supabase
        .from("gate_passes")
        .select(`id, exit_time, ${name}`, { count: "exact" })
        .eq("college_id", actor.collegeId)
        .eq("status", "approved")
        .lt("exit_time", nowIso)
        .order("exit_time", { ascending: true })
        .range(0, GATE_OPS_LIST_LIMIT - 1),
    ]);
    assertRead(residentsRes.error);
    assertRead(outsideRes.error);
    assertRead(lateRes.error);
    assertRead(exitRes.error);

    type Named = { students: { profiles: { full_name: string } | null } | null };
    const studentName = (p: Named) => p.students?.profiles?.full_name || "Unknown";
    const outsideCount = outsideRes.count ?? 0;

    return {
      inHostelCount: Math.max((residentsRes.count ?? 0) - outsideCount, 0),
      outsideCount,
      lateReturns: ((lateRes.data || []) as unknown as (Named & { id: string; return_time: string })[]).map((p) => ({
        passId: p.id,
        studentName: studentName(p),
        returnTime: p.return_time,
        minutesLate: Math.round((now - new Date(p.return_time).getTime()) / 60000),
      })),
      pendingExitVerifications: ((exitRes.data || []) as unknown as (Named & { id: string; exit_time: string })[]).map((p) => ({
        passId: p.id,
        studentName: studentName(p),
        exitTime: p.exit_time,
        minutesOverdue: Math.round((now - new Date(p.exit_time).getTime()) / 60000),
      })),
      lateReturnCount: lateRes.count ?? 0,
      pendingExitCount: exitRes.count ?? 0,
    };
  });
}
