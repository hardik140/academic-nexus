"use client";

import { useState } from "react";
import { Button, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { listRoomTransferRequests, listAvailableRoomsForTransfer, approveRoomTransfer, rejectRoomTransfer } from "./actions";

export default function WardenTransfers() {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);
  const [rejectNotes, setRejectNotes] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Requests and the rooms free to move into. A failed load is an error,
  // never "No pending room transfer requests" (owner decision D5).
  const transfers = useAsyncResource(async () => {
    const [requests, rooms] = await Promise.all([listRoomTransferRequests(), listAvailableRoomsForTransfer()]);
    return { ...requests, rooms };
  }, []);
  const pending: any[] = transfers.data?.pending ?? [];
  const processed: any[] = transfers.data?.processed ?? [];
  const availableRooms: any[] = transfers.data?.rooms ?? [];

  const handleApprove = async (id: string) => {
    const newRoomId = picked[id];
    if (!newRoomId || loading) return;
    setLoading(id);
    setError(null);
    setNotice(null);
    try {
      await approveRoomTransfer(id, newRoomId);
      setNotice("Room transfer approved.");
      transfers.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to approve transfer."));
    } finally {
      setLoading(null);
    }
  };

  const handleReject = async () => {
    if (!rejectTarget || !rejectNotes.trim() || loading) return;
    setLoading(rejectTarget);
    setError(null);
    setNotice(null);
    try {
      await rejectRoomTransfer(rejectTarget, rejectNotes);
      setRejectTarget(null);
      setRejectNotes("");
      setNotice("Room transfer rejected. The student will see your reason.");
      transfers.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to reject transfer."));
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Room Transfers</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Student-requested room transfers for your hostel block(s)</p>
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      <ErrorAlert error={error} />

      <StateView state={transfers} isEmpty={() => false} loadingLabel="Loading room transfers…" empty={{ title: "No room transfers" }}>
        {() => (
          <>
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🔄 Pending Requests ({pending.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {pending.length > 0 ? pending.map((req: any) => (
            <div key={req.id} className="px-lg py-md hover:bg-surface-container-low transition-colors">
              <div className="flex items-start justify-between gap-md flex-wrap">
                <div>
                  <div className="text-sm font-semibold text-on-surface">
                    {(req.students as any)?.profiles?.full_name} — {(req.students as any)?.enrollment_number}
                  </div>
                  <div className="text-xs text-outline mt-xs">
                    Current: {(req.current_room as any)?.hostel_rooms?.block_name} {(req.current_room as any)?.hostel_rooms?.room_number}
                  </div>
                  <div className="text-sm text-on-surface-variant italic mt-xs">&ldquo;{req.reason}&rdquo;</div>
                </div>
                <div className="flex gap-xs items-center shrink-0">
                  <select
                    value={picked[req.id] || ""}
                    onChange={(e) => setPicked({ ...picked, [req.id]: e.target.value })}
                    className="bg-surface-container-low border border-outline-variant rounded-xl px-md py-xs text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none"
                  >
                    <option value="">Select new room...</option>
                    {availableRooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.block_name} {r.room_number} ({r.occupancy}/{r.capacity})
                      </option>
                    ))}
                  </select>
                  <Button size="sm" variant="destructive" onClick={() => setRejectTarget(req.id)} disabled={loading === req.id}>
                    Reject
                  </Button>
                  <Button size="sm" onClick={() => handleApprove(req.id)} disabled={!picked[req.id] || loading === req.id} aria-busy={loading === req.id || undefined}>
                    {loading === req.id ? "..." : "Approve"}
                  </Button>
                </div>
              </div>
              {rejectTarget === req.id && (
                <div className="mt-md flex gap-sm items-start">
                  <input
                    type="text"
                    value={rejectNotes}
                    onChange={(e) => setRejectNotes(e.target.value)}
                    placeholder="Reason for rejection (shown to the student)"
                    className="flex-1 bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none"
                  />
                  <Button size="sm" variant="destructive" onClick={handleReject} disabled={!rejectNotes.trim() || loading === req.id} aria-busy={loading === req.id || undefined}>
                    Confirm Reject
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setRejectTarget(null); setRejectNotes(""); }}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          )) : (
            <div className="p-xl text-center text-sm text-outline">🎉 No pending room transfer requests.</div>
          )}
        </div>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🗂️ Processed ({processed.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {processed.map((req: any) => (
            <div key={req.id} className="flex items-center justify-between px-lg py-md">
              <div>
                <div className="text-sm text-on-surface">{(req.students as any)?.profiles?.full_name}</div>
                <div className="text-xs text-outline mt-xs">
                  {req.status === "approved" ? "Transferred" : "Rejected"} · {new Date(req.reviewed_at).toLocaleDateString()}
                  {req.review_notes ? ` — ${req.review_notes}` : ""}
                </div>
              </div>
              <StatusBadge status={req.status} />
            </div>
          ))}
          {processed.length === 0 && (
            <div className="p-xl text-center text-sm text-outline">No processed requests yet.</div>
          )}
        </div>
      </div>
          </>
        )}
      </StateView>
    </div>
  );
}
