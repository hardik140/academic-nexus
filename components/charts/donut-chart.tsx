"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Legend } from "recharts";
import { ChartFigure } from "./chart-figure";

export interface DonutSlice {
  name: string;
  value: number;
  color: string;
}

export function DonutChart({ title, slices, centerLabel }: { title: string; slices: DonutSlice[]; centerLabel?: string }) {
  const total = slices.reduce((s, sl) => s + sl.value, 0);
  if (total === 0) {
    return <div className="p-xl text-center text-sm text-outline">No data available yet.</div>;
  }

  const caption = `${title}${centerLabel ? `: ${centerLabel}` : ""} (${slices.map((s) => `${s.name} ${s.value}`).join(", ")}).`;

  return (
    <ChartFigure caption={caption} table={{ columns: ["Segment", "Count"], rows: slices.map((s) => [s.name, s.value]) }}>
      <div className="relative h-[220px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart accessibilityLayer={false}>
            <Pie data={slices} dataKey="value" nameKey="name" innerRadius="60%" outerRadius="85%" paddingAngle={2} rootTabIndex={-1} isAnimationActive={false}>
              {slices.map((s, i) => (
                <Cell key={i} fill={s.color} />
              ))}
            </Pie>
            <Legend verticalAlign="bottom" height={36} />
          </PieChart>
        </ResponsiveContainer>
        {centerLabel && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ paddingBottom: 36 }}>
            <div className="text-2xl font-extrabold text-on-surface">{centerLabel}</div>
          </div>
        )}
      </div>
    </ChartFigure>
  );
}
