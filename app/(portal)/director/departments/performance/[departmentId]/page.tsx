"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/modal";
import { getDepartmentDetail } from "../actions";

const FUNNEL_STAGES: { key: string; label: string }[] = [
  { key: "not_placed_count", label: "Not Placed" },
  { key: "eligible_count", label: "Eligible" },
  { key: "applied_count", label: "Applied" },
  { key: "shortlisted_count", label: "Shortlisted" },
  { key: "selected_count", label: "Selected" },
  { key: "placed_count", label: "Placed" },
];

export default function DepartmentExecutiveDetail() {
  const params = useParams();
  const router = useRouter();
  const departmentId = params.departmentId as string;
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDepartmentDetail(departmentId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load department."));
  }, [departmentId]);

  if (error) {
    return <div className="p-xl text-center text-sm text-error">{error}</div>;
  }
  if (!data) {
    return <div className="p-xl text-center text-sm text-outline">Loading...</div>;
  }

  const { department, health, funnel, openRisks } = data;

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <button type="button" onClick={() => router.push("/director/departments/performance")} className="text-sm text-secondary hover:underline">
        ← Back to Department Performance
      </button>

      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">{department.name}</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          {department.code} · HOD: {department.profiles?.full_name || "Unassigned"}
        </p>
      </div>

      {/* Scorecard */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-md">
        {[
          { label: "Students", value: health?.total_students ?? "—", suffix: "" },
          { label: "Avg CGPA", value: health?.avg_cgpa ?? "—", suffix: "" },
          { label: "Attendance", value: health?.attendance_pct ?? "—", suffix: health?.attendance_pct != null ? "%" : "" },
          { label: "Backlog Rate", value: health?.backlog_rate ?? "—", suffix: health?.backlog_rate != null ? "%" : "" },
          { label: "Placement Rate", value: health?.placement_rate ?? "—", suffix: health?.placement_rate != null ? "%" : "" },
        ].map((kpi) => (
          <div key={kpi.label} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
            <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">{kpi.label}</div>
            <div className="text-2xl font-extrabold text-on-surface">
              {kpi.value}
              {kpi.suffix}
            </div>
          </div>
        ))}
      </div>

      {/* Open risks for this department */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">🚨 Open Risks ({openRisks.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {openRisks.length > 0 ? (
            openRisks.map((r: any) => (
              <Link key={r.id} href={`/director/attention/${r.id}`} className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
                <span className="text-sm text-on-surface">{r.title}</span>
                <StatusBadge status={r.severity} />
              </Link>
            ))
          ) : (
            <div className="p-xl text-center text-sm text-outline">No open risks in this department.</div>
          )}
        </div>
      </div>

      {/* Placement funnel snippet */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface">🎯 Placement Funnel</h2>
          <Link href="/director/placements/funnel" className="text-xs font-medium text-secondary hover:underline">
            Full Placement Command Center →
          </Link>
        </div>
        {funnel ? (
          <div className="grid grid-cols-3 lg:grid-cols-6 gap-md p-lg">
            {FUNNEL_STAGES.map((stage) => (
              <div key={stage.key} className="text-center">
                <div className="text-2xl font-extrabold text-on-surface">{funnel[stage.key] ?? 0}</div>
                <div className="text-[10px] text-outline uppercase tracking-wider mt-xs">{stage.label}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-xl text-center text-sm text-outline">No placement data available yet.</div>
        )}
      </div>
    </div>
  );
}
