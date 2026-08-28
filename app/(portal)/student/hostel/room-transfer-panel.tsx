"use client";

import { useState, useEffect } from "react";
import { Button, FormField, StatusBadge } from "@/components/ui/modal";
import { requestRoomTransfer, listMyRoomTransferRequests } from "./actions";

export function RoomTransferPanel() {
  const [requests, setRequests] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setRequests(await listMyRoomTransferRequests());
  };

  useEffect(() => { load(); }, []);

  const hasPending = requests.some((r) => r.status === "pending");

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await requestRoomTransfer(reason);
      setReason("");
      setShowForm(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit transfer request.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
      <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
        <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🔄 Room Transfer</h2>
        {!hasPending && (
          <Button size="sm" variant="outline" onClick={() => setShowForm(!showForm)}>
            {showForm ? "Cancel" : "Request Transfer"}
          </Button>
        )}
      </div>

      {error && (
        <div className="mx-lg mt-md bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      {showForm && !hasPending && (
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
            <Button size="sm" onClick={handleSubmit} disabled={submitting || !reason.trim()}>
              {submitting ? "Submitting..." : "Submit Request"}
            </Button>
          </div>
        </div>
      )}

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
    </div>
  );
}
