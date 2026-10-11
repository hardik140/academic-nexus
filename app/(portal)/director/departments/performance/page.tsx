"use client";

import { DepartmentHeatmapGrid, type HeatmapRow } from "@/components/charts/department-heatmap-grid";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { listDepartmentHealth } from "./actions";

export default function DepartmentPerformancePage() {
  // A failed load is an error with Try again — never a page stuck on
  // "Loading..." (owner decision D5).
  const health = useAsyncResource<HeatmapRow[]>(() => listDepartmentHealth(), []);

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Department Performance</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Cross-department comparison — green/yellow/red bands per metric. Click a department for the full picture.
        </p>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <StateView state={health} loadingLabel="Loading department performance…" empty={{ title: "No departments yet" }}>
          {(rows) => <DepartmentHeatmapGrid rows={rows} />}
        </StateView>
      </div>
    </div>
  );
}
