"use client";

import { Button } from "@/components/ui/modal";
import { formatDate } from "@/lib/format";

/**
 * A list of application sessions — the device-limit page, "Your devices",
 * and the Admin and Super Admin session views. Presentational: the caller
 * owns loading, errors and what "revoke" does.
 *
 * A session is labelled by what its client reported ("Chrome on Windows",
 * "Mobile app") and when it was last active. Labels are descriptive only;
 * nothing here identifies a device for security purposes.
 */

export interface DeviceSession {
  session_id: string;
  device_label: string | null;
  client: string;
  status: string;
  created_at: string;
  last_seen_at: string;
  is_current?: boolean;
}

const CLIENT_LABEL: Record<string, string> = {
  web: "Web browser",
  mobile: "Mobile app",
  "mobile-legacy": "Mobile app (older version)",
};

export function deviceName(session: Pick<DeviceSession, "device_label" | "client">): string {
  return session.device_label || CLIENT_LABEL[session.client] || "Unknown device";
}

export function DeviceList({
  sessions,
  onRevoke,
  pendingId,
  revokeLabel = "Sign out",
  emptyText = "No active sessions.",
}: {
  sessions: DeviceSession[];
  /** Omit to render the list read-only. */
  onRevoke?: (sessionId: string) => void;
  pendingId?: string | null;
  revokeLabel?: string;
  emptyText?: string;
}) {
  if (sessions.length === 0) {
    return <p className="text-sm text-on-surface-variant">{emptyText}</p>;
  }

  return (
    <ul className="divide-y divide-outline-variant rounded-panel border border-outline-variant" data-testid="device-list">
      {sessions.map((s) => {
        const name = deviceName(s);
        const lastActive = formatDate(s.last_seen_at, "datetime");
        return (
          <li key={s.session_id} className="flex flex-wrap items-center justify-between gap-sm px-md py-sm">
            <div className="min-w-0">
              <p className="text-sm font-medium text-on-surface">
                {name}
                {s.is_current && (
                  <span className="ml-xs rounded-full bg-info-container px-xs text-xs font-medium text-on-info-container">This device</span>
                )}
                {s.status === "rejected" && (
                  <span className="ml-xs rounded-full bg-warning-container px-xs text-xs font-medium text-on-warning-container">Not admitted</span>
                )}
              </p>
              <p className="text-xs text-on-surface-variant">
                Last active {lastActive} · signed in {formatDate(s.created_at, "datetime")}
              </p>
            </div>
            {onRevoke && !s.is_current && s.status === "active" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onRevoke(s.session_id)}
                disabled={pendingId === s.session_id}
                aria-busy={pendingId === s.session_id || undefined}
                aria-label={`${revokeLabel}: ${name}, last active ${lastActive}`}
              >
                {pendingId === s.session_id ? "Signing out…" : revokeLabel}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
