"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import type { Database } from "@/types/database";

type LeaveType = Database["public"]["Tables"]["leave_requests"]["Row"]["leave_type"];

export async function applyForLeave(params: {
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  reason: string;
}) {
  const actor = await requireRole(["teacher", "admin"]);
  const supabase = await createClient();

  const { error } = await supabase.from("leave_requests").insert({
    college_id: actor.collegeId,
    requested_by: actor.userId,
    leave_type: params.leaveType,
    start_date: params.startDate,
    end_date: params.endDate,
    reason: params.reason,
  });

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath("/teacher/leave");
}
