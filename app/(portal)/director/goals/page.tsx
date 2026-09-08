"use client";

import { useEffect, useState } from "react";
import { Button, FormField, Modal, StatusBadge } from "@/components/ui/modal";
import { addMilestone, createGoal, listGoalOwnerCandidates, listGoals, toggleMilestone, updateGoal, type CreateGoalParams } from "./actions";

const METRIC_OPTIONS = [
  { value: "placement_rate", label: "Placement Rate" },
  { value: "avg_cgpa", label: "Average CGPA" },
  { value: "attendance_pct", label: "Attendance %" },
  { value: "fee_collection_pct", label: "Fee Collection %" },
  { value: "hostel_occupancy_pct", label: "Hostel Occupancy %" },
];

function progressPct(baseline: number | null, current: number | null, target: number) {
  if (current == null) return null;
  const base = baseline ?? 0;
  if (target === base) return current >= target ? 100 : 0;
  const pct = ((current - base) / (target - base)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

export default function StrategicGoalsPage() {
  const [goals, setGoals] = useState<any[]>([]);
  const [owners, setOwners] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<CreateGoalParams>>({ trackingMode: "auto" });
  const [creating, setCreating] = useState(false);

  const load = async () => {
    const [g, o] = await Promise.all([listGoals(), listGoalOwnerCandidates()]);
    setGoals(g);
    setOwners(o);
  };

  useEffect(() => {
    load();
  }, []);

  const handleCreate = async () => {
    if (!form.title || !form.metricLabel || !form.targetValue || !form.startDate || !form.targetDate) return;
    if (form.trackingMode === "auto" && !form.metricKey) {
      setError("Pick a metric for an auto-tracked goal.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await createGoal(form as CreateGoalParams);
      setShowCreate(false);
      setForm({ trackingMode: "auto" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create goal.");
    } finally {
      setCreating(false);
    }
  };

  const handleAddMilestone = async (goalId: string) => {
    if (!milestoneTitle.trim()) return;
    await addMilestone({ goalId, title: milestoneTitle.trim() });
    setMilestoneTitle("");
    await load();
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-start justify-between gap-md">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Strategic Goals</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Institutional targets, tracked against real data where possible</p>
        </div>
        <Button variant="outline" onClick={() => setShowCreate(true)}>
          + New Goal
        </Button>
      </div>

      <div className="space-y-md">
        {goals.length === 0 && (
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-xl text-center text-sm text-outline">
            No strategic goals yet.
          </div>
        )}
        {goals.map((g: any) => {
          const pct = progressPct(g.baseline_value, g.current_value, g.target_value);
          return (
            <div key={g.id} className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg">
              <div className="flex items-start justify-between gap-md">
                <div className="flex-1">
                  <div className="flex items-center gap-sm mb-xs flex-wrap">
                    <StatusBadge status={g.status} />
                    <span className={`text-[10px] font-semibold px-sm py-xs rounded-full uppercase tracking-wider ${g.tracking_mode === "auto" ? "bg-info/10 text-info" : "bg-surface-container-high text-on-surface-variant"}`}>
                      {g.tracking_mode === "auto" ? "Auto-tracked" : "Manual"}
                    </span>
                    {g.department && <span className="text-xs text-outline">· {g.department.name}</span>}
                  </div>
                  <div className="text-sm font-bold text-on-surface">{g.title}</div>
                  {g.description && <p className="text-xs text-on-surface-variant mt-xs">{g.description}</p>}
                  <div className="text-xs text-outline mt-xs">
                    Owner: {g.owner?.full_name || "Unassigned"} · Target by {new Date(g.target_date).toLocaleDateString()}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-lg font-extrabold text-on-surface">
                    {g.current_value != null ? g.current_value : "—"}
                    {g.metric_unit || ""} <span className="text-xs text-outline font-normal">/ {g.target_value}{g.metric_unit || ""}</span>
                  </div>
                  <div className="text-[11px] text-outline">{g.metric_label}</div>
                </div>
              </div>

              <div className="mt-md">
                {pct != null ? (
                  <>
                    <div className="h-2 bg-surface-container-high rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-700 ${pct >= 100 ? "bg-success" : pct >= 50 ? "bg-secondary" : "bg-warning"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="text-[11px] text-outline mt-xs">{pct}% of the way to target</div>
                  </>
                ) : (
                  <div className="text-xs text-outline">Insufficient data to compute progress.</div>
                )}
              </div>

              <div className="flex items-center justify-between mt-md pt-md border-t border-outline-variant">
                <button
                  type="button"
                  className="text-xs font-medium text-secondary hover:underline"
                  onClick={() => setExpanded(expanded === g.id ? null : g.id)}
                >
                  {g.milestones?.length || 0} milestone{g.milestones?.length === 1 ? "" : "s"} {expanded === g.id ? "▲" : "▼"}
                </button>
                {g.status !== "achieved" && g.status !== "abandoned" && (
                  <div className="flex gap-xs">
                    {g.tracking_mode === "manual" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          const v = prompt("New current value:", g.current_value ?? "");
                          if (v != null && !isNaN(Number(v))) {
                            await updateGoal({ goalId: g.id, currentValue: Number(v) });
                            await load();
                          }
                        }}
                      >
                        Update Progress
                      </Button>
                    )}
                    <Button size="sm" onClick={async () => { await updateGoal({ goalId: g.id, status: "achieved" }); await load(); }}>
                      Mark Achieved
                    </Button>
                  </div>
                )}
              </div>

              {expanded === g.id && (
                <div className="mt-md pt-md border-t border-outline-variant space-y-sm">
                  {(g.milestones || []).map((m: any) => (
                    <label key={m.id} className="flex items-center gap-sm text-sm">
                      <input
                        type="checkbox"
                        checked={m.status === "done"}
                        onChange={async (e) => {
                          await toggleMilestone(m.id, e.target.checked);
                          await load();
                        }}
                        className="rounded"
                      />
                      <span className={m.status === "done" ? "line-through text-outline" : "text-on-surface"}>{m.title}</span>
                    </label>
                  ))}
                  <div className="flex gap-sm">
                    <input
                      value={milestoneTitle}
                      onChange={(e) => setMilestoneTitle(e.target.value)}
                      placeholder="Add a milestone..."
                      className="flex-1 bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm text-sm outline-none focus:ring-2 focus:ring-secondary"
                    />
                    <Button size="sm" onClick={() => handleAddMilestone(g.id)}>
                      Add
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="New Strategic Goal"
        size="lg"
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
          {error && <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>}
          <FormField label="Title" id="goal-title" value={form.title || ""} onChange={(v) => setForm({ ...form, title: v })} required />
          <FormField label="Description" id="goal-description" type="textarea" rows={2} value={form.description || ""} onChange={(v) => setForm({ ...form, description: v })} />
          <FormField
            label="Tracking Mode"
            id="goal-tracking-mode"
            type="select"
            value={form.trackingMode || "auto"}
            onChange={(v) => setForm({ ...form, trackingMode: v as "auto" | "manual" })}
            options={[
              { value: "auto", label: "Auto (computed from real data)" },
              { value: "manual", label: "Manual (director-reported)" },
            ]}
            required
          />
          {form.trackingMode === "auto" && (
            <FormField
              label="Metric"
              id="goal-metric"
              type="select"
              value={form.metricKey || ""}
              onChange={(v) => setForm({ ...form, metricKey: v as CreateGoalParams["metricKey"] })}
              options={METRIC_OPTIONS}
              required
            />
          )}
          <FormField label="Metric Label" id="goal-metric-label" value={form.metricLabel || ""} onChange={(v) => setForm({ ...form, metricLabel: v })} placeholder="e.g. Placement Rate" required />
          <FormField label="Unit (optional)" id="goal-metric-unit" value={form.metricUnit || ""} onChange={(v) => setForm({ ...form, metricUnit: v })} placeholder="%" />
          <FormField
            label="Target Value"
            id="goal-target"
            type="number"
            value={form.targetValue ?? ""}
            onChange={(v) => setForm({ ...form, targetValue: Number(v) })}
            required
          />
          <FormField
            label="Owner"
            id="goal-owner"
            type="select"
            value={form.ownerId || ""}
            onChange={(v) => setForm({ ...form, ownerId: v })}
            options={owners.map((o) => ({ value: o.id, label: `${o.full_name} (${o.role})` }))}
          />
          <div className="grid grid-cols-2 gap-md">
            <FormField label="Start Date" id="goal-start" type="date" value={form.startDate || ""} onChange={(v) => setForm({ ...form, startDate: v })} required />
            <FormField label="Target Date" id="goal-target-date" type="date" value={form.targetDate || ""} onChange={(v) => setForm({ ...form, targetDate: v })} required />
          </div>
        </div>
      </Modal>
    </div>
  );
}
