"use client";

import { useState } from "react";
import { Button, FormField, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { requestRoomTransfer, listMyRoomTransferRequests } from "./actions";

export function RoomTransferPanel() {
  const [showForm, setShowForm] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // A failed load is an error, never "No transfer requests yet." (D5).
  const requestsResource = useAsyncResource(() => listMyRoomTransferRequests(), []);
  const requests: any[] = requestsResource.data ?? [];
  // Only known once the requests have loaded: until then a new request could
  // duplicate one already pending.
  const loaded = requestsResource.data !== undefined;
  const hasPending = requests.some((r) => r.status === "pending");

  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      await requestRoomTransfer(reason);
      setReason("");
      setShowForm(false);
      setSuccess("Room transfer requested. Your warden will review it.");
      requestsResource.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to submit transfer request."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
      <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
        <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🔄 Room Transfer</h2>
        {loaded && !hasPending && (
          <Button size="sm" variant="outline" onClick={() => setShowForm(!showForm)}>
            {showForm ? "Cancel" : "Request Transfer"}
          </Button>
        )}
      </div>

      <Alert tone="success" focusOnShow className="mx-lg mt-md" onDismiss={() => setSuccess(null)}>
        {success}
      </Alert>
      <ErrorAlert error={error} className="mx-lg mt-md" />

      {showForm && loaded && !hasPending && (
        <div className="p-lg space-y-md">
          <FormField
            label="Reason for transfer"
            id="transfer-reason"
            type="textarea"
            value={reason}
            onChange={setReason}
            placeholder="Explain why you'd like to be moved to a different room"
            required
            rows={3}
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={handleSubmit} disabled={submitting || !reason.trim()} aria-busy={submitting || undefined}>
              {submitting ? "Submitting..." : "Submit Request"}
            </Button>
          </div>
        </div>
      )}

      <StateView state={requestsResource} isEmpty={() => false} loadingLabel="Loading your transfer requests…" empty={{ title: "No transfer requests yet" }}>
        {() => (
      <div className="divide-y divide-outline-variant">
        {requests.length > 0 ? requests.map((r: any) => (
          <div key={r.id} className="flex items-center justify-between px-lg py-md">
            <div>
              <div className="text-sm text-on-surface">{r.reason}</div>
              <div className="text-xs text-outline mt-xs">
                {new Date(r.created_at).toLocaleDateString()}
                {r.review_notes ? ` — ${r.review_notes}` : ""}
              </div>
            </div>
            <StatusBadge status={r.status} />
          </div>
        )) : (
          <div className="p-lg text-center text-xs text-outline">No transfer requests yet.</div>
        )}
      </div>
        )}
      </StateView>
    </div>
  );
}
