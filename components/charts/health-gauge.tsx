"use client";

import { RadialBarChart, RadialBar, PolarAngleAxis, ResponsiveContainer } from "recharts";

interface HealthGaugeProps {
  score: number | null;
  label?: string;
  /** How many of the possible sub-scores actually contributed — shown as a caveat so a score isn't misread as comprehensive when it's really an average of one or two signals. */
  contributingCount?: number;
  possibleCount?: number;
  /** Explanation shown when score is null — override the institution-Command-Center-specific default for other callers (e.g. a student's own score, computed live with no cron involved). */
  emptyStateMessage?: string;
}

function scoreColor(score: number): string {
  if (score >= 75) return "var(--color-success)";
  if (score >= 50) return "var(--color-warning)";
  return "var(--color-error)";
}

/**
 * Institution Health Score gauge — the one bespoke Recharts visualization
 * in the Command Center home. Renders "Insufficient data" instead of a
 * fabricated ring when score is null (e.g. before the first
 * snapshot-health-score cron run has ever executed for this college).
 */
export function HealthGauge({
  score,
  label = "Institution Health",
  contributingCount,
  possibleCount,
  emptyStateMessage = "No overall score yet — either the snapshot job hasn't run for this college, or none of the underlying metrics have real data to compute from.",
}: HealthGaugeProps) {
  if (score == null) {
    return (
      <div className="flex flex-col items-center justify-center h-[200px] text-center">
        <div className="text-sm text-outline">Insufficient data</div>
        <div className="text-xs text-outline mt-xs max-w-[220px]">{emptyStateMessage}</div>
      </div>
    );
  }

  const data = [{ name: label, value: score, fill: scoreColor(score) }];

  return (
    <div className="relative h-[200px]">
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          innerRadius="70%"
          outerRadius="100%"
          data={data}
          startAngle={90}
          endAngle={-270}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
          <RadialBar background dataKey="value" cornerRadius={12} angleAxisId={0} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <div className="text-4xl font-extrabold text-on-surface">{score}</div>
        <div className="text-xs text-outline">out of 100</div>
        {contributingCount != null && possibleCount != null && contributingCount < possibleCount && (
          <div className="text-[10px] text-outline mt-xs px-md text-center">
            Based on {contributingCount} of {possibleCount} signals
          </div>
        )}
      </div>
    </div>
  );
}
