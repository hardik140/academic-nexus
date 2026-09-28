"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button, FormField, Modal, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { classifyError } from "@/lib/feedback-error";
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

  const [showDecideModal, setShowDecideModal] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [delegateTo, setDelegateTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The decision, its audit trail and who it may be delegated to. A failed
  // load is an error with Try again, never the message as page text (D5).
  const detail = useAsyncResource(async () => {
    const [decision, auditTrail, delegates] = await Promise.all([
      getDecision(decisionId),
      listDecisionAuditTrail(decisionId),
      listDelegateCandidates(),
    ]);
    return { decision: decision as any, auditTrail: auditTrail as any[], delegates: delegates as any[] };
  }, [decisionId]);
  const decision = detail.data?.decision ?? null;
  const auditTrail = detail.data?.auditTrail ?? [];
  const delegates = detail.data?.delegates ?? [];

  const handleDecide = async (action: string) => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await decideOnDecision({
        decisionId,
        action: action as "approved" | "rejected" | "sent_back" | "info_requested" | "delegated" | "withdrawn",
        reason: reason.trim() || undefined,
        delegateTo: action === "delegated" ? delegateTo || undefined : undefined,
      });
      setNotice(`Decision recorded: ${DECIDE_ACTIONS.find((a) => a.value === action)?.label ?? action}.`);
      setShowDecideModal(null);
      setReason("");
      setDelegateTo("");
      detail.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to record decision."));
    } finally {
      setLoading(false);
    }
  };

  if (!decision) {
    return detail.status === "error" ? (
      <ErrorState {...classifyError(detail.error)} title="This decision couldn't be loaded" onRetry={detail.reload} />
    ) : (
      <LoadingState label="Loading the decision…" />
    );
  }

  const isPending = ["pending", "info_requested", "sent_back"].includes(decision.status);

  return (
    <div className="space-y-lg max-w-[48rem]">
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

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      {/* The decide dialog shows its own failure. */}
      <ErrorAlert error={!showDecideModal ? error : null} />

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
              aria-busy={loading || undefined}
            >
              {loading ? "Saving…" : "Confirm"}
            </Button>
          </>
        }
      >
        <div className="space-y-md">
          <ErrorAlert error={error} />
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
