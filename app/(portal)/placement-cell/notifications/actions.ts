"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { fanOutPlacementNotification, pushAnnouncement } from "@/lib/notification-fanout";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { assertRead } from "@/lib/read-result-server";

const OPERATOR_ROLES = ["placement_cell", "admin"] as const;

const SendPlacementNotificationSchema = z.object({
  title: z.string().trim().min(1, { message: "Title is required." }).max(200),
  message: z.string().trim().min(1, { message: "Message is required." }).max(2000),
  targetType: z.enum(["college", "department", "batch_year", "eligible", "custom"]),
  departmentId: z.string().guid().optional(),
  batchYear: z.number().int().optional(),
  driveId: z.string().guid().optional(),
  studentUserIds: z.array(z.string().guid()).optional(),
});

export interface SendPlacementNotificationParams {
  title: string;
  message: string;
  targetType: "college" | "department" | "batch_year" | "eligible" | "custom";
  departmentId?: string;
  batchYear?: number;
  driveId?: string;
  studentUserIds?: string[];
}

/**
 * Checks a placement-specific audience before anything is sent: the
 * department or drive it names must belong to the sender's college, and a
 * custom audience must name someone. Same checks and messages as before.
 *
 * Who receives it is no longer resolved here. The recipients used to be read
 * into this function — every student of the college, capped at PostgREST's
 * 1,000 rows, and for "eligible" the first 1,000 students filtered by CGPA,
 * batch and department in JavaScript, so eligible students past that page
 * were never told. Now send_placement_notification (migration 059) applies
 * the same targeting in ONE statement over every student, under the
 * sender's RLS. See lib/notification-fanout.ts.
 */
async function assertAudienceInCollege(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: z.infer<typeof SendPlacementNotificationSchema>
): Promise<void> {
  if (params.targetType === "department") {
    if (!params.departmentId) throw new Error("Select a department.");
    const { data: dept, error: deptError } = await supabase
      .from("departments")
      .select("id, college_id")
      .eq("id", params.departmentId)
      .single();
    assertRead(deptError);
    if (!dept || dept.college_id !== actor.collegeId) {
      throw new Error("Department not found in your college.");
    }
  }

  if (params.targetType === "batch_year" && !params.batchYear) {
    throw new Error("Select a batch year.");
  }

  if (params.targetType === "eligible") {
    if (!params.driveId) throw new Error("Select a placement drive.");
    const { data: drive, error: driveError } = await supabase
      .from("placement_drives")
      .select("id, college_id")
      .eq("id", params.driveId)
      .single();
    assertRead(driveError);
    if (!drive || drive.college_id !== actor.collegeId) {
      throw new Error("Placement drive not found in your college.");
    }
  }

  // custom — a Placement Cell-picked group, still restricted server-side to
  // students of the actor's own college rather than trusted as-is.
  if (params.targetType === "custom" && (!params.studentUserIds || params.studentUserIds.length === 0)) {
    throw new Error("Select at least one student.");
  }
}

async function sendPlacementNotificationCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: SendPlacementNotificationParams
) {
  const parsed = SendPlacementNotificationSchema.parse(params);
  await checkRateLimit(`sendPlacementNotification:${actor.userId}`, 10, 3600);
  await assertAudienceInCollege(supabase, actor, parsed);

  const link = parsed.driveId ? `/student/placements?drive=${parsed.driveId}` : "/student/placements";

  const { announcementId, recipientCount } = await fanOutPlacementNotification(supabase, {
    collegeId: actor.collegeId,
    title: parsed.title,
    message: parsed.message,
    link,
    targetType: parsed.targetType,
    departmentId: parsed.departmentId,
    batchYear: parsed.batchYear,
    driveId: parsed.driveId,
    studentUserIds: parsed.studentUserIds,
  });
  if (recipientCount === 0) {
    throw new Error("No recipients found for the selected audience.");
  }

  // Best-effort push, a page of device tokens at a time; the notification
  // rows (the in-app source of truth) are already committed.
  await pushAnnouncement(supabase, announcementId, parsed.title, parsed.message);

  await logAudit(supabase, actor, `Sent placement notification: ${parsed.title}`, "notifications", parsed.driveId || "college-wide");
  return { recipientCount };
}

export async function sendPlacementNotification(params: SendPlacementNotificationParams) {
  const actor = await requireRole(OPERATOR_ROLES);
  const supabase = await createClient();
  const result = await sendPlacementNotificationCore(supabase, actor, params);
  revalidatePath("/placement-cell/notifications");
  return result;
}

/** Recently sent placement notifications, for the notifications history list. */
export async function listSentPlacementNotifications() {
  const actor = await requireRole(OPERATOR_ROLES);
  const supabase = await createClient();
  const { data, error: dataError } = await supabase
    .from("notifications")
    .select("id, title, message, link, created_at, read")
    .eq("college_id", actor.collegeId)
    .eq("sender_id", actor.userId)
    .order("created_at", { ascending: false })
    .limit(50);
  assertRead(dataError);
  return data || [];
}
