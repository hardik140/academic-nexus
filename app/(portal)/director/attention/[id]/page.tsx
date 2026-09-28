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
import { assignRiskFlag, getRiskFlag, listAssignableStaff, reviewRiskFlag } from "../actions";

export default function DirectorAttentionDetail() {
  const params = useParams();
  const router = useRouter();
  const flagId = params.id as string;

  const [showAssign, setShowAssign] = useState(false);
  const [assigneeId, setAssigneeId] = useState("");
  const [showReview, setShowReview] = useState<"accept" | "reopen" | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The flag and who it can go to. A failed load is an error with Try
  // again, never the error message as page text (owner decision D5).
  const detail = useAsyncResource(async () => {
    const [flag, staff] = await Promise.all([getRiskFlag(flagId), listAssignableStaff()]);
    return { flag: flag as any, staff: staff as any[] };
  }, [flagId]);
  const flag = detail.data?.flag ?? null;
  const staff = detail.data?.staff ?? [];

  const handleAssign = async () => {
    if (!assigneeId || loading) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await assignRiskFlag({ flagId, assigneeId });
      const assignee = staff.find((p) => p.id === assigneeId);
      setNotice(`Escalation assigned${assignee ? ` to ${assignee.full_name}` : ""}.`);
      setShowAssign(false);
      setAssigneeId("");
      detail.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to assign."));
    } finally {
      setLoading(false);
    }
  };

  const handleReview = async (outcome: "accept" | "reopen") => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await reviewRiskFlag({ flagId, outcome, reason: reviewReason.trim() || undefined });
      setNotice(outcome === "accept" ? "Resolution accepted." : "Escalation reopened.");
      setShowReview(null);
      setReviewReason("");
      detail.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to review."));
    } finally {
      setLoading(false);
    }
  };

  if (!flag) {
    return detail.status === "error" ? (
      <ErrorState {...classifyError(detail.error)} title="This escalation couldn't be loaded" onRetry={detail.reload} />
    ) : (
      <LoadingState label="Loading the escalation…" />
    );
  }

  const canAssign = ["open", "assigned"].includes(flag.status);
  const canReview = flag.status === "resolved" && !flag.reviewed_at;

  return (
    <div className="space-y-lg max-w-[48rem]">
      <button type="button" onClick={() => router.push("/director/attention")} className="text-sm text-secondary hover:underline">
        ← Back to Attention Center
      </button>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg space-y-md">
        <div>
          <div className="flex items-center gap-sm mb-xs flex-wrap">
            <StatusBadge status={flag.status} />
            <StatusBadge status={flag.severity} />
            <span className="text-xs text-outline capitalize">{flag.flag_type.replace(/_/g, " ")}</span>
            <span className="text-xs text-outline capitalize">· {flag.scope_level.replace(/_/g, " ")} scope</span>
          </div>
          <h1 className="text-xl font-extrabold text-on-surface">{flag.title}</h1>
        </div>

        <p className="text-sm text-on-surface whitespace-pre-wrap">{flag.description}</p>

        <div className="grid grid-cols-2 gap-md text-sm">
          {flag.department && (
            <div>
              <div className="text-xs text-outline uppercase tracking-wider">Department</div>
              <div className="text-on-surface">{flag.department.name}</div>
            </div>
          )}
          {flag.affected_count != null && (
            <div>
              <div className="text-xs text-outline uppercase tracking-wider">Affected</div>
              <div className="text-on-surface">{flag.affected_count}</div>
            </div>
          )}
          <div>
            <div className="text-xs text-outline uppercase tracking-wider">Detected</div>
            <div className="text-on-surface">{new Date(flag.detected_at).toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs text-outline uppercase tracking-wider">Source</div>
            <div className="text-on-surface capitalize">{flag.source.replace(/_/g, " ")}</div>
          </div>
        </div>

        {flag.assignee && (
          <div className="text-xs text-outline border-t border-outline-variant pt-md">
            Assigned to {flag.assignee.full_name} ({flag.assignee.role}) by {flag.assigner?.full_name || "Director"}
          </div>
        )}
        {flag.resolution_notes && (
          <div className="text-xs text-outline">Resolution: {flag.resolution_notes}</div>
        )}
        {flag.reviewed_at && (
          <div className="text-xs text-outline">Reviewed by {flag.reviewer?.full_name} on {new Date(flag.reviewed_at).toLocaleDateString()}</div>
        )}
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      {/* An open dialog shows its own failure. */}
      <ErrorAlert error={!showAssign && !showReview ? error : null} />

      <div className="flex flex-wrap gap-sm">
        {canAssign && (
          <Button onClick={() => setShowAssign(true)} disabled={loading}>
            {flag.assigned_to ? "Reassign" : "Assign"}
          </Button>
        )}
        {canReview && (
          <>
            <Button onClick={() => setShowReview("accept")} disabled={loading}>
              Accept Resolution
            </Button>
            <Button variant="outline" onClick={() => setShowReview("reopen")} disabled={loading}>
              Reopen
            </Button>
          </>
        )}
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg">
        <LifecycleTimeline entityType="risk_flag" entityId={flagId} />
      </div>

      <Modal
        open={showAssign}
        onClose={() => setShowAssign(false)}
        title="Assign Escalation"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowAssign(false)}>
              Cancel
            </Button>
            <Button onClick={handleAssign} disabled={loading || !assigneeId} aria-busy={loading || undefined}>
              {loading ? "Assigning…" : "Assign"}
            </Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <FormField
          label="Assign to"
          id="assign-to"
          type="select"
          value={assigneeId}
          onChange={setAssigneeId}
          options={staff.map((p) => ({ value: p.id, label: `${p.full_name} (${p.role})` }))}
          required
        />
      </Modal>

      <Modal
        open={!!showReview}
        onClose={() => setShowReview(null)}
        title={showReview === "accept" ? "Accept Resolution" : "Reopen Escalation"}
        footer={
          <>
            <Button variant="outline" onClick={() => setShowReview(null)}>
              Cancel
            </Button>
            <Button onClick={() => showReview && handleReview(showReview)} disabled={loading} aria-busy={loading || undefined}>
              {loading ? "Saving…" : "Confirm"}
            </Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <FormField
          label={showReview === "reopen" ? "Reason for reopening" : "Note (optional)"}
          id="review-reason"
          type="textarea"
          rows={3}
          value={reviewReason}
          onChange={setReviewReason}
        />
      </Modal>
    </div>
  );
}
