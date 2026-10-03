"use client";

import { useState } from "react";
import { Modal, Button, FormField } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { LoadingState } from "@/components/ui/loading-state";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import type { FeedbackError } from "@/lib/action-failure";
import type { CollegeLifecycleState } from "@/types/database";

/**
 * Super Admin controls for a college's lifecycle (migration 053):
 * the status badge, the change dialog and the history.
 *
 * MAINTENANCE and SUSPENDED are full blocks for the college's users and are
 * not data deletion — the dialog says both, plainly, before anything is
 * changed. The database is the authority on every rule shown here; the form
 * only repeats them so the user learns before submitting.
 */

const STATE_LABEL: Record<CollegeLifecycleState, string> = {
  ACTIVE: "Active",
  MAINTENANCE: "Maintenance",
  SUSPENDED: "Suspended",
};

const BADGE: Record<CollegeLifecycleState, string> = {
  ACTIVE: "bg-success-container text-on-success-container",
  MAINTENANCE: "bg-warning-container text-on-warning-container",
  SUSPENDED: "bg-error-container text-on-error-container",
};

export function LifecycleBadge({ state }: { state: CollegeLifecycleState }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-sm py-xs text-xs font-semibold", BADGE[state])}>
      {STATE_LABEL[state]}
    </span>
  );
}

