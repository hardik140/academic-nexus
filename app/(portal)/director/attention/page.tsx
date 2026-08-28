"use client";

import { useEffect, useState } from "react";
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
  const [open, setOpen] = useState<any[]>([]);
  const [resolved, setResolved] = useState<any[]>([]);
  const [studentRisk, setStudentRisk] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<Partial<ManualFlagParams>>({ severity: "medium", scopeLevel: "institution" });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [flags, risk] = await Promise.all([listRiskFlags(), getStudentRiskOverview()]);
    setOpen(flags.open);
    setResolved(flags.resolved);
    setStudentRisk(risk);
  };

  useEffect(() => {
    load();
  }, []);

  const handleCreate = async () => {
    if (!form.flagType || !form.severity || !form.scopeLevel || !form.title || !form.description) return;
    setCreating(true);
    setError(null);
    try {
      await createManualRiskFlag(form as ManualFlagParams);
      setShowCreate(false);
      setForm({ severity: "medium", scopeLevel: "institution" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create flag.");
    } finally {
      setCreating(false);
    }
  };

  const totalAtRisk = studentRisk.reduce((s, d) => s + d.atRisk, 0);
  const totalCritical = studentRisk.reduce((s, d) => s + d.critical, 0);

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-start justify-between gap-md">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Attention Required</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Exceptions, risks, and escalations that need your attention</p>
        </div>
        <Button variant="outline" onClick={() => setShowCreate(true)}>
          + Flag Manually
        </Button>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

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
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? "..." : "Create"}
            </Button>
          </>
        }
      >
        <div className="space-y-md">
          <FormField
            label="Flag Type"
            id="flag-type"
            type="select"
            value={form.flagType || ""}
            onChange={(v) => setForm({ ...form, flagType: v as ManualFlagParams["flagType"] })}
            options={FLAG_TYPE_OPTIONS}
            required
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
          <FormField label="Title" id="flag-title" value={form.title || ""} onChange={(v) => setForm({ ...form, title: v })} required />
          <FormField
            label="Description"
            id="flag-description"
            type="textarea"
            rows={3}
            value={form.description || ""}
            onChange={(v) => setForm({ ...form, description: v })}
            required
          />
        </div>
      </Modal>
    </div>
  );
}
