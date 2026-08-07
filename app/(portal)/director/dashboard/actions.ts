"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { getCached } from "@/lib/cache";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendExpoPushNotifications } from "@/lib/push";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

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

export interface SendAnnouncementParams {
  title: string;
  message: string;
  audience: "all" | "staff" | "students";
}

/**
 * Shared by the web Server Action below and
 * app/api/mobile/director/announcement's Route Handler — same guarded
 * logic either way, just a different transport. Rate limit is keyed and
 * checked by the caller (below) since it also gates the request before any
 * work happens.
 */
export async function sendAnnouncementCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: SendAnnouncementParams
) {
  const { title, message, audience } = params;

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

  // Push delivery to any recipient with a registered device (mobile app).
  // Best-effort — see lib/push.ts's doc comment; a push failure must never
  // surface as "the announcement failed" since the notifications rows (the
  // in-app source of truth) are already written by this point.
  const { data: deviceTokens } = await supabase
    .from("device_tokens")
    .select("expo_push_token")
    .in("user_id", recipients.map((r) => r.id));

  if (deviceTokens && deviceTokens.length > 0) {
    await sendExpoPushNotifications(
      deviceTokens.map((d) => d.expo_push_token),
      title,
      message
    );
  }

  return { recipientCount: recipients.length };
}

export async function sendAnnouncement(
  title: string,
  message: string,
  audience: "all" | "staff" | "students"
) {
  const actor = await requireRole(["director", "admin"]);
  await checkRateLimit(`sendAnnouncement:${actor.userId}`, 10, 3600);
  const supabase = await createClient();
  return sendAnnouncementCore(supabase, actor, { title, message, audience });
}

/** Called by app/api/mobile/director/announcement/route.ts. */
export async function sendAnnouncementViaRequest(request: Request, params: SendAnnouncementParams) {
  const { supabase, ...actor } = await requireRoleFromRequest(request, ["director", "admin"]);
  await checkRateLimit(`sendAnnouncement:${actor.userId}`, 10, 3600);
  return sendAnnouncementCore(supabase, actor, params);
}
