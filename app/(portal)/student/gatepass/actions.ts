"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";

export async function applyForGatePass(params: {
  destination: string;
  reason: string;
  exitTime: string;
  returnTime: string;
}) {
  const actor = await requireRole(["student"]);
  await checkRateLimit(`applyForGatePass:${actor.userId}`, 5, 60);
  const supabase = await createClient();

  const { data: student } = await supabase
    .from("students")
    .select("id")
    .eq("user_id", actor.userId)
    .single();

  if (!student) {
    throw new Error("No student record found for this account.");
  }

  const { error } = await supabase.from("gate_passes").insert({
    college_id: actor.collegeId,
    student_id: student.id,
    destination: params.destination,
    reason: params.reason,
    exit_time: params.exitTime,
    return_time: params.returnTime,
    status: "pending",
  });

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath("/student/gatepass");
}
