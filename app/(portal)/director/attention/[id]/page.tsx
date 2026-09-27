"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button, FormField, Modal, StatusBadge } from "@/components/ui/modal";
import { LifecycleTimeline } from "@/components/ui/lifecycle-timeline";
import { assignRiskFlag, getRiskFlag, listAssignableStaff, reviewRiskFlag } from "../actions";

export default function DirectorAttentionDetail() {
  const params = useParams();
  const router = useRouter();
  const flagId = params.id as string;

  const [flag, setFlag] = useState<any>(null);
  const [staff, setStaff] = useState<any[]>([]);
  const [showAssign, setShowAssign] = useState(false);
  const [assigneeId, setAssigneeId] = useState("");
  const [showReview, setShowReview] = useState<"accept" | "reopen" | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [f, s] = await Promise.all([getRiskFlag(flagId), listAssignableStaff()]);
      setFlag(f);
      setStaff(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load.");
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagId]);

  const handleAssign = async () => {
    if (!assigneeId) return;
    setLoading(true);
    setError(null);
    try {
      await assignRiskFlag({ flagId, assigneeId });
      setShowAssign(false);
      setAssigneeId("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to assign.");
    } finally {
      setLoading(false);
    }
  };

  const handleReview = async (outcome: "accept" | "reopen") => {
    setLoading(true);
    setError(null);
    try {
      await reviewRiskFlag({ flagId, outcome, reason: reviewReason.trim() || undefined });
      setShowReview(null);
      setReviewReason("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to review.");
    } finally {
      setLoading(false);
    }
  };

  if (!flag) {
    return <div className="p-xl text-center text-sm text-outline">{error || "Loading..."}</div>;
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

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

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
            <Button onClick={handleAssign} disabled={loading || !assigneeId}>
              {loading ? "..." : "Assign"}
            </Button>
          </>
        }
      >
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
            <Button onClick={() => showReview && handleReview(showReview)} disabled={loading}>
              {loading ? "..." : "Confirm"}
            </Button>
          </>
        }
      >
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
