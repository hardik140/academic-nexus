"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import Link from "next/link";
import { Button, Modal, StatusBadge, FormField } from "@/components/ui/modal";
import { createManualRiskFlag, getStudentRiskOverview, listRiskFlags, type ManualFlagParams } from "./actions";

const FLAG_TYPE_OPTIONS = [
  { value: "attendance_decline", label: "Attendance Decline" },
  { value: "academic_backlog", label: "Academic Backlog" },
  { value: "fee_overdue", label: "Fee Overdue" },
  { value: "placement_inactivity", label: "Placement Inactivity" },
  { value: "hostel_issue", label: "Hostel Issue" },
  { value: "faculty_workload_gap", label: "Faculty Workload Gap" },
  { value: "composite_student_risk", label: "Composite Student Risk" },
  { value: "institutional_metric", label: "Institutional Metric" },
];
const SEVERITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];
const SCOPE_OPTIONS = [
  { value: "institution", label: "Institution" },
  { value: "department", label: "Department" },
  { value: "student", label: "Student" },
  { value: "faculty", label: "Faculty" },
  { value: "hostel_block", label: "Hostel Block" },
];

export default function DirectorAttention() {
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<Partial<ManualFlagParams>>({ severity: "medium", scopeLevel: "institution" });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<FeedbackError | string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Required fields left empty on the last Create, by field id.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Flags and the student-risk overview. A failed load is an error, never
  // "No critical institutional risks detected." (owner decision D5).
  const attention = useAsyncResource(async () => {
    const [flags, risk] = await Promise.all([listRiskFlags(), getStudentRiskOverview()]);
    return { flags, risk };
  }, []);
  const open: any[] = attention.data?.flags.open ?? [];
  const resolved: any[] = attention.data?.flags.resolved ?? [];
  const studentRisk: any[] = attention.data?.risk ?? [];

  const handleCreate = async () => {
    if (creating) return;
    // Say which fields are missing, on the fields themselves and in a summary.
    const missing: Record<string, string> = {};
    if (!form.flagType) missing["flag-type"] = "Choose a flag type.";
    if (!form.title?.trim()) missing["flag-title"] = "Enter a title.";
    if (!form.description?.trim()) missing["flag-description"] = "Describe what needs attention.";
    setFieldErrors(missing);
    const firstMissing = Object.keys(missing)[0];
    if (firstMissing) {
      setError(`Fill in ${Object.keys(missing).length === 1 ? "the highlighted field" : "the highlighted fields"} to create the flag.`);
      document.getElementById(firstMissing)?.focus();
      return;
    }
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      await createManualRiskFlag(form as ManualFlagParams);
      setShowCreate(false);
      setNotice(`Flag "${form.title}" created.`);
      setForm({ severity: "medium", scopeLevel: "institution" });
      attention.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to create flag."));
    } finally {
      setCreating(false);
    }
  };

  const totalAtRisk = studentRisk.reduce((s, d) => s + d.atRisk, 0);
  const totalCritical = studentRisk.reduce((s, d) => s + d.critical, 0);

  return (
    <div className="space-y-lg">
      <div className="flex items-start justify-between gap-md">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Attention Required</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Exceptions, risks, and escalations that need your attention</p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setError(null);
            setFieldErrors({});
            setShowCreate(true);
          }}
        >
          + Flag Manually
        </Button>
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      {/* The create dialog shows its own failure. */}
      <ErrorAlert error={!showCreate ? error : null} />

      <StateView state={attention} isEmpty={() => false} loadingLabel="Loading attention items…" empty={{ title: "Nothing needs attention" }}>
        {() => (
          <>
      {/* Student Risk Overview — aggregate-first, never a named list here */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🧭 Student Risk Overview</h2>
          <span className="text-xs text-outline">
            {totalAtRisk} at-risk · {totalCritical} critical (institution-wide)
          </span>
        </div>
        {studentRisk.length === 0 ? (
          <div className="p-xl text-center text-sm text-outline">No student data available yet.</div>
        ) : (
          <div className="divide-y divide-outline-variant">
            {studentRisk.map((d) => (
              <div key={d.departmentId} className="flex items-center justify-between px-lg py-md">
                <div>
                  <div className="text-sm font-semibold text-on-surface">
                    {d.name} <span className="text-xs text-outline font-normal">({d.totalStudents} students)</span>
                  </div>
                  <div className="text-xs text-outline mt-xs">Low CGPA, overdue fees, or backlog — at least one factor</div>
                </div>
                <div className="flex gap-lg text-right">
                  <div>
                    <div className="text-lg font-extrabold text-warning">{d.atRisk}</div>
                    <div className="text-[10px] text-outline uppercase tracking-wider">At-risk</div>
                  </div>
                  <div>
                    <div className="text-lg font-extrabold text-error">{d.critical}</div>
                    <div className="text-[10px] text-outline uppercase tracking-wider">Critical</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Open risk flags */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🔺 Open Flags ({open.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {open.length > 0 ? (
            open.map((f: any) => (
              <Link key={f.id} href={`/director/attention/${f.id}`} className="block px-lg py-md hover:bg-surface-container-low transition-colors">
                <div className="flex items-center gap-sm mb-xs flex-wrap">
                  <StatusBadge status={f.severity} />
                  <StatusBadge status={f.status} />
                  <span className="text-xs text-outline capitalize">{f.flag_type.replace(/_/g, " ")}</span>
                  {f.department && <span className="text-xs text-outline">· {f.department.name}</span>}
                </div>
                <div className="text-sm font-semibold text-on-surface">{f.title}</div>
                <div className="text-xs text-outline mt-xs">
                  {f.description}
                  {f.assignee && <> · assigned to {f.assignee.full_name} ({f.assignee.role})</>}
                </div>
              </Link>
            ))
          ) : (
            <div className="p-xl text-center text-sm text-outline">No critical institutional risks detected.</div>
          )}
        </div>
      </div>

      {/* Resolved history */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🗂️ Recently Resolved ({resolved.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {resolved.map((f: any) => (
            <Link key={f.id} href={`/director/attention/${f.id}`} className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
              <div>
                <div className="text-sm text-on-surface">{f.title}</div>
                <div className="text-xs text-outline">{f.department?.name || "Institution-wide"}</div>
              </div>
              <StatusBadge status={f.status} />
            </Link>
          ))}
          {resolved.length === 0 && <div className="p-xl text-center text-sm text-outline">No decisions processed yet.</div>}
        </div>
      </div>
          </>
        )}
      </StateView>

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Flag Manually"
        description="Create an Attention Center item for something the automated detection wouldn't catch."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating} aria-busy={creating || undefined}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </>
        }
      >
        <div className="space-y-md">
          <ErrorAlert error={error} />
          <FormField
            label="Flag Type"
            id="flag-type"
            type="select"
            value={form.flagType || ""}
            onChange={(v) => setForm({ ...form, flagType: v as ManualFlagParams["flagType"] })}
            options={FLAG_TYPE_OPTIONS}
            required
            error={fieldErrors["flag-type"]}
          />
          <FormField
            label="Severity"
            id="flag-severity"
            type="select"
            value={form.severity || "medium"}
            onChange={(v) => setForm({ ...form, severity: v as ManualFlagParams["severity"] })}
            options={SEVERITY_OPTIONS}
            required
          />
          <FormField
            label="Scope"
            id="flag-scope"
            type="select"
            value={form.scopeLevel || "institution"}
            onChange={(v) => setForm({ ...form, scopeLevel: v as ManualFlagParams["scopeLevel"] })}
            options={SCOPE_OPTIONS}
            required
          />
          <FormField label="Title" id="flag-title" value={form.title || ""} onChange={(v) => setForm({ ...form, title: v })} required error={fieldErrors["flag-title"]} />
          <FormField
            label="Description"
            id="flag-description"
            type="textarea"
            rows={3}
            value={form.description || ""}
            onChange={(v) => setForm({ ...form, description: v })}
            required
            error={fieldErrors["flag-description"]}
          />
        </div>
      </Modal>
    </div>
  );
}
