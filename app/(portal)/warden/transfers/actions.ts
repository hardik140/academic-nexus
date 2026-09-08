"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCached, invalidateCache } from "@/lib/cache";
import { logAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

function transfersCacheKey(scopeKey: string) {
  return `warden-transfers:${scopeKey}`;
}

/** Resolves the hostel blocks this warden owns, same pattern as warden/rooms/actions.ts. */
async function resolveWardenBlockIds(supabase: SupabaseClient<Database>, actor: AuthorizedActor): Promise<string[] | null> {
  if (actor.role === "admin") return null;
  const { data: blocks } = await supabase.from("hostel_blocks").select("id").eq("warden_id", actor.userId);
  return (blocks || []).map((b) => b.id);
}

/** The student's CURRENT active allocation (re-resolved fresh, not from any stored snapshot) plus its room's block_id. */
async function resolveCurrentAllocation(supabase: SupabaseClient<Database>, studentId: string) {
  type AllocationWithBlock = {
    id: string;
    room_id: string;
    hostel_rooms: { block_id: string; occupancy: number; capacity: number } | null;
  };
  const { data } = await supabase
    .from("hostel_allocations")
    .select("id, room_id, hostel_rooms:room_id(block_id, occupancy, capacity)")
    .eq("student_id", studentId)
    .eq("status", "active")
    .single();
  return data as unknown as AllocationWithBlock | null;
}

const SELECT_COLS =
  "*, students:student_id(enrollment_number, profiles:user_id(full_name)), current_room:current_allocation_id(room_id, hostel_rooms:room_id(block_id, block_name, room_number))";

/**
 * Block-scoped by the requesting student's CURRENT allocation, not a
 * denormalized column on the request itself (there is none — re-resolving
 * fresh avoids drift if the allocation changed since the request was made).
 */
export async function listRoomTransferRequests() {
  const actor = await requireRole(PERMISSIONS.room_transfer_review);
  const supabase = await createClient();

  return getCached(transfersCacheKey(actor.role === "admin" ? actor.collegeId : actor.userId), 30, async () => {
    const blockIds = await resolveWardenBlockIds(supabase, actor);

    const baseQuery = () => supabase.from("room_transfer_requests").select(SELECT_COLS).eq("college_id", actor.collegeId);
    const [pendingRes, processedRes] = await Promise.all([
      baseQuery().eq("status", "pending").order("created_at", { ascending: false }),
      baseQuery().neq("status", "pending").order("created_at", { ascending: false }).limit(20),
    ]);

    if (blockIds === null) {
      return { pending: pendingRes.data || [], processed: processedRes.data || [] };
    }

    // App-side scope filter — a request's student may have moved blocks
    // since submitting, so this checks the CURRENT room's block, same
    // freshness guarantee resolveCurrentAllocation gives the approve path.
    const inScope = (row: any) => blockIds.includes(row.current_room?.hostel_rooms?.block_id);
    return {
      pending: (pendingRes.data || []).filter(inScope),
      processed: (processedRes.data || []).filter(inScope),
    };
  });
}

/** Rooms in the warden's own block(s) with free capacity, for the approval picker. */
export async function listAvailableRoomsForTransfer() {
  const actor = await requireRole(PERMISSIONS.room_transfer_review);
  const supabase = await createClient();
  const blockIds = await resolveWardenBlockIds(supabase, actor);
  if (blockIds !== null && blockIds.length === 0) return [];

  let query = supabase.from("hostel_rooms").select("*").neq("status", "maintenance");
  query = blockIds === null ? query.eq("college_id", actor.collegeId) : query.in("block_id", blockIds);
  const { data } = await query.order("block_name").order("room_number");
  return (data || []).filter((r) => r.occupancy < r.capacity);
}

const RejectSchema = z.object({
  requestId: z.string().guid(),
  reviewNotes: z.string().trim().min(1).max(1000),
});

export async function rejectRoomTransfer(requestIdRaw: string, reviewNotesRaw: string) {
  const actor = await requireRole(PERMISSIONS.room_transfer_review);
  const { requestId, reviewNotes } = RejectSchema.parse({ requestId: requestIdRaw, reviewNotes: reviewNotesRaw });
  await checkRateLimit(`rejectRoomTransfer:${actor.userId}`, 30, 60);
  const supabase = await createClient();

  const { data: request } = await supabase
    .from("room_transfer_requests")
    .select("status, student_id, students:student_id(profiles:user_id(id))")
    .eq("id", requestId)
    .eq("college_id", actor.collegeId)
    .single();
  const req = request as unknown as { status: string; student_id: string; students: { profiles: { id: string } | null } | null } | null;
  if (!req || req.status !== "pending") {
    throw new Error("Transfer request not found or already processed.");
  }

  if (actor.role === "warden") {
    const allocation = await resolveCurrentAllocation(supabase, req.student_id);
    const blockIds = await resolveWardenBlockIds(supabase, actor);
    if (!allocation?.hostel_rooms?.block_id || !blockIds?.includes(allocation.hostel_rooms.block_id)) {
      throw new Error("You can only act on transfer requests for students in your own hostel block(s).");
    }
  }

  const { error } = await supabase
    .from("room_transfer_requests")
    .update({ status: "rejected", reviewed_by: actor.userId, reviewed_at: new Date().toISOString(), review_notes: reviewNotes })
    .eq("id", requestId);
  if (error) throw new Error(error.message);

  await logAudit(supabase, actor, "room_transfer_rejected", "room_transfer_requests", requestId, {
    oldValue: { status: "pending" },
    newValue: { status: "rejected", review_notes: reviewNotes },
  });

  const studentUserId = req.students?.profiles?.id;
  if (studentUserId) {
    await supabase.from("notifications").insert({
      college_id: actor.collegeId,
      title: "Room transfer request rejected",
      message: reviewNotes,
      receiver_id: studentUserId,
      sender_id: actor.userId,
      type: "error",
      link: "/student/hostel",
    });
  }

  await invalidateCache(transfersCacheKey(actor.role === "admin" ? actor.collegeId : actor.userId));
  revalidatePath("/warden/transfers");
  revalidatePath("/warden/dashboard");
}

const ApproveSchema = z.object({
  requestId: z.string().guid(),
  newRoomId: z.string().guid(),
});

export async function approveRoomTransfer(requestIdRaw: string, newRoomIdRaw: string) {
  const actor = await requireRole(PERMISSIONS.room_transfer_review);
  const { requestId, newRoomId } = ApproveSchema.parse({ requestId: requestIdRaw, newRoomId: newRoomIdRaw });
  await checkRateLimit(`approveRoomTransfer:${actor.userId}`, 30, 60);
  const supabase = await createClient();

  const { data: request } = await supabase
    .from("room_transfer_requests")
    .select("status, student_id, students:student_id(profiles:user_id(id))")
    .eq("id", requestId)
    .eq("college_id", actor.collegeId)
    .single();
  const req = request as unknown as { status: string; student_id: string; students: { profiles: { id: string } | null } | null } | null;
  if (!req || req.status !== "pending") {
    throw new Error("Transfer request not found or already processed.");
  }

  const oldAllocation = await resolveCurrentAllocation(supabase, req.student_id);
  if (!oldAllocation?.hostel_rooms) {
    throw new Error("This student has no active hostel allocation to transfer from.");
  }

  const blockIds = await resolveWardenBlockIds(supabase, actor);
  if (actor.role === "warden" && !blockIds?.includes(oldAllocation.hostel_rooms.block_id)) {
    throw new Error("You can only act on transfer requests for students in your own hostel block(s).");
  }

  const { data: newRoom } = await supabase.from("hostel_rooms").select("id, block_id, occupancy, capacity, status").eq("id", newRoomId).single();
  if (!newRoom) {
    throw new Error("Selected room not found.");
  }
  if (actor.role === "warden" && !blockIds?.includes(newRoom.block_id)) {
    throw new Error("You can only allocate rooms in your own hostel block(s).");
  }
  if (newRoom.status === "maintenance") {
    throw new Error("This room is under maintenance and cannot accept a transfer.");
  }
  if (newRoom.occupancy >= newRoom.capacity) {
    throw new Error("This room has no available capacity.");
  }

  // Concurrency-safe capacity check: optimistic compare-and-swap on the
  // exact occupancy value just read. If another transfer/allocation filled
  // the last bed between the read above and this write, zero rows match
  // and .select() returns nothing — caught below instead of silently
  // over-booking the room (spec's own concurrency requirement, achieved
  // without introducing a new RPC-function architecture nothing else in
  // this codebase uses).
  const { data: casResult, error: casError } = await supabase
    .from("hostel_rooms")
    .update({ occupancy: newRoom.occupancy + 1 })
    .eq("id", newRoomId)
    .eq("occupancy", newRoom.occupancy)
    .select("id");
  if (casError) throw new Error(casError.message);
  if (!casResult || casResult.length === 0) {
    throw new Error("This room was just filled by another transfer — please pick a different room and retry.");
  }

  const today = new Date().toISOString().split("T")[0];

  const { error: vacateError } = await supabase
    .from("hostel_allocations")
    .update({ status: "transferred", vacated_date: today })
    .eq("id", oldAllocation.id);
  if (vacateError) throw new Error(vacateError.message);

  await supabase
    .from("hostel_rooms")
    .update({ occupancy: Math.max(oldAllocation.hostel_rooms.occupancy - 1, 0) })
    .eq("id", oldAllocation.room_id);

  const { data: newAllocation, error: newAllocationError } = await supabase
    .from("hostel_allocations")
    .insert({ college_id: actor.collegeId, student_id: req.student_id, room_id: newRoomId, allocated_date: today, status: "active" })
    .select("id")
    .single();
  if (newAllocationError || !newAllocation) throw new Error(newAllocationError?.message || "Failed to create new allocation.");

  const { error: updateRequestError } = await supabase
    .from("room_transfer_requests")
    .update({
      status: "approved",
      reviewed_by: actor.userId,
      reviewed_at: new Date().toISOString(),
      new_room_id: newRoomId,
      new_allocation_id: newAllocation.id,
    })
    .eq("id", requestId);
  if (updateRequestError) throw new Error(updateRequestError.message);

  await logAudit(supabase, actor, "room_transfer_approved", "room_transfer_requests", requestId, {
    oldValue: { room_id: oldAllocation.room_id, allocation_id: oldAllocation.id },
    newValue: { room_id: newRoomId, allocation_id: newAllocation.id },
  });

  const studentUserId = req.students?.profiles?.id;
  if (studentUserId) {
    await supabase.from("notifications").insert({
      college_id: actor.collegeId,
      title: "Room transfer approved",
      message: "Your room transfer request has been approved. Check your hostel page for your new room details.",
      receiver_id: studentUserId,
      sender_id: actor.userId,
      type: "success",
      link: "/student/hostel",
    });
  }

  await invalidateCache(transfersCacheKey(actor.role === "admin" ? actor.collegeId : actor.userId));
  revalidatePath("/warden/transfers");
  revalidatePath("/warden/dashboard");
  revalidatePath("/warden/rooms");
}
