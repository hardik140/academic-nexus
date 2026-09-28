"use client";

import { useState, useEffect } from "react";
import { Button, StatusBadge } from "@/components/ui/modal";
import { formatCurrency } from "@/lib/utils";
import { listRefundRequests, approveRefund, rejectRefund } from "./actions";

export default function FinanceRefunds() {
  const [pending, setPending] = useState<any[]>([]);
  const [processed, setProcessed] = useState<any[]>([]);
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);
  const [rejectNotes, setRejectNotes] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    const { pending, processed } = await listRefundRequests();
    setPending(pending);
    setProcessed(processed);
  };

  const handleApprove = async (id: string) => {
    setLoading(id);
    setError(null);
    try {
      await approveRefund(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to approve refund.");
    } finally {
      setLoading(null);
    }
  };

  const handleReject = async () => {
    if (!rejectTarget || !rejectNotes.trim()) return;
    setLoading(rejectTarget);
    setError(null);
    try {
      await rejectRefund(rejectTarget, rejectNotes);
      setRejectTarget(null);
      setRejectNotes("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reject refund.");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Refund Center</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Student-requested refunds against cleared payments</p>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">💸 Pending Requests ({pending.length})</h2>
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
                    Original payment: {formatCurrency((req.payments as any)?.amount || 0)} via {(req.payments as any)?.method} on{" "}
                    {(req.payments as any)?.created_at ? new Date((req.payments as any).created_at).toLocaleDateString() : "—"}
                  </div>
                  <div className="text-sm font-bold text-on-surface mt-xs">Requesting {formatCurrency(req.amount)}</div>
                  <div className="text-sm text-on-surface-variant italic mt-xs">&ldquo;{req.reason}&rdquo;</div>
                </div>
                <div className="flex gap-xs items-center shrink-0">
                  <Button size="sm" variant="destructive" onClick={() => setRejectTarget(req.id)} disabled={loading === req.id}>
                    Reject
                  </Button>
                  <Button size="sm" onClick={() => handleApprove(req.id)} disabled={loading === req.id}>
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
                  <Button size="sm" variant="destructive" onClick={handleReject} disabled={!rejectNotes.trim() || loading === req.id}>
                    Confirm Reject
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setRejectTarget(null); setRejectNotes(""); }}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          )) : (
            <div className="p-xl text-center text-sm text-outline">🎉 No pending refund requests.</div>
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
                <div className="text-sm text-on-surface">
                  {(req.students as any)?.profiles?.full_name} — {formatCurrency(req.amount)}
                </div>
                <div className="text-xs text-outline mt-xs">
                  {new Date(req.reviewed_at).toLocaleDateString()}
                  {req.review_notes ? ` — ${req.review_notes}` : ""}
                </div>
              </div>
              <StatusBadge status={req.status} />
            </div>
          ))}
          {processed.length === 0 && (
            <div className="p-xl text-center text-sm text-outline">No processed refunds yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
