"use client";

import { useRef, useState } from "react";
import { Button, FormField, Modal } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
// A type only (erased at build): this file never imports the Server Action
// itself, so the development gallery can render it with a stand-in.
import type { SubmitDecisionParams } from "@/app/(portal)/director/decisions/actions";

const CATEGORY_OPTIONS = [
  { value: "department_change", label: "Department Change" },
  { value: "hod_assignment", label: "HOD Assignment" },
  { value: "financial_exception", label: "Financial Exception" },
  { value: "policy_exception", label: "Policy Exception" },
  { value: "placement_drive_approval", label: "Placement Drive Approval" },
  { value: "scholarship_exception", label: "Scholarship Exception" },
  { value: "other", label: "Other" },
];

const URGENCY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

/**
 * The request form and its result (M6.4), given the action to call.
 *
 * On a confirmed success the dialog closes at once — the browser returns
 * focus to the button that opened it — and a persistent success Alert under
 * that button records what was sent. Nothing else follows on a timer, so
 * nothing can close or clear a dialog opened again afterwards.
 *
 * One request per submission: a second Submit while one is in flight is
 * ignored (a synchronous guard, as well as the disabled button), and the
 * closing dialog is inert, so it cannot be submitted again on its way out.
 * What the client cannot prevent is a retry after a response was lost in
 * transit — the server has no idempotency key for decisions, which needs a
 * backend change (recorded as debt, M6 architecture, Unknown B).
 */
export function RequestDecision({ onSubmit }: { onSubmit: (params: SubmitDecisionParams) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("other");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [urgency, setUrgency] = useState("medium");
  const [deadline, setDeadline] = useState("");
  const [financialImpact, setFinancialImpact] = useState("");
  const [studentImpactCount, setStudentImpactCount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const inFlight = useRef(false);

  const reset = () => {
    setCategory("other");
    setTitle("");
    setDescription("");
    setUrgency("medium");
    setDeadline("");
    setFinancialImpact("");
    setStudentImpactCount("");
    setError(null);
  };

  const close = () => {
    // Not while a request is in flight: its outcome belongs to this dialog.
    if (inFlight.current) return;
    setOpen(false);
    reset();
  };

  const handleSubmit = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        category: category as SubmitDecisionParams["category"],
        title,
        description,
        urgency: urgency as SubmitDecisionParams["urgency"],
        deadline: deadline || undefined,
        financialImpact: financialImpact ? Number(financialImpact) : undefined,
        studentImpactCount: studentImpactCount ? Number(studentImpactCount) : undefined,
      });
      setSuccess(`Decision request "${title.trim()}" sent to the Director.`);
      setOpen(false);
      reset();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to submit request."));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="flex w-full max-w-sm flex-col items-end gap-sm">
      <Button variant="outline" onClick={() => setOpen(true)}>
        📤 Request Director Decision
      </Button>
      <Alert tone="success" className="w-full" onDismiss={() => setSuccess(null)}>
        {success}
      </Alert>
      <Modal
        open={open}
        onClose={close}
        title="Request Director Decision"
        description="Escalate something that needs Director-level approval."
        footer={
          <>
            <Button variant="outline" onClick={close} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting || !title.trim() || !description.trim()}
              aria-busy={submitting || undefined}
            >
              {submitting ? "Sending…" : "Submit"}
            </Button>
          </>
        }
      >
        <div className="space-y-md">
          <ErrorAlert error={error} />
          <FormField label="Category" id="rd-category" type="select" value={category} onChange={setCategory} options={CATEGORY_OPTIONS} required />
          <FormField label="Title" id="rd-title" value={title} onChange={setTitle} placeholder="Short summary" required />
          <FormField
            label="Description"
            id="rd-description"
            type="textarea"
            rows={3}
            value={description}
            onChange={setDescription}
            placeholder="What are you asking the Director to decide, and why?"
            required
          />
          <FormField label="Urgency" id="rd-urgency" type="select" value={urgency} onChange={setUrgency} options={URGENCY_OPTIONS} required />
          <div className="grid grid-cols-2 gap-md">
            <FormField
              label="Financial impact ₹ (optional)"
              id="rd-financial"
              type="number"
              value={financialImpact}
              onChange={setFinancialImpact}
              placeholder="0"
            />
            <FormField
              label="Students affected (optional)"
              id="rd-student-count"
              type="number"
              value={studentImpactCount}
              onChange={setStudentImpactCount}
              placeholder="0"
            />
          </div>
          <FormField label="Deadline (optional)" id="rd-deadline" type="date" value={deadline} onChange={setDeadline} />
        </div>
      </Modal>
    </div>
  );
}
