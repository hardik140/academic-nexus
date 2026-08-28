"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, StatusBadge } from "@/components/ui/modal";
import { decideOnDecision, listDecisions } from "./actions";

export default function DirectorDecisions() {
  const [pending, setPending] = useState<any[]>([]);
  const [processed, setProcessed] = useState<any[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  const load = async () => {
    const { pending, processed } = await listDecisions();
    setPending(pending);
    setProcessed(processed);
  };

  const handleQuickDecide = async (id: string, action: "approved" | "rejected") => {
    setLoading(id);
    setError(null);
    try {
      await decideOnDecision({ decisionId: id, action });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update decision.");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Decision Inbox</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Requests escalated to you from HOD, Warden, and Placement Cell</p>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🔔 Pending Decisions ({pending.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {pending.length > 0 ? (
            pending.map((d: any) => (
              <div key={d.id} className="px-lg py-md hover:bg-surface-container-low transition-colors">
                <div className="flex items-start justify-between gap-md">
                  <Link href={`/director/decisions/${d.id}`} className="flex-1 min-w-0">
                    <div className="flex items-center gap-sm mb-xs flex-wrap">
                      <StatusBadge status={d.urgency} />
                      <span className="text-xs text-outline capitalize">{d.category.replace(/_/g, " ")}</span>
                      {d.department && <span className="text-xs text-outline">· {d.department.name}</span>}
                    </div>
                    <div className="text-sm font-semibold text-on-surface">{d.title}</div>
                    <div className="text-xs text-outline mt-xs">
                      {d.requester?.full_name} ({d.requester?.role}) · {new Date(d.created_at).toLocaleDateString()}
                      {d.deadline && <> · deadline {new Date(d.deadline).toLocaleDateString()}</>}
                    </div>
                    {(d.financial_impact != null || d.student_impact_count != null) && (
                      <div className="text-xs text-on-surface-variant mt-xs flex gap-md">
                        {d.financial_impact != null && <span>₹{Number(d.financial_impact).toLocaleString()}</span>}
                        {d.student_impact_count != null && <span>{d.student_impact_count} students affected</span>}
                      </div>
                    )}
                  </Link>
                  <div className="flex gap-xs shrink-0">
                    <Button size="sm" variant="destructive" onClick={() => handleQuickDecide(d.id, "rejected")} disabled={loading === d.id}>
                      Reject
                    </Button>
                    <Button size="sm" onClick={() => handleQuickDecide(d.id, "approved")} disabled={loading === d.id}>
                      {loading === d.id ? "..." : "Approve"}
                    </Button>
                    <Link href={`/director/decisions/${d.id}`}>
                      <Button size="sm" variant="outline">
                        Review
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="p-xl text-center text-sm text-outline">No decisions awaiting approval.</div>
          )}
        </div>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🗂️ Decision History ({processed.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {processed.map((d: any) => (
            <Link
              key={d.id}
              href={`/director/decisions/${d.id}`}
              className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors"
            >
              <div>
                <div className="text-sm text-on-surface">{d.title}</div>
                <div className="text-xs text-outline">
                  {d.requester?.full_name} · {new Date(d.updated_at).toLocaleDateString()}
                </div>
              </div>
              <StatusBadge status={d.status} />
            </Link>
          ))}
          {processed.length === 0 && <div className="p-xl text-center text-sm text-outline">No decisions processed yet.</div>}
        </div>
      </div>
    </div>
  );
}
