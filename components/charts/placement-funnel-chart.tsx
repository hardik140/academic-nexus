"use client";

import { FunnelChart, Funnel, Tooltip, LabelList, ResponsiveContainer, Cell } from "recharts";
import { ChartFigure } from "./chart-figure";

export interface FunnelStage {
  name: string;
  value: number;
}

const COLORS = [
  "var(--color-secondary)",
  "var(--color-info)",
  "var(--color-warning)",
  "#8b5cf6",
  "var(--color-success)",
];

export function PlacementFunnelChart({ stages }: { stages: FunnelStage[] }) {
  const nonZero = stages.filter((s) => s.value > 0);
  if (nonZero.length === 0) {
    return <div className="p-xl text-center text-sm text-outline">No placement funnel data available yet.</div>;
  }

  const first = stages[0];
  const last = stages[stages.length - 1];
  const caption = `Placement funnel in ${stages.length} stages, from ${first.name} (${first.value}) to ${last.name} (${last.value}).`;

  return (
    <ChartFigure caption={caption} table={{ columns: ["Stage", "Count"], rows: stages.map((s) => [s.name, s.value]) }}>
      <ResponsiveContainer width="100%" height={280}>
        <FunnelChart accessibilityLayer={false}>
          <Tooltip isAnimationActive={false} />
          {/* Never animated (Checkpoint 4). The animation flag used to be set,
              which forced a 1.5 s grow-in even under prefers-reduced-motion. */}
          <Funnel dataKey="value" data={stages} isAnimationActive={false}>
            <LabelList position="right" dataKey="name" fill="var(--color-on-surface)" stroke="none" />
            <LabelList position="center" dataKey="value" fill="#fff" stroke="none" />
            {stages.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Funnel>
        </FunnelChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}
