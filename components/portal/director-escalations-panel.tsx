"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, FormField, Modal, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { ErrorState } from "@/components/ui/error-state";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { classifyError } from "@/lib/feedback-error";
import { actOnRiskFlag, listMyRiskFlagAssignments } from "@/app/(portal)/director/attention/actions";

/**
 * Shared by HOD, Warden, and Placement Cell dashboards — shows risk_flags
 * assigned to the current user (escalation_act RLS/permission restricts
 * this to the actual assignee) with Acknowledge/Start/Resolve actions.
 * Teacher deliberately does NOT get this panel (no faculty-scoped risk
 * flags are generated yet — Teacher gets a plain notification instead,
 * see teacher/dashboard/page.tsx).
 */
export function DirectorEscalationsPanel() {
  const [loading, setLoading] = useState<string | null>(null);
  const [resolveTarget, setResolveTarget] = useState<string | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Escalations assigned to this user. The panel stays out of the way while
  // it loads and when there are none — but a failed load is shown, never
  // mistaken for "none" (owner decision D5).
  const flagsResource = useAsyncResource(() => listMyRiskFlagAssignments(), []);
  const flags: any[] = flagsResource.data ?? [];
  const loadFailed = flagsResource.status === "error";

  const act = async (flagId: string, action: "acknowledge" | "start" | "resolve") => {
    if (loading) return;
    setLoading(flagId);
    setError(null);
    setNotice(null);
    try {
      await actOnRiskFlag({ flagId, action, resolutionNotes: action === "resolve" ? resolutionNotes.trim() || undefined : undefined });
      setNotice(action === "resolve" ? "Escalation marked resolved." : action === "start" ? "Work on the escalation started." : "Escalation acknowledged.");
      setResolveTarget(null);
      setResolutionNotes("");
      flagsResource.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to update."));
    } finally {
      setLoading(null);
    }
  };

  if (flags.length === 0 && !loadFailed && !error && !notice) return null;

  return (
    <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
      <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
        <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🚨 Director Escalations ({flags.length})</h2>
      </div>
      <Alert tone="success" className="mx-lg mt-md" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      {/* The resolve dialog shows its own failure. */}
      <ErrorAlert error={!resolveTarget ? error : null} className="mx-lg mt-md" />
      {loadFailed && flags.length === 0 && (
        <ErrorState {...classifyError(flagsResource.error)} title="Your escalations couldn't be loaded" onRetry={flagsResource.reload} />
      )}
      <Alert
        tone="error"
        className="mx-lg mt-md"
        action={<Button variant="outline" size="sm" onClick={flagsResource.reload}>Try again</Button>}
      >
        {loadFailed && flags.length > 0 ? (
          <>
            This couldn&apos;t be refreshed. Showing what was loaded earlier.
          </>
        ) : null}
      </Alert>
      <div className="divide-y divide-outline-variant">
        {flags.map((f: any) => (
          <div key={f.id} className="px-lg py-md">
            <div className="flex items-start justify-between gap-md">
              <Link href={`/director/attention/${f.id}`} className="flex-1 min-w-0">
                <div className="flex items-center gap-sm mb-xs flex-wrap">
                  <StatusBadge status={f.severity} />
                  <StatusBadge status={f.status} />
                </div>
                <div className="text-sm font-semibold text-on-surface">{f.title}</div>
                <div className="text-xs text-outline mt-xs">{f.description}</div>
              </Link>
              <div className="flex gap-xs shrink-0">
                {f.status === "assigned" && (
                  <Button size="sm" variant="outline" onClick={() => act(f.id, "acknowledge")} disabled={loading === f.id} aria-busy={loading === f.id || undefined}>
                    Acknowledge
                  </Button>
                )}
                {f.status === "acknowledged" && (
                  <Button size="sm" variant="outline" onClick={() => act(f.id, "start")} disabled={loading === f.id} aria-busy={loading === f.id || undefined}>
                    Start
                  </Button>
                )}
                {(f.status === "acknowledged" || f.status === "in_progress") && (
                  <Button size="sm" onClick={() => setResolveTarget(f.id)} disabled={loading === f.id}>
                    Resolve
                  </Button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <Modal
        open={!!resolveTarget}
        onClose={() => setResolveTarget(null)}
        title="Resolve Escalation"
        footer={
          <>
            <Button variant="outline" onClick={() => setResolveTarget(null)}>
              Cancel
            </Button>
            <Button onClick={() => resolveTarget && act(resolveTarget, "resolve")} disabled={loading === resolveTarget} aria-busy={loading === resolveTarget || undefined}>
              {loading === resolveTarget ? "Saving…" : "Mark Resolved"}
            </Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <FormField
          label="Resolution notes"
          id="resolution-notes"
          type="textarea"
          rows={3}
          value={resolutionNotes}
          onChange={setResolutionNotes}
          placeholder="What was done to resolve this?"
        />
      </Modal>
    </div>
  );
}
