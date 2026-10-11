"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/modal";
import { DeviceList, type DeviceSession } from "@/components/portal/device-list";
import { formatDate } from "@/lib/format";

/**
 * Why the app cannot be used right now — the page middleware sends a
 * refused session to (migrations 053/054). One heading per reason, never a
 * generic "authentication failed":
 *
 *   maintenance     the college is in MAINTENANCE: the published message and
 *                   the expected resume time, when the Super Admin gave them
 *   suspended       the college is SUSPENDED
 *   session_limit   the account is at its device limit: the user's other
 *                   sessions, any of which they can sign out from here
 *   session_revoked this session was signed out or revoked
 *   inactive        the account itself is not active
 *   error           the check could not run (fail closed)
 *
 * Presentational: the page wires the actions.
 */

export type UnavailableReason = "maintenance" | "suspended" | "session_limit" | "session_revoked" | "inactive" | "error";

export interface UnavailableViewProps {
  reason: UnavailableReason;
  collegeName?: string | null;
  message?: string | null;
  expectedResumeAt?: string | null;
  sessions?: DeviceSession[];
  maxSessions?: number | null;
  pendingId?: string | null;
  error?: string | null;
  onRevoke?: (sessionId: string) => void;
  onRetry?: () => void;
  onSignOut?: () => void;
  signingOut?: boolean;
}

const HEADINGS: Record<UnavailableReason, string> = {
  maintenance: "Under maintenance",
  suspended: "Access suspended",
  session_limit: "Too many active devices",
  session_revoked: "You have been signed out",
  inactive: "Account not active",
  error: "We couldn't verify your access",
};

export function UnavailableView({
  reason,
  collegeName,
  message,
  expectedResumeAt,
  sessions = [],
  maxSessions,
  pendingId,
  error,
  onRevoke,
  onRetry,
  onSignOut,
  signingOut,
}: UnavailableViewProps) {
  const college = collegeName || "Your college";

  return (
    <section
      aria-labelledby="unavailable-heading"
      className="w-full max-w-[32rem] space-y-md rounded-panel border border-outline-variant bg-surface-container-lowest p-lg shadow-sm"
      data-testid={`unavailable-${reason}`}
    >
      <h1 id="unavailable-heading" className="text-xl font-extrabold text-on-surface">
        {HEADINGS[reason]}
      </h1>

      {reason === "maintenance" && (
        <>
          <p className="text-sm text-on-surface">
            {college} is temporarily unavailable while maintenance is carried out. Your data is safe and
            nothing has been changed.
          </p>
          <Alert tone="info" title={message ? "Message from the administrator" : undefined}>
            {message}
          </Alert>
          <p className="text-sm text-on-surface-variant">
            {expectedResumeAt
              ? <>Expected to be back by <strong className="text-on-surface">{formatDate(expectedResumeAt, "datetime")}</strong> (IST).</>
              : "Please check back later."}
          </p>
        </>
      )}

      {reason === "suspended" && (
        <>
          <p className="text-sm text-on-surface">
            Access to {college} is currently suspended. Your data has not been deleted. Please contact your
            college administration for details.
          </p>
          <Alert tone="warning" title={message ? "Notice" : undefined}>{message}</Alert>
        </>
      )}

      {reason === "session_limit" && (
        <>
          <p className="text-sm text-on-surface">
            Your account is already signed in on {maxSessions === 1 ? "the one device" : `${maxSessions ?? "the maximum number of"} devices`} it
            is allowed. To use this device, sign out of one of them first — your other sessions stay signed in
            until you do.
          </p>
          <DeviceList
            sessions={sessions}
            onRevoke={onRevoke}
            pendingId={pendingId}
            revokeLabel="Sign out that device"
            emptyText="No other active sessions were found. Try again."
          />
        </>
      )}

      {reason === "session_revoked" && (
        <p className="text-sm text-on-surface">
          This session was signed out — from another device, by an administrator, or because your college&apos;s
          status changed. Sign in again to continue.
        </p>
      )}

      {reason === "inactive" && (
        <p className="text-sm text-on-surface">
          Your account is not active. Please contact your college administration.
        </p>
      )}

      {reason === "error" && (
        <p className="text-sm text-on-surface">
          Your access could not be checked just now. Nothing has changed; please try again in a moment.
        </p>
      )}

      <Alert tone="error">{error}</Alert>

      <div className="flex flex-wrap gap-sm pt-sm">
        {(reason === "session_limit" || reason === "error" || reason === "maintenance") && onRetry && (
          <Button onClick={onRetry}>Try again</Button>
        )}
        {onSignOut && (
          <Button
            variant={reason === "session_revoked" ? "primary" : "secondary"}
            onClick={onSignOut}
            disabled={signingOut}
            aria-busy={signingOut || undefined}
          >
            {signingOut ? "Signing out…" : reason === "session_revoked" ? "Sign in again" : "Sign out"}
          </Button>
        )}
      </div>
    </section>
  );
}
