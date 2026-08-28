"use client";

import { useState, useEffect } from "react";
import { Button, StatusBadge } from "@/components/ui/modal";
import { listFinancialDisputes, claimDispute, resolveDispute, rejectDispute } from "./actions";

export default function FinanceDisputes() {
  const [disputes, setDisputes] = useState<any[]>([]);
  const [resolveTarget, setResolveTarget] = useState<{ id: string; action: "resolved" | "rejected" } | null>(null);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setDisputes(await listFinancialDisputes());
  };

  const handleClaim = async (id: string) => {
    setLoading(id);
    setError(null);
    try {
      await claimDispute(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to claim dispute.");
    } finally {
      setLoading(null);
    }
  };

  const handleFinalize = async () => {
    if (!resolveTarget || !notes.trim()) return;
    setLoading(resolveTarget.id);
    setError(null);
    try {
      if (resolveTarget.action === "resolved") await resolveDispute(resolveTarget.id, notes);
      else await rejectDispute(resolveTarget.id, notes);
      setResolveTarget(null);
      setNotes("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to finalize dispute.");
    } finally {
      setLoading(null);
    }
  };

  const open = disputes.filter((d) => d.status === "submitted" || d.status === "under_investigation");
  const closed = disputes.filter((d) => d.status === "resolved" || d.status === "rejected");

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Financial Dispute Center</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Student-reported payment/fee discrepancies</p>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">⚖️ Open Disputes ({open.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {open.length > 0 ? open.map((d: any) => {
            const activeTarget = resolveTarget && resolveTarget.id === d.id ? resolveTarget : null;
            return (
            <div key={d.id} className="px-lg py-md hover:bg-surface-container-low transition-colors">
              <div className="flex items-start justify-between gap-md flex-wrap">
                <div>
                  <div className="text-sm font-semibold text-on-surface flex items-center gap-sm">
                    {(d.students as any)?.profiles?.full_name} — {(d.students as any)?.enrollment_number}
                    <StatusBadge status={d.status} />
                  </div>
                  {d.fees && (
                    <div className="text-xs text-outline mt-xs">Re: {(d.fees as any).type} fee</div>
                  )}
                  {d.payments && (
                    <div className="text-xs text-outline mt-xs">
                      Re: payment of {(d.payments as any).amount} via {(d.payments as any).method}
                    </div>
                  )}
                  <div className="text-sm text-on-surface-variant italic mt-xs">&ldquo;{d.description}&rdquo;</div>
                </div>
                <div className="flex gap-xs items-center shrink-0">
                  {d.status === "submitted" && (
                    <Button size="sm" variant="outline" onClick={() => handleClaim(d.id)} disabled={loading === d.id}>
                      {loading === d.id ? "..." : "Claim"}
                    </Button>
                  )}
                  {d.status === "under_investigation" && (
                    <>
                      <Button size="sm" variant="destructive" onClick={() => setResolveTarget({ id: d.id, action: "rejected" })} disabled={loading === d.id}>
                        Reject
                      </Button>
                      <Button size="sm" onClick={() => setResolveTarget({ id: d.id, action: "resolved" })} disabled={loading === d.id}>
                        Resolve
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {activeTarget && (
                <div className="mt-md flex gap-sm items-start">
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder={activeTarget.action === "resolved" ? "Resolution notes (shown to the student)" : "Reason for rejection (shown to the student)"}
                    className="flex-1 bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm text-sm text-on-surface focus:ring-2 focus:ring-secondary outline-none"
                  />
                  <Button
                    size="sm"
                    variant={activeTarget.action === "resolved" ? "primary" : "destructive"}
                    onClick={handleFinalize}
                    disabled={!notes.trim() || loading === d.id}
                  >
                    Confirm {activeTarget.action === "resolved" ? "Resolve" : "Reject"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setResolveTarget(null); setNotes(""); }}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          );}) : (
            <div className="p-xl text-center text-sm text-outline">🎉 No open disputes.</div>
          )}
        </div>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🗂️ Closed ({closed.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {closed.map((d: any) => (
            <div key={d.id} className="flex items-center justify-between px-lg py-md">
              <div>
                <div className="text-sm text-on-surface">{(d.students as any)?.profiles?.full_name}</div>
                <div className="text-xs text-outline mt-xs">
                  {new Date(d.resolved_at).toLocaleDateString()}
                  {d.resolution_notes ? ` — ${d.resolution_notes}` : ""}
                </div>
              </div>
              <StatusBadge status={d.status} />
            </div>
          ))}
          {closed.length === 0 && (
            <div className="p-xl text-center text-sm text-outline">No closed disputes yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