/** A datetime-local value, read as India Standard Time (owner decision D7), as an ISO instant. */
export function istLocalToIso(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const instant = new Date(`${value}:00+05:30`);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface LifecycleChange {
  state: CollegeLifecycleState;
  reason: string;
  message?: string;
  expectedResumeAt?: string;
}

const SUBMIT_LABEL: Record<CollegeLifecycleState, string> = {
  ACTIVE: "Reactivate college",
  MAINTENANCE: "Put under maintenance",
  SUSPENDED: "Suspend college",
};

export function LifecycleDialog({
  open,
  onClose,
  college,
  onSubmit,
  pending,
  error,
}: {
  open: boolean;
  onClose: () => void;
  college: { name: string; lifecycle_state: CollegeLifecycleState; lifecycle_message?: string | null } | null;
  onSubmit: (change: LifecycleChange) => void;
  pending?: boolean;
  error?: FeedbackError | string | null;
}) {
  const current = college?.lifecycle_state ?? "ACTIVE";
  const [state, setState] = useState<CollegeLifecycleState>("MAINTENANCE");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [resume, setResume] = useState("");
  const [touched, setTouched] = useState(false);
  const [resumeInPast, setResumeInPast] = useState(false);

  // A fresh form each time the dialog opens, set while rendering rather than
  // in an effect (react.dev: "storing information from previous renders").
  const openedFor = open ? `${college?.name ?? ""}:${current}` : null;
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  if (openedFor !== lastOpened) {
    setLastOpened(openedFor);
    if (openedFor) {
      setState(current === "ACTIVE" ? "MAINTENANCE" : "ACTIVE");
      setReason("");
      setMessage(current === "ACTIVE" ? "" : college?.lifecycle_message ?? "");
      setResume("");
      setTouched(false);
      setResumeInPast(false);
    }
  }

  const resumeIso = state === "MAINTENANCE" && resume ? istLocalToIso(resume) : undefined;
  const errors = {
    reason: reason.trim().length < 10 ? "Give a reason of at least 10 characters." : reason.length > 1000 ? "The reason is limited to 1000 characters." : undefined,
    message: message.length > 500 ? "The message is limited to 500 characters." : undefined,
    resume: state === "MAINTENANCE" && resume && (!resumeIso || resumeInPast) ? "Choose a time in the future." : undefined,
    state: state === current && state === "ACTIVE" ? "The college is already active." : undefined,
  };
  const invalid = Object.values(errors).some(Boolean);

  const submit = () => {
    setTouched(true);
    // "In the future" is judged when the user submits, not while rendering.
    const past = !!resumeIso && new Date(resumeIso).getTime() <= Date.now();
    setResumeInPast(past);
    if (invalid || past || pending) return;
    onSubmit({
      state,
      reason: reason.trim(),
      message: state === "ACTIVE" ? undefined : message.trim() || undefined,
      expectedResumeAt: resumeIso,
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Change status — ${college?.name ?? ""}`}
      description={`Currently ${STATE_LABEL[current].toLowerCase()}.`}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            variant={state === "SUSPENDED" ? "destructive" : "primary"}
            onClick={submit}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? "Saving…" : SUBMIT_LABEL[state]}
          </Button>
        </>
      }
    >
      <div className="space-y-md" data-testid="lifecycle-dialog">
        <ErrorAlert error={error ?? null} />

        <fieldset className="space-y-xs">
          <legend className="text-sm font-medium text-on-surface">New status</legend>
          {(["ACTIVE", "MAINTENANCE", "SUSPENDED"] as const).map((s) => (
            <label key={s} className="flex items-center gap-sm text-sm text-on-surface">
              <input
                type="radio"
                name="lifecycle-state"
                value={s}
                checked={state === s}
                onChange={() => setState(s)}
              />
              {STATE_LABEL[s]}
              {s === current && <span className="text-xs text-on-surface-variant">(current)</span>}
            </label>
          ))}
          {touched && errors.state && <p className="text-xs text-error">{errors.state}</p>}
        </fieldset>

        <Alert tone="info">
          {state === "ACTIVE" &&
            `Users of ${college?.name ?? "this college"} can sign in again. Sessions that were signed out by the previous change stay signed out; nothing else changes.`}
        </Alert>
        <Alert tone="warning" title={state !== "ACTIVE" ? "Every user of this college is signed out immediately" : undefined}>
          {state !== "ACTIVE" &&
            `Nobody at ${college?.name ?? "this college"} — students, staff, the Director or the College Admin — can use the app until it is reactivated. No data is deleted or changed.`}
        </Alert>

        <FormField
          label="Reason (recorded in the history; not shown to users)"
          id="lifecycle-reason"
          type="textarea"
          value={reason}
          onChange={setReason}
          required
          error={touched ? errors.reason : undefined}
        />

        {state !== "ACTIVE" && (
          <FormField
            label="Message to the college's users (optional)"
            id="lifecycle-message"
            type="textarea"
            value={message}
            onChange={setMessage}
            error={touched ? errors.message : undefined}
          />
        )}

        {state === "MAINTENANCE" && (
          <FormField
            label="Expected back (IST, optional)"
            id="lifecycle-resume"
            type="datetime-local"
            value={resume}
            onChange={(v) => { setResume(v); setResumeInPast(false); }}
            error={touched ? errors.resume : undefined}
          />
        )}
      </div>
    </Modal>
  );
}

export interface LifecycleHistoryEntry {
  id: string;
  previous_state: string;
  new_state: string;
  reason: string;
  message: string | null;
  expected_resume_at: string | null;
  sessions_revoked: number;
  changed_at: string;
}

export function LifecycleHistoryDialog({
  open,
  onClose,
  collegeName,
  entries,
  error,
}: {
  open: boolean;
  onClose: () => void;
  collegeName: string;
  /** null while loading. */
  entries: LifecycleHistoryEntry[] | null;
  error?: FeedbackError | string | null;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Status history — ${collegeName}`}
      description="Every lifecycle change, newest first. Records cannot be edited or removed."
      size="lg"
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      <div className="space-y-md" data-testid="lifecycle-history">
        <ErrorAlert error={error ?? null} />
        {entries === null && !error && <LoadingState label="Loading history…" />}
        {entries && entries.length === 0 && <p className="text-sm text-on-surface-variant">No status changes yet — this college has always been active.</p>}
        {entries && entries.length > 0 && (
          <ol className="space-y-sm">
            {entries.map((entry) => (
              <li key={entry.id} className="rounded-panel border border-outline-variant p-md text-sm">
                <p className="font-medium text-on-surface">
                  {STATE_LABEL[entry.previous_state as CollegeLifecycleState] ?? entry.previous_state} → {STATE_LABEL[entry.new_state as CollegeLifecycleState] ?? entry.new_state}
                  <span className="ml-sm text-xs font-normal text-on-surface-variant">{formatDate(entry.changed_at, "datetime")}</span>
                </p>
                <p className="mt-xs text-on-surface">{entry.reason}</p>
                {entry.message && <p className="mt-xs text-on-surface-variant">Message shown: {entry.message}</p>}
                {entry.expected_resume_at && <p className="text-on-surface-variant">Expected back: {formatDate(entry.expected_resume_at, "datetime")}</p>}
                <p className="mt-xs text-xs text-on-surface-variant">
                  {entry.sessions_revoked === 1 ? "1 session signed out" : `${entry.sessions_revoked} sessions signed out`}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Modal>
  );
}
