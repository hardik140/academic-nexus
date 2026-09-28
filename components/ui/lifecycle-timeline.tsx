"use client";

import { useState } from "react";
import { addEscalationNote, listEscalationNotes } from "@/lib/escalation-notes";
import { Button, FormField } from "@/components/ui/modal";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";

interface LifecycleTimelineProps {
  entityType: "decision" | "risk_flag";
  entityId: string;
  canAddNote?: boolean;
}

const ENTRY_ICONS: Record<string, string> = {
  note: "💬",
  info_request: "❓",
  info_response: "↩️",
  evidence: "📎",
  status_change: "🔄",
  assigned: "➡️",
  acknowledged: "👀",
  resolved: "✅",
};

/**
 * Shared timeline UI for both the Decision Inbox and the Attention Center —
 * reads/writes lib/escalation-notes.ts's polymorphic thread (migration 028)
 * keyed by (entityType, entityId).
 */
export function LifecycleTimeline({ entityType, entityId, canAddNote = true }: LifecycleTimelineProps) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);

  // The thread. A failed load is an error, never "No activity yet." (D5).
  const notesResource = useAsyncResource(() => listEscalationNotes(entityType, entityId), [entityType, entityId]);

  const handleAddNote = async () => {
    if (!body.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await addEscalationNote({ entityType, entityId, entryType: "note", body: body.trim() });
      setBody("");
      // Refreshing the thread reports its own failure, never as a failed note.
      notesResource.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to add note."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-md">
      <h3 className="text-sm font-bold text-on-surface">Activity</h3>
      <ErrorAlert error={error} />
      <StateView state={notesResource} isEmpty={() => false} loadingLabel="Loading activity…" empty={{ title: "No activity yet" }}>
        {(notes: any[]) => (
      <div className="space-y-sm">
        {notes.length === 0 && <div className="text-sm text-outline">No activity yet.</div>}
        {notes.map((n: any) => (
          <div key={n.id} className="flex items-start gap-sm">
            <div className="w-7 h-7 rounded-full bg-surface-container-high flex items-center justify-center text-sm shrink-0">
              {ENTRY_ICONS[n.entry_type] || "•"}
            </div>
            <div className="flex-1">
              <div className="text-xs text-on-surface-variant">
                <span className="font-semibold text-on-surface">{n.author?.full_name || "Someone"}</span>{" "}
                <span className="capitalize">{n.entry_type.replace(/_/g, " ")}</span>
                {" · "}
                {new Date(n.created_at).toLocaleString()}
              </div>
              {n.body && <div className="text-sm text-on-surface mt-xs">{n.body}</div>}
            </div>
          </div>
        ))}
      </div>
        )}
      </StateView>
      {canAddNote && (
        <div className="flex gap-sm items-end pt-sm border-t border-outline-variant">
          <div className="flex-1">
            <FormField
              label="Add a note"
              id="timeline-note"
              type="textarea"
              rows={2}
              value={body}
              onChange={setBody}
              placeholder="Add context, evidence, or a status update..."
            />
          </div>
          <Button size="sm" onClick={handleAddNote} disabled={submitting || !body.trim()} aria-busy={submitting || undefined}>
            {submitting ? "..." : "Post"}
          </Button>
        </div>
      )}
    </div>
  );
}
