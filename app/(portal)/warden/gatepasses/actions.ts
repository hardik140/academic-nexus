"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { resolveListSort, listCacheKey } from "@/lib/cached-list";
import { logAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { DataTableQuery } from "@/components/ui/data-table";

const PROCESSED_PAGE_SIZE = 10;
const PROCESSED_SORT_COLUMNS = ["exit_time", "destination"] as const;
const PROCESSED_CACHE_PREFIX = "list:gatepasses";

function pendingCacheKey(scopeKey: string) {
  return `pending:gatepasses:${scopeKey}`;
}

/**
 * Block-scoping resolver shared by every function below — same
 * hostel_blocks.warden_id -> blockIds -> allocated-student-ids chain
 * warden/rooms/actions.ts's listWardenRooms already uses for hostel_rooms.
 * Returns null for admin (unrestricted); an array (possibly empty) of
 * students(id) values for warden.
 */
export async function resolveWardenScopedStudentIds(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor
): Promise<string[] | null> {
  if (actor.role === "admin") return null;

  const { data: blocks } = await supabase.from("hostel_blocks").select("id").eq("warden_id", actor.userId);
  const blockIds = (blocks || []).map((b) => b.id);
  if (blockIds.length === 0) return [];

  const { data: rooms } = await supabase.from("hostel_rooms").select("id").in("block_id", blockIds);
  const roomIds = (rooms || []).map((r) => r.id);
  if (roomIds.length === 0) return [];

  const { data: allocations } = await supabase
    .from("hostel_allocations")
    .select("student_id")
    .in("room_id", roomIds)
    .eq("status", "active");
  return (allocations || []).map((a) => a.student_id);
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
  const studentIds = await resolveWardenScopedStudentIds(supabase, actor);

  return getCached(pendingCacheKey(actor.role === "admin" ? actor.collegeId : actor.userId), 15, async () => {
    if (studentIds !== null && studentIds.length === 0) return [];
    let dbQuery = supabase
      .from("gate_passes")
      .select("*, students:student_id(enrollment_number, profiles:user_id(full_name))")
      .eq("status", "pending")
      .eq("college_id", actor.collegeId);
    if (studentIds !== null) dbQuery = dbQuery.in("student_id", studentIds);
    const { data } = await dbQuery.order("created_at", { ascending: false });
    return data || [];
  });
}

export async function listProcessedGatePasses(q: DataTableQuery) {
  const actor = await requireRole(PERMISSIONS.gatepass_review);
  const supabase = await createClient();
  const studentIds = await resolveWardenScopedStudentIds(supabase, actor);

  const { column, ascending } = resolveListSort(PROCESSED_SORT_COLUMNS, "created_at", false, q);
  const cacheKey = listCacheKey(PROCESSED_CACHE_PREFIX, actor.role === "admin" ? actor.collegeId : actor.userId, q, column);

  return getCached(cacheKey, 30, async () => {
    if (studentIds !== null && studentIds.length === 0) return { data: [], count: 0 };
    let dbQuery = supabase
      .from("gate_passes")
      .select("*, students:student_id(enrollment_number, profiles:user_id(full_name))", { count: "exact" })
      .neq("status", "pending")
      .eq("college_id", actor.collegeId);
    if (studentIds !== null) dbQuery = dbQuery.in("student_id", studentIds);
    const { data, count } = await dbQuery
      .order(column, { ascending })
      .range(q.page * PROCESSED_PAGE_SIZE, q.page * PROCESSED_PAGE_SIZE + PROCESSED_PAGE_SIZE - 1);
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

  const { error } = await supabase
    .from("gate_passes")
    .update({
      status: action,
      approved_by: actor.userId,
      approved_at: new Date().toISOString(),
    })
    .eq("id", passId)
    .eq("college_id", actor.collegeId);

  if (error) {
    throw new Error(error.message);
  }

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
  action: "approved" | "rejected",
  processedViewQuery?: DataTableQuery
) {
  const actor = await requireRole(PERMISSIONS.gatepass_review);
  const supabase = await createClient();
  await actOnGatePassCore(supabase, actor, passId, action);
  revalidatePath("/warden/gatepasses");
  revalidatePath("/warden/dashboard");

  await invalidateCache(pendingCacheKey(actor.role === "admin" ? actor.collegeId : actor.userId));
  if (processedViewQuery) {
    const { column } = resolveListSort(PROCESSED_SORT_COLUMNS, "created_at", false, processedViewQuery);
    await invalidateCache(
      listCacheKey(PROCESSED_CACHE_PREFIX, actor.role === "admin" ? actor.collegeId : actor.userId, processedViewQuery, column)
    );
  }
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
});

/**
 * Wires up gate_passes' actual_exit/actual_return columns and
 * active/returned status values — defined in schema since migration 004,
 * never read or written by any app code until now. This is what turns
 * "gate pass approved" into real entry/exit tracking: exit verification
 * requires status='approved' -> 'active' (+actual_exit); return
 * verification requires 'active' -> 'returned' (+actual_return). No
 * separate "security/gate staff" role exists in this schema, so the
 * warden performs verification themselves, same as approval already is.
 */
export async function verifyGatePassMovementCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  passIdRaw: string,
  actionRaw: "exit" | "return"
) {
  const { passId, action } = VerifyMovementSchema.parse({ passId: passIdRaw, action: actionRaw });
  await checkRateLimit(`verifyGatePassMovement:${actor.userId}`, 30, 60);

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
        ? "This gate pass must be approved before exit can be verified."
        : "This gate pass must have a verified exit before return can be verified."
    );
  }

  const update =
    action === "exit"
      ? { status: "active" as const, actual_exit: new Date().toISOString() }
      : { status: "returned" as const, actual_return: new Date().toISOString() };

  const { error } = await supabase.from("gate_passes").update(update).eq("id", passId);
  if (error) {
    throw new Error(error.message);
  }

  await logAudit(supabase, actor, `gate_pass_${action}_verified`, "gate_passes", passId, {
    oldValue: { status: pass.status },
    newValue: update,
  });
}

