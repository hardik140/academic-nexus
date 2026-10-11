"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type AuthorizedActor } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { sendExpoPushNotifications } from "@/lib/push";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { dbError } from "@/lib/internal-error";
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
 * Resolves a placement-specific audience into recipient profile (user)
 * ids, entirely server-side — mirrors sendAnnouncementCore's
 * (director/dashboard/actions.ts) "never send to everyone, always resolve
 * a scoped list first" shape, extended with drive-eligibility and custom
 * targeting instead of the simpler all/staff/students enum.
 */
async function resolveRecipientUserIds(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: z.infer<typeof SendPlacementNotificationSchema>
): Promise<string[]> {
  if (params.targetType === "college") {
    const { data, error: dataError } = await supabase.from("students").select("user_id").eq("college_id", actor.collegeId);
    assertRead(dataError);
    return (data || []).map((s) => s.user_id);
  }

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
    const { data, error: dataError2 } = await supabase
      .from("students")
      .select("user_id")
      .eq("college_id", actor.collegeId)
      .eq("department_id", params.departmentId);
    assertRead(dataError2);
    return (data || []).map((s) => s.user_id);
  }

  if (params.targetType === "batch_year") {
    if (!params.batchYear) throw new Error("Select a batch year.");
    const { data, error: dataError3 } = await supabase
      .from("students")
      .select("user_id")
      .eq("college_id", actor.collegeId)
      .eq("batch_year", params.batchYear);
    assertRead(dataError3);
    return (data || []).map((s) => s.user_id);
  }

  if (params.targetType === "eligible") {
    if (!params.driveId) throw new Error("Select a placement drive.");
    const { data: drive, error: driveError } = await supabase
      .from("placement_drives")
      .select("id, college_id, min_cgpa, eligible_batch_years")
      .eq("id", params.driveId)
      .single();
    assertRead(driveError);
    if (!drive || drive.college_id !== actor.collegeId) {
      throw new Error("Placement drive not found in your college.");
    }

    const { data: eligibleDepartments, error: eligibleDepartmentsError } = await supabase
      .from("placement_drive_departments")
      .select("department_id")
      .eq("drive_id", params.driveId);
    assertRead(eligibleDepartmentsError);
    const deptIds = (eligibleDepartments || []).map((d) => d.department_id);

    const { data: students, error: studentsError } = await supabase
      .from("students")
      .select("user_id, cgpa, batch_year, department_id")
      .eq("college_id", actor.collegeId);
    assertRead(studentsError);

    return (students || [])
      .filter((s) => {
        if (drive.min_cgpa != null && (s.cgpa ?? 0) < drive.min_cgpa) return false;
        if (drive.eligible_batch_years && drive.eligible_batch_years.length > 0 && !drive.eligible_batch_years.includes(s.batch_year)) {
          return false;
        }
        if (deptIds.length > 0 && !deptIds.includes(s.department_id)) return false;
        return true;
      })
      .map((s) => s.user_id);
  }

  // custom — a Placement Cell-picked group, still re-verified server-side
  // against the actor's own college rather than trusted as-is.
  if (!params.studentUserIds || params.studentUserIds.length === 0) {
    throw new Error("Select at least one student.");
  }
  const { data, error: dataError4 } = await supabase
    .from("students")
    .select("user_id")
    .eq("college_id", actor.collegeId)
    .in("user_id", params.studentUserIds);
  assertRead(dataError4);
  return (data || []).map((s) => s.user_id);
}

async function sendPlacementNotificationCore(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  params: SendPlacementNotificationParams
) {
  const parsed = SendPlacementNotificationSchema.parse(params);
  await checkRateLimit(`sendPlacementNotification:${actor.userId}`, 10, 3600);

  const recipientIds = await resolveRecipientUserIds(supabase, actor, parsed);
  if (recipientIds.length === 0) {
    throw new Error("No recipients found for the selected audience.");
  }

  const link = parsed.driveId ? `/student/placements?drive=${parsed.driveId}` : "/student/placements";

  const { error } = await supabase.from("notifications").insert(
    recipientIds.map((receiverId) => ({
      college_id: actor.collegeId,
      title: parsed.title,
      message: parsed.message,
      receiver_id: receiverId,
      sender_id: actor.userId,
      type: "action_required" as const,
      link,
    }))
  );
  if (error) {
    throw dbError(error);
  }

  // Best-effort push — see lib/push.ts's doc comment; a push failure must
  // never surface as "the notification failed" since the notifications
  // rows (the in-app source of truth) are already written by this point.
  const { data: deviceTokens } = await supabase.from("device_tokens").select("expo_push_token").in("user_id", recipientIds);
  if (deviceTokens && deviceTokens.length > 0) {
    await sendExpoPushNotifications(deviceTokens.map((d) => d.expo_push_token), parsed.title, parsed.message);
  }

  await logAudit(supabase, actor, `Sent placement notification: ${parsed.title}`, "notifications", parsed.driveId || "college-wide");
  return { recipientCount: recipientIds.length };
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
