"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
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
  const [showCreate, setShowCreate] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [error, setError] = useState<FeedbackError | string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [form, setForm] = useState<Partial<CreateGoalParams>>({ trackingMode: "auto" });
  const [creating, setCreating] = useState(false);
  // Inline actions on a goal: which one is running, and how the last one ended.
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Goals and who may own them. A failed load is an error, never "No
  // strategic goals yet." (owner decision D5).
  const goalsResource = useAsyncResource(async () => {
    const [goals, owners] = await Promise.all([listGoals(), listGoalOwnerCandidates()]);
    return { goals: goals as any[], owners: owners as any[] };
  }, []);
  const goals = goalsResource.data?.goals ?? [];
  const owners = goalsResource.data?.owners ?? [];

  /** Runs one inline action: one at a time, its failure said, the list refreshed after. */
  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    if (busy) return false;
    setBusy(key);
    setActionError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      goalsResource.reload();
      return true;
    } catch (e) {
      setActionError(await toFeedbackError(e, "The change was not saved."));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const handleCreate = async () => {
    if (creating) return;
    // Say which fields are missing, on the fields themselves and in a summary.
    const missing: Record<string, string> = {};
    if (!form.title?.trim()) missing["goal-title"] = "Enter a title.";
    if (form.trackingMode === "auto" && !form.metricKey) missing["goal-metric"] = "Pick a metric for an auto-tracked goal.";
    if (!form.metricLabel?.trim()) missing["goal-metric-label"] = "Enter a label for the metric.";
    if (!form.targetValue) missing["goal-target"] = "Enter the target value.";
    if (!form.startDate) missing["goal-start"] = "Choose a start date.";
    if (!form.targetDate) missing["goal-target-date"] = "Choose a target date.";
    setFieldErrors(missing);
    const firstMissing = Object.keys(missing)[0];
    if (firstMissing) {
      setError(`Fill in ${Object.keys(missing).length === 1 ? "the highlighted field" : "the highlighted fields"} to create the goal.`);
      document.getElementById(firstMissing)?.focus();
      return;
    }
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      await createGoal(form as CreateGoalParams);
      setShowCreate(false);
      setNotice(`Goal "${form.title}" created.`);
      setForm({ trackingMode: "auto" });
      goalsResource.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to create goal."));
    } finally {
      setCreating(false);
    }
  };

  const handleAddMilestone = async (goalId: string) => {
    if (!milestoneTitle.trim()) return;
    if (await act(`milestone-${goalId}`, () => addMilestone({ goalId, title: milestoneTitle.trim() }), "Milestone added.")) {
      setMilestoneTitle("");
    }
  };

  return (
    <div className="space-y-lg">
      <div className="flex items-start justify-between gap-md">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Strategic Goals</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Institutional targets, tracked against real data where possible</p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setError(null);
            setFieldErrors({});
            setShowCreate(true);
          }}
        >
          + New Goal
        </Button>
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      <ErrorAlert error={actionError} />

      <StateView state={goalsResource} isEmpty={() => false} loadingLabel="Loading strategic goals…" empty={{ title: "No strategic goals yet" }}>
        {() => (
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
                    <span className={`text-[10px] font-semibold px-sm py-xs rounded-full uppercase tracking-wider ${g.tracking_mode === "auto" ? "bg-info-container text-on-info-container" : "bg-surface-container-high text-on-surface-variant"}`}>
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
                        className={`h-full rounded-full ${pct >= 100 ? "bg-success" : pct >= 50 ? "bg-secondary" : "bg-warning"}`}
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
                        disabled={busy !== null}
                        aria-busy={busy === `progress-${g.id}` || undefined}
                        onClick={async () => {
                          const v = prompt("New current value:", g.current_value ?? "");
                          if (v != null && !isNaN(Number(v))) {
                            await act(`progress-${g.id}`, () => updateGoal({ goalId: g.id, currentValue: Number(v) }), "Progress updated.");
                          }
                        }}
                      >
                        Update Progress
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      aria-busy={busy === `achieved-${g.id}` || undefined}
                      onClick={() => act(`achieved-${g.id}`, () => updateGoal({ goalId: g.id, status: "achieved" }), `"${g.title}" marked achieved.`)}
                    >
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
                        disabled={busy !== null}
                        onChange={(e) =>
                          act(`toggle-${m.id}`, () => toggleMilestone(m.id, e.target.checked), e.target.checked ? "Milestone done." : "Milestone reopened.")
                        }
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
                    <Button size="sm" onClick={() => handleAddMilestone(g.id)} disabled={busy !== null} aria-busy={busy === `milestone-${g.id}` || undefined}>
                      Add
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
        )}
      </StateView>

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
            <Button onClick={handleCreate} disabled={creating} aria-busy={creating || undefined}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </>
        }
      >
        <div className="space-y-md">
          <ErrorAlert error={error} />
          <FormField label="Title" id="goal-title" value={form.title || ""} onChange={(v) => setForm({ ...form, title: v })} required error={fieldErrors["goal-title"]} />
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
              error={fieldErrors["goal-metric"]}
            />
          )}
          <FormField label="Metric Label" id="goal-metric-label" value={form.metricLabel || ""} onChange={(v) => setForm({ ...form, metricLabel: v })} placeholder="e.g. Placement Rate" required error={fieldErrors["goal-metric-label"]} />
          <FormField label="Unit (optional)" id="goal-metric-unit" value={form.metricUnit || ""} onChange={(v) => setForm({ ...form, metricUnit: v })} placeholder="%" />
          <FormField
            label="Target Value"
            id="goal-target"
            type="number"
            value={form.targetValue ?? ""}
            onChange={(v) => setForm({ ...form, targetValue: Number(v) })}
            required
            error={fieldErrors["goal-target"]}
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
            <FormField label="Start Date" id="goal-start" type="date" value={form.startDate || ""} onChange={(v) => setForm({ ...form, startDate: v })} required error={fieldErrors["goal-start"]} />
            <FormField label="Target Date" id="goal-target-date" type="date" value={form.targetDate || ""} onChange={(v) => setForm({ ...form, targetDate: v })} required error={fieldErrors["goal-target-date"]} />
          </div>
        </div>
      </Modal>
    </div>
  );
}
