"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireRoleFromRequest, type AuthorizedActor } from "@/lib/rbac";
import { getCachedWriteBehind } from "@/lib/cache";
import { checkRateLimit } from "@/lib/rate-limit";
import { fanOutAnnouncement, pushAnnouncement } from "@/lib/notification-fanout";
import { PERMISSIONS } from "@/lib/permissions";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { assertRead } from "@/lib/read-result-server";

export async function getDashboardStats() {
  const actor = await requireRole(["director", "admin"]);
  const supabase = await createClient();

  return getCachedWriteBehind(`dashboard:director:${actor.collegeId}:counts`, 60, async () => {
    const [studentsRes, facultyRes, deptsRes] = await Promise.all([
      supabase.from("profiles").select("*", { count: "exact", head: true }).eq("role", "student"),
      supabase.from("profiles").select("*", { count: "exact", head: true }).eq("role", "teacher"),
      supabase.from("departments").select("*", { count: "exact", head: true }),
    ]);
    assertRead(studentsRes.error);
    assertRead(facultyRes.error);
    assertRead(deptsRes.error);
    return {
      totalStudents: studentsRes.count || 0,
      totalFaculty: facultyRes.count || 0,
      totalDepartments: deptsRes.count || 0,
    };
  });
}

const SendAnnouncementSchema = z.object({
  title: z.string().trim().min(1, { message: "Title is required." }).max(200),
  message: z.string().trim().min(1, { message: "Message is required." }).max(2000),
  audience: z.enum(["all", "staff", "students"]),
});

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
  const { title, message, audience } = SendAnnouncementSchema.parse(params);

  // Recipients selected and notifications written in ONE database statement
  // (migration 059, send_announcement): no recipient list here, no
  // PostgREST row cap, all rows or none. "staff" is teacher, hod, warden,
  // finance and admin, as before (pinned by tests/staging-fanout.test.ts).
  // See lib/notification-fanout.ts for what this replaced.
  const { announcementId, recipientCount } = await fanOutAnnouncement(supabase, {
    collegeId: actor.collegeId,
    title,
    message,
    audience,
  });
  if (recipientCount === 0) {
    throw new Error("No recipients found for the selected audience.");
  }

  // Best-effort push, a page of device tokens at a time; the notification
  // rows are already committed.
  await pushAnnouncement(supabase, announcementId, title, message);

  return { recipientCount };
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

/**
 * Command Center home data: the latest health snapshot (written by the
 * snapshot-health-score cron), a "baseline" snapshot from at-or-before this
 * director's last visit (for real "what changed since last login" deltas —
 * not just "since the last cron tick"), and small previews of open risk
 * flags / pending decisions. Reads command_center_view_state.last_viewed_at
 * BEFORE overwriting it with now(), so the comparison is always against the
 * prior visit, never the one currently in progress.
 */
export async function getCommandCenterData() {
  const actor = await requireRole(PERMISSIONS.institution_health_read);
  const supabase = await createClient();

  const { data: viewState, error: viewStateError } = await supabase
    .from("command_center_view_state")
    .select("last_viewed_at")
    .eq("user_id", actor.userId)
    .maybeSingle();
  assertRead(viewStateError);
  const priorViewedAt = viewState?.last_viewed_at ?? null;

  const [latestRes, baselineRes, riskFlagsRes, decisionsRes] = await Promise.all([
    supabase
      .from("institution_metric_snapshots")
      .select("*")
      .eq("college_id", actor.collegeId)
      .order("snapshot_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    priorViewedAt
      ? supabase
          .from("institution_metric_snapshots")
          .select("*")
          .eq("college_id", actor.collegeId)
          .lte("snapshot_at", priorViewedAt)
          .order("snapshot_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from("risk_flags")
      .select("id, title, severity, flag_type")
      .eq("college_id", actor.collegeId)
      .in("status", ["open", "assigned", "acknowledged", "in_progress"])
      .order("severity", { ascending: false })
      .limit(5),
    supabase
      .from("decisions")
      .select("id, title, urgency")
      .eq("college_id", actor.collegeId)
      .eq("status", "pending")
      .order("urgency", { ascending: false })
      .limit(5),
  ]);
  assertRead(latestRes.error);
  assertRead(baselineRes.error);
  assertRead(riskFlagsRes.error);
  assertRead(decisionsRes.error);

  await supabase.from("command_center_view_state").upsert({
    user_id: actor.userId,
    college_id: actor.collegeId,
    last_viewed_at: new Date().toISOString(),
  });

  return {
    latest: latestRes.data,
    baseline: baselineRes.data,
    priorViewedAt,
    topRiskFlags: riskFlagsRes.data || [],
    topDecisions: decisionsRes.data || [],
  };
}
