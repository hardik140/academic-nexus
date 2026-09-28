"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { decideOnDecision, listDecisions } from "./actions";

export default function DirectorDecisions() {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The Decision Inbox. A failed load is an error, never "No decisions
  // awaiting approval" — the inbox would look cleared (owner decision D5).
  const decisions = useAsyncResource(() => listDecisions(), []);
  const pending: any[] = decisions.data?.pending ?? [];
  const processed: any[] = decisions.data?.processed ?? [];

  const handleQuickDecide = async (id: string, action: "approved" | "rejected") => {
    if (loading) return;
    setLoading(id);
    setError(null);
    setNotice(null);
    try {
      await decideOnDecision({ decisionId: id, action });
      setNotice(`Decision ${action}.`);
      decisions.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to update decision."));
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Decision Inbox</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Requests escalated to you from HOD, Warden, and Placement Cell</p>
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      <ErrorAlert error={error} />

      <StateView state={decisions} isEmpty={() => false} loadingLabel="Loading the Decision Inbox…" empty={{ title: "No decisions" }}>
        {() => (
          <>
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
                    <Button size="sm" onClick={() => handleQuickDecide(d.id, "approved")} disabled={loading === d.id} aria-busy={loading === d.id || undefined}>
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
          </>
        )}
      </StateView>
    </div>
  );
}