export async function verifyGatePassMovement(passId: string, action: "exit" | "return") {
  const actor = await requireRole(PERMISSIONS.gatepass_verify_movement);
  const supabase = await createClient();
  await verifyGatePassMovementCore(supabase, actor, passId, action);
  revalidatePath("/warden/gatepasses");
  revalidatePath("/warden/dashboard");
  await invalidateCache(pendingCacheKey(actor.role === "admin" ? actor.collegeId : actor.userId));
}

/** Called by app/api/mobile/gatepass/verify-movement/route.ts, if/when a mobile screen needs it. */
export async function verifyGatePassMovementViaRequest(request: Request, passId: string, action: "exit" | "return") {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["warden", "admin"]);
  await verifyGatePassMovementCore(supabase, actor, passId, action);
}

// An 'active' pass whose return_time + grace has passed with no
// actual_return yet — matches the spec's own worked example (30 min grace).
const LATE_RETURN_GRACE_MINUTES = 30;

export interface GateOperationsSnapshot {
  inHostelCount: number;
  outsideCount: number;
  lateReturns: { passId: string; studentName: string; returnTime: string; minutesLate: number }[];
  pendingExitVerifications: { passId: string; studentName: string; exitTime: string; minutesOverdue: number }[];
}

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
    const studentIds = await resolveWardenScopedStudentIds(supabase, actor);
    if (studentIds !== null && studentIds.length === 0) {
      return { inHostelCount: 0, outsideCount: 0, lateReturns: [], pendingExitVerifications: [] };
    }

    const totalResidentsQuery =
      studentIds === null
        ? supabase.from("hostel_allocations").select("student_id", { count: "exact", head: true }).eq("college_id", actor.collegeId).eq("status", "active")
        : Promise.resolve({ count: studentIds.length });

    let gatePassesQuery = supabase
      .from("gate_passes")
      .select("id, status, return_time, exit_time, students:student_id(profiles:user_id(full_name))")
      .in("status", ["active", "approved"])
      .eq("college_id", actor.collegeId);
    if (studentIds !== null) gatePassesQuery = gatePassesQuery.in("student_id", studentIds);

    const [totalResidentsRes, gatePassesRes] = await Promise.all([totalResidentsQuery, gatePassesQuery]);
    const totalResidents = (totalResidentsRes as { count: number | null }).count ?? 0;

    const now = Date.now();
    const graceMs = LATE_RETURN_GRACE_MINUTES * 60 * 1000;
    let outsideCount = 0;
    const lateReturns: GateOperationsSnapshot["lateReturns"] = [];
    const pendingExitVerifications: GateOperationsSnapshot["pendingExitVerifications"] = [];

    for (const p of (gatePassesRes.data || []) as unknown as {
      id: string;
      status: "active" | "approved";
      return_time: string;
      exit_time: string;
      students: { profiles: { full_name: string } | null } | null;
    }[]) {
      const studentName = p.students?.profiles?.full_name || "Unknown";
      if (p.status === "active") {
        outsideCount++;
        const dueAt = new Date(p.return_time).getTime() + graceMs;
        if (now > dueAt) {
          lateReturns.push({
            passId: p.id,
            studentName,
            returnTime: p.return_time,
            minutesLate: Math.round((now - new Date(p.return_time).getTime()) / 60000),
          });
        }
      } else if (p.status === "approved") {
        const exitAt = new Date(p.exit_time).getTime();
        if (now > exitAt) {
          pendingExitVerifications.push({
            passId: p.id,
            studentName,
            exitTime: p.exit_time,
            minutesOverdue: Math.round((now - exitAt) / 60000),
          });
        }
      }
    }

    return {
      inHostelCount: Math.max(totalResidents - outsideCount, 0),
      outsideCount,
      lateReturns,
      pendingExitVerifications,
    };
  });
}
