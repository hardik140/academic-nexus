"use client";

import { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Button, FormField } from "@/components/ui/modal";
import { computeScenario, getForecastBaseline, listSavedScenarios, saveForecastScenario, type ScenarioParams } from "./actions";

export default function ForecastSimulatorPage() {
  const [baseline, setBaseline] = useState<any>(null);
  const [assumptions, setAssumptions] = useState<ScenarioParams>({ enrollmentDelta: 0, facultyDelta: 0, feeCollectionDeltaPct: 0, placementTargetPct: null });
  const [result, setResult] = useState<any>(null);
  const [scenarioName, setScenarioName] = useState("");
  const [saved, setSaved] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [b, s] = await Promise.all([getForecastBaseline(), listSavedScenarios()]);
    setBaseline(b);
    setSaved(s);
  };

  useEffect(() => {
    load();
  }, []);

  const runScenario = async () => {
    const r = await computeScenario(assumptions);
    setResult(r);
  };

  const handleSave = async () => {
    if (!scenarioName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await saveForecastScenario({ name: scenarioName.trim(), assumptions });
      setScenarioName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save scenario.");
    } finally {
      setSaving(false);
    }
  };

  const ratioChartData = result
    ? [
        { label: "Current", ratio: result.projected.baselineFacultyStudentRatio },
        { label: "Projected", ratio: result.projected.facultyStudentRatio },
      ]
    : [];

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Forecast &amp; Scenario Simulator</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Deterministic, rule-based projections off real current metrics — labeled as estimates, not facts.
        </p>
      </div>

      <div className="bg-warning/10 border border-warning/20 rounded-xl p-md text-xs text-warning font-medium">
        ⚠️ These are proportional projections from today&apos;s data, not predictions or AI-generated forecasts. Assumptions are shown alongside every result.
      </div>

      {baseline && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg">
          <h2 className="text-sm font-bold text-on-surface mb-md">Current Baseline</h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-md text-sm">
            <div>
              <div className="text-xs text-outline uppercase tracking-wider">Students</div>
              <div className="text-xl font-extrabold text-on-surface">{baseline.totalStudents}</div>
            </div>
            <div>
              <div className="text-xs text-outline uppercase tracking-wider">Faculty</div>
              <div className="text-xl font-extrabold text-on-surface">{baseline.totalFaculty}</div>
            </div>
            <div>
              <div className="text-xs text-outline uppercase tracking-wider">Fee Collection</div>
              <div className="text-xl font-extrabold text-on-surface">{baseline.feeCollectionPct != null ? `${baseline.feeCollectionPct}%` : "—"}</div>
            </div>
            <div>
              <div className="text-xs text-outline uppercase tracking-wider">Placement Rate</div>
              <div className="text-xl font-extrabold text-on-surface">{baseline.placementRate != null ? `${baseline.placementRate}%` : "—"}</div>
            </div>
          </div>
        </div>
      )}

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg space-y-md">
        <h2 className="text-sm font-bold text-on-surface">Assumptions</h2>
        <div className="grid grid-cols-2 gap-md">
          <FormField
            label="Enrollment change (+/-)"
            id="assum-enrollment"
            type="number"
            value={assumptions.enrollmentDelta}
            onChange={(v) => setAssumptions({ ...assumptions, enrollmentDelta: Number(v) })}
          />
          <FormField
            label="Faculty hires (+/-)"
            id="assum-faculty"
            type="number"
            value={assumptions.facultyDelta}
            onChange={(v) => setAssumptions({ ...assumptions, facultyDelta: Number(v) })}
          />
          <FormField
            label="Fee collection change % (+/-)"
            id="assum-fee"
            type="number"
            value={assumptions.feeCollectionDeltaPct}
            onChange={(v) => setAssumptions({ ...assumptions, feeCollectionDeltaPct: Number(v) })}
          />
          <FormField
            label="Placement target % (optional)"
            id="assum-placement"
            type="number"
            value={assumptions.placementTargetPct ?? ""}
            onChange={(v) => setAssumptions({ ...assumptions, placementTargetPct: v ? Number(v) : null })}
          />
        </div>
        <Button onClick={runScenario}>Run Scenario</Button>
      </div>

      {result && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg space-y-md">
          <h2 className="text-sm font-bold text-on-surface">Projected Impact</h2>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
            <div>
              <div className="text-xs text-outline uppercase tracking-wider">Faculty : Student</div>
              <div className="text-xl font-extrabold text-on-surface">
                1:{result.projected.facultyStudentRatio ?? "—"}
                {result.projected.baselineFacultyStudentRatio != null && (
                  <span className="text-xs text-outline font-normal"> (was 1:{result.projected.baselineFacultyStudentRatio})</span>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs text-outline uppercase tracking-wider">Fee Collection</div>
              <div className="text-xl font-extrabold text-on-surface">{result.projected.feeCollectionPct != null ? `${result.projected.feeCollectionPct}%` : "—"}</div>
            </div>
            <div>
              <div className="text-xs text-outline uppercase tracking-wider">Hostel Occupancy</div>
              <div className="text-xl font-extrabold text-on-surface">{result.projected.hostelOccupancyPct != null ? `${result.projected.hostelOccupancyPct}%` : "—"}</div>
            </div>
            {result.projected.placementGapToTarget != null && (
              <div>
                <div className="text-xs text-outline uppercase tracking-wider">Gap to Placement Target</div>
                <div className={`text-xl font-extrabold ${result.projected.placementGapToTarget > 0 ? "text-warning" : "text-success"}`}>
                  {result.projected.placementGapToTarget > 0 ? "+" : ""}
                  {result.projected.placementGapToTarget} pts
                </div>
              </div>
            )}
          </div>

          {result.projected.hostelUptakeRateNote && <p className="text-xs text-outline italic">{result.projected.hostelUptakeRateNote}</p>}

          {ratioChartData.some((d) => d.ratio != null) && (
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={ratioChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-outline-variant)" />
                <XAxis dataKey="label" stroke="var(--color-outline)" fontSize={12} />
                <YAxis stroke="var(--color-outline)" fontSize={12} />
                <Tooltip />
                <Line type="monotone" dataKey="ratio" stroke="var(--color-secondary)" strokeWidth={2} dot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          )}

          <div className="flex items-end gap-sm pt-md border-t border-outline-variant">
            {error && <div className="text-xs text-error">{error}</div>}
            <div className="flex-1">
              <FormField label="Save this scenario as" id="scenario-name" value={scenarioName} onChange={setScenarioName} placeholder="e.g. +500 enrollment plan" />
            </div>
            <Button onClick={handleSave} disabled={saving || !scenarioName.trim()}>
              {saving ? "..." : "Save Scenario"}
            </Button>
          </div>
        </div>
      )}

      {saved.length > 0 && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">Saved Scenarios</h2>
          </div>
          <div className="divide-y divide-outline-variant">
            {saved.map((s) => (
              <div key={s.id} className="px-lg py-md">
                <div className="text-sm font-medium text-on-surface">{s.name}</div>
                <div className="text-xs text-outline mt-xs">{new Date(s.created_at).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
