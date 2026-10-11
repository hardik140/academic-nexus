"use client";

import { useState } from "react";
import { Button } from "@/components/ui/modal";
import { UnavailableView } from "@/components/portal/unavailable-view";
import { DeviceList, type DeviceSession } from "@/components/portal/device-list";
import { SessionsDialog } from "@/components/portal/sessions-dialog";
import {
  LifecycleBadge,
  LifecycleDialog,
  LifecycleHistoryDialog,
  type LifecycleChange,
  type LifecycleHistoryEntry,
} from "@/components/portal/college-lifecycle";
import { SessionEnforcementPanel, type ReadinessView } from "@/components/portal/session-enforcement-panel";

/**
 * Development gallery: college lifecycle and session management (migrations
 * 053/054). Fictional data only — the real pages read the database, which
 * browser tests may not touch (owner decision D3).
 */

const RESUME = "2026-10-05T18:30:00Z"; // 6 Oct 2026, 00:00 IST

export const SAMPLE_SESSIONS: DeviceSession[] = [
  { session_id: "5e550000-0000-4000-8000-000000000001", device_label: "Chrome on Windows", client: "web", status: "active", created_at: "2026-09-30T04:00:00Z", last_seen_at: "2026-10-02T10:15:00Z" },
  { session_id: "5e550000-0000-4000-8000-000000000002", device_label: "Pixel 8 · Android 15", client: "mobile", status: "active", created_at: "2026-09-28T09:00:00Z", last_seen_at: "2026-10-01T15:40:00Z" },
];

const HISTORY: LifecycleHistoryEntry[] = [
  { id: "h2", previous_state: "MAINTENANCE", new_state: "ACTIVE", reason: "Results module upgrade finished", message: null, expected_resume_at: null, sessions_revoked: 0, changed_at: "2026-09-21T06:00:00Z" },
  { id: "h1", previous_state: "ACTIVE", new_state: "MAINTENANCE", reason: "Upgrading the results module", message: "Results are being upgraded.", expected_resume_at: "2026-09-21T06:30:00Z", sessions_revoked: 412, changed_at: "2026-09-21T02:00:00Z" },
];

export function UnavailableDemos() {
  const [log, setLog] = useState("No action yet.");
  return (
    <div className="space-y-lg">
      <p data-testid="unavailable-log" className="text-xs text-on-surface-variant">{log}</p>
      <div className="grid gap-md lg:grid-cols-2">
        <UnavailableView
          reason="maintenance"
          collegeName="Springfield Institute"
          message="We are upgrading the results module."
          expectedResumeAt={RESUME}
          onRetry={() => setLog("maintenance: try again")}
          onSignOut={() => setLog("maintenance: sign out")}
        />
        <UnavailableView reason="suspended" collegeName="Springfield Institute" onSignOut={() => setLog("suspended: sign out")} />
        <UnavailableView
          reason="session_limit"
          sessions={SAMPLE_SESSIONS}
          maxSessions={2}
          onRevoke={(id) => setLog(`revoke ${id}`)}
          onRetry={() => setLog("session_limit: try again")}
          onSignOut={() => setLog("session_limit: sign out")}
        />
        <UnavailableView reason="session_revoked" onSignOut={() => setLog("revoked: sign in again")} />
      </div>
    </div>
  );
}

export function LifecycleDemos() {
  const [dialogFor, setDialogFor] = useState<"ACTIVE" | "MAINTENANCE" | null>(null);
  const [submitted, setSubmitted] = useState<LifecycleChange | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <div className="space-y-md">
      <div className="flex flex-wrap items-center gap-sm">
        <LifecycleBadge state="ACTIVE" />
        <LifecycleBadge state="MAINTENANCE" />
        <LifecycleBadge state="SUSPENDED" />
      </div>
      <div className="flex flex-wrap gap-sm">
        <Button onClick={() => setDialogFor("ACTIVE")}>Change status (active college)</Button>
        <Button variant="secondary" onClick={() => setDialogFor("MAINTENANCE")}>Change status (college in maintenance)</Button>
        <Button variant="secondary" onClick={() => setHistoryOpen(true)}>Status history</Button>
      </div>
      <pre data-testid="lifecycle-submitted" className="whitespace-pre-wrap text-xs text-on-surface-variant">
        {submitted ? JSON.stringify(submitted) : "Nothing submitted."}
      </pre>
      <LifecycleDialog
        open={dialogFor !== null}
        onClose={() => setDialogFor(null)}
        college={
          dialogFor
            ? { name: "Springfield Institute", lifecycle_state: dialogFor, lifecycle_message: dialogFor === "MAINTENANCE" ? "Results are being upgraded." : null }
            : null
        }
        onSubmit={(change) => {
          setSubmitted(change);
          setDialogFor(null);
        }}
      />
      <LifecycleHistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} collegeName="Springfield Institute" entries={HISTORY} />
    </div>
  );
}

export function DeviceSessionDemos() {
  const [sessions, setSessions] = useState<DeviceSession[]>(SAMPLE_SESSIONS);
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-md">
      <DeviceList sessions={SAMPLE_SESSIONS.map((s, i) => ({ ...s, is_current: i === 0 }))} />
      <Button onClick={() => setOpen(true)}>Open sessions dialog</Button>
      <SessionsDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Sessions — Asha Rao"
        description="Where this user is signed in."
        load={async () => sessions}
        revoke={async (id) => setSessions((list) => list.filter((s) => s.session_id !== id))}
        emptyText="This user is not signed in anywhere."
      />
    </div>
  );
}

const NOT_READY: ReadinessView = {
  mode: "register", active_sessions: 1204, active_web: 880, active_mobile: 300, active_mobile_legacy: 24,
  mobile_registered_total: 300, legacy_seen_last_7_days: 24, legacy_last_seen_at: "2026-10-01T15:40:00Z", ready: false,
};
const READY: ReadinessView = { ...NOT_READY, active_mobile_legacy: 0, legacy_seen_last_7_days: 0, ready: true };

export function EnforcementDemos() {
  const [switched, setSwitched] = useState("Not switched.");
  return (
    <div className="grid gap-md lg:grid-cols-2">
      <div data-testid="enforcement-not-ready">
        <SessionEnforcementPanel readiness={NOT_READY} onSwitch={() => setSwitched("switched (not ready)")} />
      </div>
      <div data-testid="enforcement-ready">
        <SessionEnforcementPanel readiness={READY} onSwitch={(mode, reason) => setSwitched(`${mode}: ${reason}`)} />
      </div>
      <p data-testid="enforcement-log" className="text-xs text-on-surface-variant">{switched}</p>
    </div>
  );
}
