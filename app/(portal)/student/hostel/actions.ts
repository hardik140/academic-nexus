"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { PERMISSIONS } from "@/lib/permissions";
import { dbError } from "@/lib/internal-error";

const RequestTransferSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});

export async function requestRoomTransfer(reasonRaw: string) {
  const actor = await requireRole(PERMISSIONS.room_transfer_request);
  const { reason } = RequestTransferSchema.parse({ reason: reasonRaw });
  await checkRateLimit(`requestRoomTransfer:${actor.userId}`, 5, 3600);
  const supabase = await createClient();

  const { data: student } = await supabase.from("students").select("id").eq("user_id", actor.userId).single();
  if (!student) {
    throw new Error("No student record found for this account.");
  }

  const { data: allocation } = await supabase
    .from("hostel_allocations")
    .select("id")
    .eq("student_id", student.id)
    .eq("status", "active")
    .single();
  if (!allocation) {
    throw new Error("You don't have an active hostel allocation to transfer from.");
  }

  const { data: existingPending } = await supabase
    .from("room_transfer_requests")
    .select("id")
    .eq("student_id", student.id)
    .eq("status", "pending")
    .maybeSingle();
  if (existingPending) {
    throw new Error("You already have a pending room transfer request.");
  }

  const { error } = await supabase.from("room_transfer_requests").insert({
    college_id: actor.collegeId,
    student_id: student.id,
    current_allocation_id: allocation.id,
    reason,
  });
  if (error) {
    throw dbError(error);
  }

  revalidatePath("/student/hostel");
}

/** This student's own transfer request history, most recent first. */
export async function listMyRoomTransferRequests() {
  const actor = await requireRole(PERMISSIONS.room_transfer_request);
  const supabase = await createClient();
  const { data: student } = await supabase.from("students").select("id").eq("user_id", actor.userId).single();
  if (!student) return [];
  const { data } = await supabase
    .from("room_transfer_requests")
    .select("*")
    .eq("student_id", student.id)
    .order("created_at", { ascending: false });
  return data || [];
}
