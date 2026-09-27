"use client";

import { useEffect, useState } from "react";
import { PlacementFunnelChart } from "@/components/charts/placement-funnel-chart";
import { StatusBadge } from "@/components/ui/modal";
import { getInstitutionPlacementFunnel, listDriveFunnels } from "./actions";

export default function PlacementCommandCenter() {
  const [totals, setTotals] = useState<any>(null);
  const [departments, setDepartments] = useState<any[]>([]);
  const [drives, setDrives] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getInstitutionPlacementFunnel(), listDriveFunnels()]).then(([funnel, driveData]) => {
      setTotals(funnel.totals);
      setDepartments(funnel.departments);
      setDrives(driveData);
      setLoading(false);
    });
  }, []);

  const stages = totals
    ? [
        { name: "Eligible", value: totals.eligible_count },
        { name: "Applied", value: totals.applied_count },
        { name: "Shortlisted", value: totals.shortlisted_count },
        { name: "Selected", value: totals.selected_count },
        { name: "Placed", value: totals.placed_count },
      ]
    : [];

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Placement Command Center</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Institution-wide placement funnel, from eligible to placed</p>
      </div>

      {loading ? (
        <div className="p-xl text-center text-sm text-outline">Loading...</div>
      ) : (
        <>
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg">
            <PlacementFunnelChart stages={stages} />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
            <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
              <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Total Students</div>
              <div className="text-2xl font-extrabold text-on-surface">{totals.total_students}</div>
            </div>
            <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
              <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Placed</div>
              <div className="text-2xl font-extrabold text-success">{totals.placed_count}</div>
            </div>
            <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
              <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Not Placed</div>
              <div className="text-2xl font-extrabold text-warning">{totals.not_placed_count}</div>
            </div>
            <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
              <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Placement Rate</div>
              <div className="text-2xl font-extrabold text-on-surface">
                {totals.total_students > 0 ? Math.round((totals.placed_count / totals.total_students) * 1000) / 10 : 0}%
              </div>
            </div>
          </div>

          {/* Department breakdown */}
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
            <div className="px-lg py-md border-b border-outline-variant">
              <h2 className="text-sm font-bold text-on-surface">Department Breakdown</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-container-low text-on-surface-variant">
                    <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Department</th>
                    <th className="text-right px-md py-sm font-semibold text-xs uppercase tracking-wider">Applied</th>
                    <th className="text-right px-md py-sm font-semibold text-xs uppercase tracking-wider">Shortlisted</th>
                    <th className="text-right px-md py-sm font-semibold text-xs uppercase tracking-wider">Selected</th>
                    <th className="text-right px-lg py-sm font-semibold text-xs uppercase tracking-wider">Placed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant">
                  {departments.map((d: any) => (
                    <tr key={d.department_id}>
                      <td className="px-lg py-md font-medium text-on-surface">{d.department_name}</td>
                      <td className="px-md py-md text-right">{d.applied_count}</td>
                      <td className="px-md py-md text-right">{d.shortlisted_count}</td>
                      <td className="px-md py-md text-right">{d.selected_count}</td>
                      <td className="px-lg py-md text-right font-semibold text-success">{d.placed_count}</td>
                    </tr>
                  ))}
                  {departments.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-lg py-xl text-center text-outline">
                        No department placement data available yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Active drives */}
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
            <div className="px-lg py-md border-b border-outline-variant">
              <h2 className="text-sm font-bold text-on-surface">Drive-wise Funnel</h2>
            </div>
            <div className="divide-y divide-outline-variant">
              {drives.length > 0 ? (
                drives.map((d) => (
                  <div key={d.id} className="px-lg py-md flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-on-surface">
                        {d.companyName} — {d.jobRole}
                      </div>
                      <div className="text-xs text-outline mt-xs">
                        {d.applied} applied · {d.shortlisted} shortlisted · {d.interview} interview · {d.selected} selected · {d.rejected} rejected
                      </div>
                    </div>
                    <StatusBadge status={d.status} />
                  </div>
                ))
              ) : (
                <div className="p-xl text-center text-sm text-outline">No placement drives yet.</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
