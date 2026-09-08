"use client";

import { useEffect, useState } from "react";
import { DepartmentHeatmapGrid, type HeatmapRow } from "@/components/charts/department-heatmap-grid";
import { listDepartmentHealth } from "./actions";

export default function DepartmentPerformancePage() {
  const [rows, setRows] = useState<HeatmapRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listDepartmentHealth().then((data) => {
      setRows(data);
      setLoading(false);
    });
  }, []);

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Department Performance</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Cross-department comparison — green/yellow/red bands per metric. Click a department for the full picture.
        </p>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        {loading ? (
          <div className="p-xl text-center text-sm text-outline">Loading...</div>
        ) : (
          <DepartmentHeatmapGrid rows={rows} />
        )}
      </div>
    </div>
  );
}
