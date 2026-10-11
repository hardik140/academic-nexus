"use client";

import { useState } from "react";
import { Modal, Button } from "@/components/ui/modal";
import { ErrorAlert } from "@/components/ui/error-alert";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { DeviceList, type DeviceSession } from "@/components/portal/device-list";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { classifyError } from "@/lib/feedback-error";

/**
 * A dialog listing application sessions, with "Sign out" on each (migration
 * 054). One component for every place sessions are managed: a user's own
 * devices, a College Admin looking at one of its users, a Super Admin
 * looking at a college's Admin accounts. Who may see and revoke what is
 * decided by the database; the caller passes the load and revoke actions.
 *
 * The list is mounted only while the dialog is open, so every opening is a
 * fresh load and a closed dialog never holds a result (useAsyncResource: a
 * failed load is an error, never an empty list — D5). Feedback stays inside
 * the dialog (M6): a revocation's success is the row leaving the list, a
 * failure an alert.
 */
interface SessionsDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  load: () => Promise<DeviceSession[]>;
  revoke: (sessionId: string) => Promise<void>;
  revokeLabel?: string;
  emptyText?: string;
}

export function SessionsDialog({ open, onClose, title, description, ...body }: SessionsDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="lg"
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      {open ? <SessionsBody {...body} /> : null}
    </Modal>
  );
}

function SessionsBody({
  load,
  revoke,
  revokeLabel = "Sign out",
  emptyText,
}: Pick<SessionsDialogProps, "load" | "revoke" | "revokeLabel" | "emptyText">) {
  const sessions = useAsyncResource<DeviceSession[]>(() => load(), []);
  const [revokeError, setRevokeError] = useState<FeedbackError | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const onRevoke = async (sessionId: string) => {
    if (pendingId) return;
    setPendingId(sessionId);
    setRevokeError(null);
    try {
      await revoke(sessionId);
      sessions.reload();
    } catch (e) {
      setRevokeError(await toFeedbackError(e, "That session couldn't be signed out."));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="space-y-md">
      <ErrorAlert error={revokeError} />
      {sessions.status === "error" ? (
        <ErrorState {...classifyError(sessions.error)} title="Sessions couldn't be loaded" onRetry={sessions.reload} />
      ) : sessions.status === "success" ? (
        <DeviceList
          sessions={sessions.data}
          onRevoke={onRevoke}
          pendingId={pendingId}
          revokeLabel={revokeLabel}
          emptyText={emptyText}
        />
      ) : (
        <LoadingState label="Loading sessions…" />
      )}
    </div>
  );
}
