"use client";

import { useState } from "react";
import { Button, FormField, StatusBadge } from "@/components/ui/modal";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { ErrorAlert } from "@/components/ui/error-alert";
import { ReadinessChecklist } from "@/components/academics/readiness-checklist";
import { formatDate } from "@/lib/format";
import type { DepartmentReadiness } from "@/lib/academic/types";
import type { FeedbackError } from "@/lib/action-failure";

/**
 * The department's operation inside the college's active term (055 §9,
 * decision 1). The COLLEGE term is Admin/Director's; this starts and ends
 * the department within it.
 *
 * Every input is in the panel, before the confirmation (ConfirmationDialog
 * confirms exactly once per opening): starting is enabled only when nothing
 * blocks it AND any offering without a teacher has been acknowledged;
 * ending is enabled only once a reason is written.
 */
const STATUS_LABEL: Record<DepartmentReadiness["status"], string> = {
  not_started: "Not started",
  active: "Running",
  ended: "Ended",
  no_active_term: "No college term",
};

export function DepartmentTermPanel({
  departmentName,
  readiness,
  onStart,
  onEnd,
  pending,
  error,
}: {
  departmentName: string;
  readiness: DepartmentReadiness;
  onStart: (acknowledgePending: boolean) => Promise<boolean> | boolean;
  onEnd: (reason: string) => Promise<boolean> | boolean;
  pending?: boolean;
  error?: FeedbackError | string | null;
}) {
  const [confirm, setConfirm] = useState<"start" | "end" | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState("");
  const reasonValid = reason.trim().length >= 10 && reason.length <= 1000;
  const needsAck = readiness.pending_count > 0;
  const canStart = readiness.status === "not_started" && readiness.ready && (!needsAck || acknowledged);
  const fieldId = `end-term-reason-${readiness.semester_id ?? "none"}`;

  const run = async () => {
    const ok = confirm === "start" ? await onStart(acknowledged) : await onEnd(reason.trim());
    if (ok) {
      setConfirm(null);
      setAcknowledged(false);
      setReason("");
    }
  };

  return (
    <section
      aria-labelledby="department-term-heading"
      className="space-y-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-sm"
      data-testid="department-term"
    >
      <div className="flex flex-wrap items-start justify-between gap-md">
        <div>
          <h2 id="department-term-heading" className="text-sm font-bold text-on-surface">Department term</h2>
          <p className="mt-xs text-sm text-on-surface-variant">
            {readiness.semester_name
              ? <>{departmentName} in <strong className="text-on-surface">{readiness.semester_name}</strong></>
              : "The college has no active term. Admin or Director starts it."}
          </p>
          {readiness.started_at && (
            <p className="mt-xs text-xs text-on-surface-variant">
              Started {formatDate(readiness.started_at)}{readiness.ended_at ? ` · ended ${formatDate(readiness.ended_at)}` : ""}
            </p>
          )}
        </div>
        <StatusBadge status={STATUS_LABEL[readiness.status]} />
      </div>

      {readiness.status === "not_started" && <ReadinessChecklist readiness={readiness} />}

      <ErrorAlert error={confirm ? null : error} />

      {readiness.status === "not_started" && (
        <div className="space-y-sm">
          {readiness.ready && needsAck && (
            <label className="flex items-start gap-sm text-sm text-on-surface">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-[3px]" />
              <span>
                Start with {readiness.pending_count} offering{readiness.pending_count === 1 ? "" : "s"} still without a teacher,
                and assign {readiness.pending_count === 1 ? "it" : "them"} later.
              </span>
            </label>
          )}
          <Button onClick={() => setConfirm("start")} disabled={!canStart || pending}>
            Start the department&apos;s term
          </Button>
          {!readiness.ready && <p className="text-xs text-on-surface-variant">Fix the items above to start the term.</p>}
        </div>
      )}

      {readiness.status === "active" && (
        <div className="space-y-sm">
          <FormField
            label="Reason for ending the term (recorded in the audit log)"
            id={fieldId}
            type="textarea"
            value={reason}
            onChange={setReason}
            error={reason.length > 0 && !reasonValid ? "Write at least 10 characters." : undefined}
          />
          <Button variant="destructive" onClick={() => setConfirm("end")} disabled={!reasonValid || pending}>
            End the department&apos;s term
          </Button>
        </div>
      )}

      <ConfirmationDialog
        open={confirm === "start"}
        title={`Start ${departmentName} in ${readiness.semester_name ?? "this term"}?`}
        description="Planned offerings become active and each section's students are enrolled in their classes. The department's teachers are notified."
        confirmLabel="Start term"
        pendingLabel="Starting…"
        tone="default"
        pending={!!pending}
        error={confirm === "start" ? error : null}
        onConfirm={() => void run()}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmationDialog
        open={confirm === "end"}
        title={`End ${departmentName}'s term?`}
        description="The department's offerings for this term become read-only: no new attendance or marks. Everything already recorded is kept. Corrections afterwards need a controlled reopen of the college term."
        confirmLabel="End term"
        pendingLabel="Ending…"
        pending={!!pending}
        error={confirm === "end" ? error : null}
        onConfirm={() => void run()}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}
