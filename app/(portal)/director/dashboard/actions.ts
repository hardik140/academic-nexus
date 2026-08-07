"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCached } from "@/lib/cache";
import { checkRateLimit } from "@/lib/rate-limit";

const STAFF_ROLES = ["teacher", "hod", "warden", "finance", "admin"] as const;

export async function getDashboardStats() {
  const actor = await requireRole(["director", "admin"]);
  const supabase = await createClient();

  return getCached(`dashboard:director:${actor.collegeId}:counts`, 60, async () => {
    const [studentsRes, facultyRes, deptsRes] = await Promise.all([
      supabase.from("profiles").select("*", { count: "exact", head: true }).eq("role", "student"),
      supabase.from("profiles").select("*", { count: "exact", head: true }).eq("role", "teacher"),
      supabase.from("departments").select("*", { count: "exact", head: true }),
    ]);
    return {
      totalStudents: studentsRes.count || 0,
      totalFaculty: facultyRes.count || 0,
      totalDepartments: deptsRes.count || 0,
    };
  });
}

export async function sendAnnouncement(
  title: string,
  message: string,
  audience: "all" | "staff" | "students"
) {
  const actor = await requireRole(["director", "admin"]);
  await checkRateLimit(`sendAnnouncement:${actor.userId}`, 10, 3600);
  const supabase = await createClient();

  if (!title.trim() || !message.trim()) {
    throw new Error("Title and message are required.");
  }

  let query = supabase.from("profiles").select("id").eq("college_id", actor.collegeId);
  if (audience === "staff") {
    query = query.in("role", STAFF_ROLES);
  } else if (audience === "students") {
    query = query.eq("role", "student");
  }

  const { data: recipients, error: recipientsError } = await query;
  if (recipientsError) {
    throw new Error(recipientsError.message);
  }
  if (!recipients || recipients.length === 0) {
    throw new Error("No recipients found for the selected audience.");
  }

  const { error } = await supabase.from("notifications").insert(
    recipients.map((r) => ({
      college_id: actor.collegeId,
      title,
      message,
      receiver_id: r.id,
      sender_id: actor.userId,
      type: "info" as const,
    }))
  );

  if (error) {
    throw new Error(error.message);
  }

  return { recipientCount: recipients.length };
}
