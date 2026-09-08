"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button, FormField, Modal, StatusBadge } from "@/components/ui/modal";
import { LifecycleTimeline } from "@/components/ui/lifecycle-timeline";
import { decideOnDecision, getDecision, listDecisionAuditTrail, listDelegateCandidates } from "../actions";

const DECIDE_ACTIONS: { value: string; label: string; variant: "primary" | "destructive" | "outline" | "secondary" }[] = [
  { value: "approved", label: "Approve", variant: "primary" },
  { value: "rejected", label: "Reject", variant: "destructive" },
  { value: "sent_back", label: "Send Back", variant: "outline" },
  { value: "info_requested", label: "Request More Information", variant: "outline" },
  { value: "delegated", label: "Delegate", variant: "secondary" },
];

export default function DirectorDecisionDetail() {
  const params = useParams();
  const router = useRouter();
  const decisionId = params.id as string;

  const [decision, setDecision] = useState<any>(null);
  const [auditTrail, setAuditTrail] = useState<any[]>([]);
  const [delegates, setDelegates] = useState<any[]>([]);
  const [showDecideModal, setShowDecideModal] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [delegateTo, setDelegateTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [d, audit, candidates] = await Promise.all([
        getDecision(decisionId),
        listDecisionAuditTrail(decisionId),
        listDelegateCandidates(),
      ]);
      setDecision(d);
      setAuditTrail(audit);
      setDelegates(candidates);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load decision.");
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisionId]);

  const handleDecide = async (action: string) => {
    setLoading(true);
    setError(null);
    try {
      await decideOnDecision({
        decisionId,
        action: action as "approved" | "rejected" | "sent_back" | "info_requested" | "delegated" | "withdrawn",
        reason: reason.trim() || undefined,
        delegateTo: action === "delegated" ? delegateTo || undefined : undefined,
      });
      setShowDecideModal(null);
      setReason("");
      setDelegateTo("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to record decision.");
    } finally {
      setLoading(false);
    }
  };

  if (!decision) {
    return <div className="p-xl text-center text-sm text-outline">{error || "Loading..."}</div>;
  }

  const isPending = ["pending", "info_requested", "sent_back"].includes(decision.status);

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out] max-w-[48rem]">
      <button type="button" onClick={() => router.push("/director/decisions")} className="text-sm text-secondary hover:underline">
        ← Back to Decision Inbox
      </button>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg space-y-md">
        <div>
          <div className="flex items-center gap-sm mb-xs flex-wrap">
            <StatusBadge status={decision.status} />
            <StatusBadge status={decision.urgency} />
            <span className="text-xs text-outline capitalize">{decision.category.replace(/_/g, " ")}</span>
          </div>
          <h1 className="text-xl font-extrabold text-on-surface">{decision.title}</h1>
        </div>

        <p className="text-sm text-on-surface whitespace-pre-wrap">{decision.description}</p>

        <div className="grid grid-cols-2 gap-md text-sm">
          <div>
            <div className="text-xs text-outline uppercase tracking-wider">Requested by</div>
            <div className="text-on-surface">
              {decision.requester?.full_name} ({decision.requester?.role})
            </div>
          </div>
          {decision.department && (
            <div>
              <div className="text-xs text-outline uppercase tracking-wider">Department</div>
              <div className="text-on-surface">{decision.department.name}</div>
            </div>
          )}
          {decision.financial_impact != null && (
            <div>
              <div className="text-xs text-outline uppercase tracking-wider">Financial Impact</div>
              <div className="text-on-surface">₹{Number(decision.financial_impact).toLocaleString()}</div>
            </div>
          )}
          {decision.student_impact_count != null && (
            <div>
              <div className="text-xs text-outline uppercase tracking-wider">Student Impact</div>
              <div className="text-on-surface">{decision.student_impact_count} students</div>
            </div>
          )}
          {decision.deadline && (
            <div>
              <div className="text-xs text-outline uppercase tracking-wider">Deadline</div>
              <div className="text-on-surface">{new Date(decision.deadline).toLocaleDateString()}</div>
            </div>
          )}
        </div>

        {decision.institutional_impact_summary && (
          <div>
            <div className="text-xs text-outline uppercase tracking-wider mb-xs">Institutional Impact</div>
            <p className="text-sm text-on-surface-variant">{decision.institutional_impact_summary}</p>
          </div>
        )}

        {decision.recommendation && (
          <div>
            <div className="text-xs text-outline uppercase tracking-wider mb-xs">Recommendation</div>
            <p className="text-sm text-on-surface-variant">{decision.recommendation}</p>
          </div>
        )}

        {decision.status !== "pending" && (
          <div className="text-xs text-outline border-t border-outline-variant pt-md">
            {decision.decider && <>Decided by {decision.decider.full_name}. </>}
            {decision.delegate && (
              <>
                Delegated to {decision.delegate.full_name} ({decision.delegate.role}).{" "}
              </>
            )}
            {decision.decision_reason && <>Reason: {decision.decision_reason}</>}
          </div>
        )}
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      {isPending && (
        <div className="flex flex-wrap gap-sm">
          {DECIDE_ACTIONS.map((a) => (
            <Button key={a.value} variant={a.variant} onClick={() => setShowDecideModal(a.value)} disabled={loading}>
              {a.label}
            </Button>
          ))}
        </div>
      )}

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg">
        <LifecycleTimeline entityType="decision" entityId={decisionId} />
      </div>

      {auditTrail.length > 0 && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg">
          <h3 className="text-sm font-bold text-on-surface mb-md">Audit Trail</h3>
          <div className="space-y-sm">
            {auditTrail.map((a: any) => (
              <div key={a.id} className="text-xs text-outline">
                <span className="font-semibold text-on-surface">{a.actor?.full_name}</span> — {a.action.replace(/_/g, " ")} ·{" "}
                {new Date(a.created_at).toLocaleString()}
              </div>
            ))}
          </div>
        </div>
      )}

      <Modal
        open={!!showDecideModal}
        onClose={() => setShowDecideModal(null)}
        title={DECIDE_ACTIONS.find((a) => a.value === showDecideModal)?.label || "Decide"}
        footer={
          <>
            <Button variant="outline" onClick={() => setShowDecideModal(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => showDecideModal && handleDecide(showDecideModal)}
              disabled={loading || (showDecideModal === "delegated" && !delegateTo)}
            >
              {loading ? "..." : "Confirm"}
            </Button>
          </>
        }
      >
        <div className="space-y-md">
          {showDecideModal === "delegated" && (
            <FormField
              label="Delegate to"
              id="delegate-to"
              type="select"
              value={delegateTo}
              onChange={setDelegateTo}
              options={delegates.map((p) => ({ value: p.id, label: `${p.full_name} (${p.role})` }))}
              required
            />
          )}
          <FormField
            label="Reason (optional)"
            id="decide-reason"
            type="textarea"
            rows={3}
            value={reason}
            onChange={setReason}
            placeholder="Add context for this decision..."
          />
        </div>
      </Modal>
    </div>
  );
}
