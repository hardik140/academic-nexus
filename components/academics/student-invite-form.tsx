"use client";

import { useState } from "react";
import { Button, FormField } from "@/components/ui/modal";
import { ErrorAlert } from "@/components/ui/error-alert";
import type { SectionOption } from "@/lib/academic/types";
import type { FeedbackError } from "@/lib/action-failure";

/**
 * Inviting a student into a SECTION (055 §14, decision 3). The inviter
 * chooses the section — or, for a Class In-Charge, it is their own section,
 * fixed — and the database resolves the department, programme and intake
 * year from it. There is deliberately no department or batch-year field.
 *
 * Presentational: the caller sends the invitation and reports the outcome.
 */
export interface StudentInviteValues {
  email: string;
  fullName: string;
  sectionId: string;
  enrollmentNumber: string;
  programmeSemester: number;
  parentName?: string;
  parentEmail?: string;
  parentPhone?: string;
}

export function StudentInviteForm({
  sections,
  maxSemester,
  onSubmit,
  pending,
  error,
  idPrefix = "student-invite",
}: {
  /** One section = the In-Charge's own, shown fixed. Several = a choice. */
  sections: SectionOption[];
  maxSemester: number;
  onSubmit: (values: StudentInviteValues) => void;
  pending?: boolean;
  error?: FeedbackError | string | null;
  idPrefix?: string;
}) {
  const fixed = sections.length === 1 ? sections[0] : null;
  const [values, setValues] = useState({
    email: "", fullName: "", sectionId: fixed?.id ?? "", enrollmentNumber: "", programmeSemester: "",
    parentName: "", parentEmail: "", parentPhone: "",
  });
  const set = (k: keyof typeof values) => (v: string) => setValues({ ...values, [k]: v });
  const semesterOptions = Array.from({ length: Math.max(1, maxSemester) }, (_, i) => ({ value: String(i + 1), label: `Semester ${i + 1}` }));
  const complete = values.email && values.fullName && (fixed || values.sectionId) && values.enrollmentNumber && values.programmeSemester;

  return (
    <form
      className="space-y-md"
      data-testid="student-invite-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!complete || pending) return;
        onSubmit({
          email: values.email.trim(),
          fullName: values.fullName.trim(),
          sectionId: fixed?.id ?? values.sectionId,
          enrollmentNumber: values.enrollmentNumber.trim(),
          programmeSemester: Number(values.programmeSemester),
          parentName: values.parentName || undefined,
          parentEmail: values.parentEmail || undefined,
          parentPhone: values.parentPhone || undefined,
        });
      }}
    >
      <ErrorAlert error={error} />
      {fixed ? (
        <p className="text-sm text-on-surface-variant">
          Section: <strong className="text-on-surface">{fixed.label}</strong>
        </p>
      ) : (
        <FormField label="Section" id={`${idPrefix}-section`} type="select" value={values.sectionId} onChange={set("sectionId")} options={sections.map((s) => ({ value: s.id, label: s.label }))} required />
      )}
      <div className="grid grid-cols-1 gap-md sm:grid-cols-2">
        <FormField label="Full name" id={`${idPrefix}-name`} value={values.fullName} onChange={set("fullName")} required />
        <FormField label="Email" id={`${idPrefix}-email`} type="email" value={values.email} onChange={set("email")} required />
        <FormField label="Enrollment number" id={`${idPrefix}-enrollment`} value={values.enrollmentNumber} onChange={set("enrollmentNumber")} placeholder="e.g. 2026CSE001" required />
        <FormField label="Programme semester" id={`${idPrefix}-semester`} type="select" value={values.programmeSemester} onChange={set("programmeSemester")} options={semesterOptions} required />
        <FormField label="Parent name" id={`${idPrefix}-parent-name`} value={values.parentName} onChange={set("parentName")} />
        <FormField label="Parent email" id={`${idPrefix}-parent-email`} type="email" value={values.parentEmail} onChange={set("parentEmail")} />
        <FormField label="Parent phone" id={`${idPrefix}-parent-phone`} value={values.parentPhone} onChange={set("parentPhone")} />
      </div>
      <p className="text-xs text-on-surface-variant">
        The department, programme and intake year come from the section. The student joins it — and its classes — when they accept.
      </p>
      <Button type="submit" disabled={!complete || pending} aria-busy={pending || undefined}>{pending ? "Sending…" : "Send invitation"}</Button>
    </form>
  );
}
