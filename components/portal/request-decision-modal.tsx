"use client";

import { useState } from "react";
import { Button, FormField, Modal } from "@/components/ui/modal";
import { submitDecision } from "@/app/(portal)/director/decisions/actions";

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
 * Shared by HOD, Warden, and Placement Cell dashboards — the only entry
 * point into the Decision Inbox (decisions_submit RLS restricts insert to
 * exactly these three roles, see migration 026). Calls the same
 * submitDecision Server Action Director's own Decision Inbox reads from.
 */
export function RequestDecisionButton() {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("other");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [urgency, setUrgency] = useState("medium");
  const [deadline, setDeadline] = useState("");
  const [financialImpact, setFinancialImpact] = useState("");
  const [studentImpactCount, setStudentImpactCount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const reset = () => {
    setCategory("other");
    setTitle("");
    setDescription("");
    setUrgency("medium");
    setDeadline("");
    setFinancialImpact("");
    setStudentImpactCount("");
    setError(null);
    setSuccess(false);
  };

  const close = () => {
    setOpen(false);
    reset();
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await submitDecision({
        category: category as
          | "department_change"
          | "hod_assignment"
          | "financial_exception"
          | "policy_exception"
          | "placement_drive_approval"
          | "scholarship_exception"
          | "other",
        title,
        description,
        urgency: urgency as "low" | "medium" | "high" | "critical",
        deadline: deadline || undefined,
        financialImpact: financialImpact ? Number(financialImpact) : undefined,
        studentImpactCount: studentImpactCount ? Number(studentImpactCount) : undefined,
      });
      setSuccess(true);
      setTimeout(close, 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit request.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        📤 Request Director Decision
      </Button>
      <Modal
        open={open}
        onClose={close}
        title="Request Director Decision"
        description="Escalate something that needs Director-level approval."
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting || !title.trim() || !description.trim()}>
              {submitting ? "..." : success ? "Sent ✓" : "Submit"}
            </Button>
          </>
        }
      >
        <div className="space-y-md">
          {error && (
            <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
          )}
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
    </>
  );
}
