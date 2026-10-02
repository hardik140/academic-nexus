"use client";

import Link from "next/link";
import { ChartFigure } from "./chart-figure";

export interface HeatmapRow {
  departmentId: string;
  departmentName: string;
  departmentCode: string;
  attendancePct: number | null;
  backlogRate: number | null;
  feeCollectionPct: number | null;
  placementRate: number | null;
  openRiskCount: number;
}

interface Metric {
  key: keyof Pick<HeatmapRow, "attendancePct" | "backlogRate" | "feeCollectionPct" | "placementRate">;
  label: string;
  /** Higher-is-better metrics use ascending bands; backlog is inverted (lower is better). */
  invert?: boolean;
}

const METRICS: Metric[] = [
  { key: "attendancePct", label: "Attendance" },
  { key: "backlogRate", label: "Backlog", invert: true },
  { key: "feeCollectionPct", label: "Fee Collection" },
  { key: "placementRate", label: "Placement" },
];

function bandColor(value: number | null, invert = false): string {
  if (value == null) return "bg-surface-container-high text-outline";
  const effective = invert ? 100 - value : value;
  // The status container pairs StatusBadge and Alert use: the tinted text on a
  // /15 tint fell under 4.5:1 contrast (M7 axe).
  if (effective >= 75) return "bg-success-container text-on-success-container";
  if (effective >= 50) return "bg-warning-container text-on-warning-container";
  return "bg-error-container text-on-error-container";
}

/**
 * Bespoke heatmap grid — Recharts has no heatmap primitive, so this is a
 * plain CSS grid of color-coded cells. Each cell shows the real value or
 * "—" (never a fabricated placeholder) when that metric has no data for a
 * department. A plain data-table fallback list isn't a separate view here:
 * every row already reads left-to-right as department → metric values,
 * which doubles as the accessible/tabular form. So ChartFigure leaves the
 * grid exposed, and its caption spells out what the colours mean.
 */
export function DepartmentHeatmapGrid({ rows }: { rows: HeatmapRow[] }) {
  if (rows.length === 0) {
    return <div className="p-xl text-center text-sm text-outline">No department data available yet.</div>;
  }

  const caption = `Department performance for ${rows.length} ${rows.length === 1 ? "department" : "departments"}: attendance, backlog, fee collection and placement percentages, and open risks. Bands: 75% or more is good, 50 to 74% needs attention, under 50% is poor; for backlog, lower is better.`;

  return (
    <ChartFigure caption={caption} accessibleVisual>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-separate border-spacing-x-0 border-spacing-y-xs">
          <thead>
            <tr>
              <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider text-outline">Department</th>
              {METRICS.map((m) => (
                <th key={m.key} className="text-center px-md py-sm font-semibold text-xs uppercase tracking-wider text-outline">
                  {m.label}
                </th>
              ))}
              <th className="text-center px-md py-sm font-semibold text-xs uppercase tracking-wider text-outline">Open Risks</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.departmentId}>
                <td className="px-lg py-sm">
                  <Link href={`/director/departments/performance/${row.departmentId}`} className="text-sm font-semibold text-on-surface hover:text-secondary hover:underline">
                    {row.departmentName}
                  </Link>
                  <div className="text-xs text-outline">{row.departmentCode}</div>
                </td>
                {METRICS.map((m) => {
                  const value = row[m.key];
                  return (
                    <td key={m.key} className="px-md py-sm text-center">
                      <span className={`inline-flex items-center justify-center min-w-[64px] rounded-lg px-sm py-xs text-sm font-bold ${bandColor(value, m.invert)}`}>
                        {value == null ? "—" : `${value}%`}
                      </span>
                    </td>
                  );
                })}
                <td className="px-md py-sm text-center">
                  <span className={`inline-flex items-center justify-center min-w-[32px] rounded-full px-sm py-xs text-xs font-bold ${row.openRiskCount > 0 ? "bg-error/15 text-error" : "bg-surface-container-high text-outline"}`}>
                    {row.openRiskCount}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartFigure>
  );
}
