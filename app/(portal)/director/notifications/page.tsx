"use client";

import { useState } from "react";
import { Button } from "@/components/ui/modal";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { listMyNotifications, markAllNotificationsRead, markNotificationRead } from "./actions";

const TYPE_FILTERS = ["all", "action_required", "warning", "error", "success", "info"] as const;

const TYPE_ICONS: Record<string, string> = {
  action_required: "🔔",
  warning: "⚠️",
  error: "🚨",
  success: "✅",
  info: "ℹ️",
};

export default function DirectorNotifications() {
  const [filter, setFilter] = useState<(typeof TYPE_FILTERS)[number]>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<FeedbackError | null>(null);

  // A failed load is an error, never "No notifications." (owner decision D5).
  const notificationsResource = useAsyncResource(() => listMyNotifications(), []);
  const notifications: any[] = notificationsResource.data ?? [];

  const markRead = async (key: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await fn();
      notificationsResource.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "The notification couldn't be marked read."));
    } finally {
      setBusy(null);
    }
  };

  const filtered = filter === "all" ? notifications : notifications.filter((n) => n.type === filter);
  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <div className="space-y-lg">
      <div className="flex items-start justify-between gap-md">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Notifications</h1>
          <p className="text-sm text-on-surface-variant mt-xs">{unreadCount} unread</p>
        </div>
        {unreadCount > 0 && (
          <Button
            variant="outline"
            disabled={busy !== null}
            aria-busy={busy === "all" || undefined}
            onClick={() => markRead("all", () => markAllNotificationsRead())}
          >
            Mark All Read
          </Button>
        )}
      </div>

      <div className="flex gap-xs flex-wrap">
        {TYPE_FILTERS.map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`text-xs font-semibold px-md py-xs rounded-full capitalize transition-colors ${
              filter === t ? "bg-secondary text-on-secondary" : "bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high"
            }`}
          >
            {t.replace(/_/g, " ")}
          </button>
        ))}
      </div>

      <ErrorAlert error={error} />

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <StateView state={notificationsResource} isEmpty={() => false} loadingLabel="Loading notifications…" empty={{ title: "No notifications" }}>
          {() => (
        <div className="divide-y divide-outline-variant">
          {filtered.length > 0 ? (
            filtered.map((n) => (
              <div key={n.id} className={`px-lg py-md flex items-start gap-sm ${!n.read ? "bg-secondary/5" : ""}`}>
                <span className="text-lg shrink-0">{TYPE_ICONS[n.type] || "•"}</span>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-on-surface">{n.title}</div>
                  <div className="text-xs text-on-surface-variant mt-xs">{n.message}</div>
                  <div className="text-[10px] text-outline mt-xs">{new Date(n.created_at).toLocaleString()}</div>
                </div>
                {!n.read && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    aria-busy={busy === n.id || undefined}
                    onClick={() => markRead(n.id, () => markNotificationRead(n.id))}
                    className="text-xs font-medium text-secondary hover:underline shrink-0 disabled:opacity-50"
                  >
                    Mark read
                  </button>
                )}
              </div>
            ))
          ) : (
            <div className="p-xl text-center text-sm text-outline">No notifications.</div>
          )}
        </div>
          )}
        </StateView>
      </div>
    </div>
  );
}
