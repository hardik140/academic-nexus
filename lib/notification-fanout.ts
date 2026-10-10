import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { businessRpc, num } from "@/lib/business-rpc";
import { sendExpoPushNotifications } from "@/lib/push";

/**
 * College-wide notifications, written and delivered without a recipient list
 * in application memory (Redis transformation Phase 3).
 *
 * BEFORE. Each sender selected every recipient (PostgREST capped that at
 * 1,000 rows), inserted one notification per recipient from here, then asked
 * for the recipients' device tokens with an `in(user_id, …)` of all of them.
 * An announcement to a 3,000-person college reached 1,000; and because
 * device_tokens is readable only by its owner, the token lookup — run as the
 * sender — returned the sender's own token at most, so no recipient's phone
 * was ever notified.
 *
 * NOW.
 * 1. One database statement selects the recipients and writes their
 *    notifications (send_announcement / send_placement_notification,
 *    migration 059): uncapped, atomic, under the sender's RLS. Every row of
 *    the send shares an announcement_id.
 * 2. Push tokens are read a page of PUSH_PAGE at a time with a keyset cursor
 *    (notification_push_tokens), which returns only the active recipients'
 *    tokens of THAT send, only to its sender. Each page is handed to Expo in
 *    its own batches of 100. Memory stays one page, whatever the college size.
 *
 * Push stays best-effort: the notification rows, the in-app source of truth,
 * are already committed when it starts, and a push failure is logged, not
 * thrown.
 */

/** Tokens read per page; PostgREST would cap a larger page at 1,000 anyway. */
export const PUSH_PAGE = 1000;
/** A hard stop on pages per send (PUSH_PAGE × this tokens), so a fault cannot loop forever. */
const MAX_PUSH_PAGES = 500;

export interface FanOutResult {
  announcementId: string;
  recipientCount: number;
}

type Db = SupabaseClient<Database> | { rpc: SupabaseClient<Database>["rpc"] };

export async function fanOutAnnouncement(
  supabase: Db,
  params: { collegeId: string; title: string; message: string; audience: "all" | "staff" | "students" }
): Promise<FanOutResult> {
  const [row] = await businessRpc<{ announcement_id: string; recipient_count: number | string }>(supabase, "send_announcement", {
    p_college_id: params.collegeId,
    p_title: params.title,
    p_message: params.message,
    p_audience: params.audience,
  });
  return { announcementId: row?.announcement_id ?? "", recipientCount: num(row?.recipient_count) };
}

export interface PlacementTarget {
  targetType: "college" | "department" | "batch_year" | "eligible" | "custom";
  departmentId?: string | null;
  batchYear?: number | null;
  driveId?: string | null;
  studentUserIds?: string[] | null;
}

export async function fanOutPlacementNotification(
  supabase: Db,
  params: { collegeId: string; title: string; message: string; link: string } & PlacementTarget
): Promise<FanOutResult> {
  const [row] = await businessRpc<{ announcement_id: string; recipient_count: number | string }>(
    supabase,
    "send_placement_notification",
    {
      p_college_id: params.collegeId,
      p_title: params.title,
      p_message: params.message,
      p_link: params.link,
      p_target_type: params.targetType,
      p_department_id: params.departmentId ?? null,
      p_batch_year: params.batchYear ?? null,
      p_drive_id: params.driveId ?? null,
      p_student_user_ids: params.studentUserIds ?? null,
    }
  );
  return { announcementId: row?.announcement_id ?? "", recipientCount: num(row?.recipient_count) };
}

/** Pushes one send to its recipients' devices, a page at a time. Never throws. */
export async function pushAnnouncement(
  supabase: Db,
  announcementId: string,
  title: string,
  body: string,
  send: (tokens: string[], title: string, body: string) => Promise<void> = sendExpoPushNotifications
): Promise<{ tokens: number; pages: number }> {
  let after: string | null = null;
  let tokens = 0;
  let pages = 0;
  let full = false;
  try {
    while (announcementId && pages < MAX_PUSH_PAGES) {
      const page: { expo_push_token: string }[] = await businessRpc<{ expo_push_token: string }>(supabase, "notification_push_tokens", {
        p_announcement_id: announcementId,
        p_after: after,
        p_limit: PUSH_PAGE,
      });
      if (page.length === 0) break;
      pages++;
      tokens += page.length;
      await send(page.map((t) => t.expo_push_token), title, body);
      full = page.length === PUSH_PAGE;
      if (!full) break;
      after = page[page.length - 1].expo_push_token;
    }
    // The ceiling is a deliberate stop, not the end of the list: say so. The in-app notifications are all written.
    if (full && pages >= MAX_PUSH_PAGES) console.warn({ event: "notifications.push", outcome: "truncated", announcementId, pages, tokens });
  } catch (err) {
    console.error({ event: "notifications.push", outcome: "error", announcementId, pages, message: (err as Error).message });
  }
  return { tokens, pages };
}
