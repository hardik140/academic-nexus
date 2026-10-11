"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button, FormField } from "@/components/ui/modal";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { formatDate } from "@/lib/format";
import type { FeedbackError } from "@/lib/action-failure";

/**
 * The session-registry cut-over, for super_admin (migration 054).
 * Presentational: the dashboard wires loading and the switch.
 *
 * Switching to 'enforce' is offered only when the readiness evidence says
 * so — no session from a mobile build that predates registration seen for
 * seven days, and at least one session registered by the updated app.
 * Switching back to 'register' is always possible. Either way a reason is
 * written first (it is audited with the change), then confirmed.
 */

export interface ReadinessView {
  mode: "register" | "enforce";
  active_sessions: number;
  active_web: number;
  active_mobile: number;
  active_mobile_legacy: number;
  mobile_registered_total: number;
  legacy_seen_last_7_days: number;
  legacy_last_seen_at: string | null;
  ready: boolean;
}

export function SessionEnforcementPanel({
  readiness,
  onSwitch,
  pending,
  error,
}: {
  readiness: ReadinessView;
  onSwitch: (mode: "register" | "enforce", reason: string) => void;
  pending?: boolean;
  error?: FeedbackError | string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const target = readiness.mode === "register" ? "enforce" : "register";
  const allowed = target === "register" || readiness.ready;
  const reasonValid = reason.trim().length >= 10 && reason.length <= 1000;
  const fieldId = `enforcement-reason-${readiness.ready ? "ready" : "waiting"}-${readiness.mode}`;

  return (
    <section
      aria-labelledby={`${fieldId}-heading`}
      className="space-y-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-sm"
      data-testid="session-enforcement"
    >
      <div>
        <h2 id={`${fieldId}-heading`} className="text-sm font-bold text-on-surface">Session enforcement</h2>
        <p className="mt-xs text-sm text-on-surface-variant">
          Current mode: <strong className="text-on-surface">{readiness.mode === "register" ? "Register" : "Enforce"}</strong>.{" "}
          {readiness.mode === "register"
            ? "Sessions are registered and device limits apply; a session the server has never seen is still allowed, so older mobile app versions keep working."
            : "Every session must be registered. A session the server has never seen is refused."}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-sm text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-on-surface-variant">Active sessions</dt><dd className="font-semibold text-on-surface">{readiness.active_sessions}</dd></div>
        <div><dt className="text-xs text-on-surface-variant">Web</dt><dd className="font-semibold text-on-surface">{readiness.active_web}</dd></div>
        <div><dt className="text-xs text-on-surface-variant">Mobile app</dt><dd className="font-semibold text-on-surface">{readiness.active_mobile}</dd></div>
        <div><dt className="text-xs text-on-surface-variant">Older mobile app</dt><dd className="font-semibold text-on-surface">{readiness.active_mobile_legacy}</dd></div>
      </dl>

      <Alert tone="success" title={readiness.mode === "register" && readiness.ready ? "Ready to enforce" : undefined}>
        {readiness.mode === "register" && readiness.ready &&
          `No older mobile app version has been seen for 7 days, and ${readiness.mobile_registered_total} session(s) were registered by the updated app.`}
      </Alert>
      <Alert tone="info" title={readiness.mode === "register" && !readiness.ready ? "Not ready to enforce yet" : undefined}>
        {readiness.mode === "register" && !readiness.ready &&
          (readiness.mobile_registered_total === 0
            ? "The updated mobile app has not registered any session yet."
            : `${readiness.legacy_seen_last_7_days} session(s) from an older mobile app version were seen in the last 7 days${readiness.legacy_last_seen_at ? ` (last ${formatDate(readiness.legacy_last_seen_at, "datetime")})` : ""}. Enforcing now would sign those users out.`)}
      </Alert>

      {allowed && (
        <FormField
          label="Reason for the change (recorded in the audit log)"
          id={fieldId}
          type="textarea"
          value={reason}
          onChange={setReason}
          required
          error={reason && !reasonValid ? "Give a reason of 10 to 1000 characters." : undefined}
        />
      )}

      <Button
        variant={target === "enforce" ? "primary" : "secondary"}
        onClick={() => setConfirming(true)}
        disabled={!allowed || !reasonValid || pending}
      >
        {target === "enforce" ? "Switch to enforce" : "Switch back to register"}
      </Button>

      <ConfirmationDialog
        open={confirming}
        title={target === "enforce" ? "Enforce session registration?" : "Return to register mode?"}
        description={
          target === "enforce"
            ? "Any session the server has never registered will be refused. Make sure the updated mobile app is in use."
            : "Sessions the server has never seen will be allowed again. Revoked sessions stay revoked."
        }
        confirmLabel={target === "enforce" ? "Enforce" : "Return to register"}
        pendingLabel="Saving…"
        tone="default"
        pending={!!pending}
        error={error ?? null}
        onConfirm={() => onSwitch(target, reason.trim())}
        onCancel={() => setConfirming(false)}
      >
        <p className="text-sm text-on-surface-variant">Reason: {reason.trim()}</p>
      </ConfirmationDialog>
    </section>
  );
}
