"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { dbError } from "@/lib/internal-error";

/**
 * Director-only for this pass (see components/portal/portal-shell.tsx —
 * only the director role's bell routes here). Self-scoped regardless: RLS
 * (notifications_read_own / notifications_update_own) already restricts to
 * receiver_id = auth.uid(), so this needs no new permission entry.
 */
export async function listMyNotifications() {
  const actor = await requireRole(["director"]);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("receiver_id", actor.userId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    throw dbError(error);
  }
  return data || [];
}

export async function markNotificationRead(notificationId: string) {
  const actor = await requireRole(["director"]);
  const supabase = await createClient();
  const { error } = await supabase.from("notifications").update({ read: true }).eq("id", notificationId).eq("receiver_id", actor.userId);
  if (error) {
    throw dbError(error);
  }
  revalidatePath("/director/notifications");
}

export async function markAllNotificationsRead() {
  const actor = await requireRole(["director"]);
  const supabase = await createClient();
  const { error } = await supabase.from("notifications").update({ read: true }).eq("receiver_id", actor.userId).eq("read", false);
  if (error) {
    throw dbError(error);
  }
  revalidatePath("/director/notifications");
}
