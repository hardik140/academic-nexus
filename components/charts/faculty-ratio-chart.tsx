"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { ChartFigure } from "./chart-figure";

function asRatio(students: number | null): string {
  return students == null ? "—" : `1:${students}`;
}

/** The forecast's faculty : student ratio, today and under the scenario. Nothing is drawn when neither is known. */
export function FacultyRatioChart({ current, projected }: { current: number | null; projected: number | null }) {
  if (current == null && projected == null) return null;

  const data = [
    { label: "Current", ratio: current },
    { label: "Projected", ratio: projected },
  ];
  const caption = `Faculty to student ratio: currently ${asRatio(current)}, projected ${asRatio(projected)}.`;

  return (
    <ChartFigure caption={caption} table={{ columns: ["Scenario", "Faculty : Student"], rows: data.map((d) => [d.label, asRatio(d.ratio)]) }}>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} accessibilityLayer={false}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-outline-variant)" />
          <XAxis dataKey="label" stroke="var(--color-outline)" fontSize={12} />
          <YAxis stroke="var(--color-outline)" fontSize={12} />
          <Tooltip isAnimationActive={false} />
          <Line type="monotone" dataKey="ratio" stroke="var(--color-secondary)" strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}
