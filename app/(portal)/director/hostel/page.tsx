"use client";

import { DonutChart } from "@/components/charts/donut-chart";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { getHostelRollup } from "./actions";

export default function DirectorHostelRollup() {
  // A failed load is an error with Try again — never a page stuck on
  // "Loading..." (owner decision D5).
  const rollup = useAsyncResource(() => getHostelRollup(), []);
  const data: any = rollup.data;

  const slices = data
    ? [
        { name: "Occupied", value: data.totalOccupancy, color: "var(--color-secondary)" },
        { name: "Vacant", value: Math.max(0, data.totalCapacity - data.totalOccupancy), color: "var(--color-outline-variant)" },
      ]
    : [];

  return (
    <StateView state={rollup} isEmpty={(value) => value.blocks.length === 0 && value.pendingGatePasses === 0 && value.openComplaints === 0} loadingLabel="Loading the hostel overview…" empty={{ title: "No hostel data yet" }}>
      {() => (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Hostel Overview</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Institution-wide occupancy, gate passes, and maintenance — across every block</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-lg">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg">
          <h2 className="text-sm font-bold text-on-surface mb-md">Occupancy</h2>
          {data.totalCapacity > 0 ? (
            <DonutChart title="Hostel occupancy" slices={slices} centerLabel={`${data.occupancyPct}%`} />
          ) : (
            <div className="p-xl text-center text-sm text-outline">No hostel capacity data available yet.</div>
          )}
        </div>

        <div className="lg:col-span-2 grid grid-cols-2 gap-md content-start">
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
            <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Blocks</div>
            <div className="text-3xl font-extrabold text-on-surface">{data.totalBlocks}</div>
          </div>
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
            <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Occupied / Capacity</div>
            <div className="text-3xl font-extrabold text-secondary">
              {data.totalOccupancy}/{data.totalCapacity}
            </div>
          </div>
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
            <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Pending Gate Passes</div>
            <div className="text-3xl font-extrabold text-warning">{data.pendingGatePasses}</div>
          </div>
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
            <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Open Complaints</div>
            <div className="text-3xl font-extrabold text-error">{data.openComplaints}</div>
          </div>
        </div>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Block-wise Occupancy</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-low text-on-surface-variant">
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Block</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Type</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Status</th>
                <th className="text-right px-lg py-sm font-semibold text-xs uppercase tracking-wider">Occupancy</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {data.blocks.map((b: any) => (
                <tr key={b.id} className="hover:bg-surface-container-low transition-colors">
                  <td className="px-lg py-md font-medium text-on-surface">{b.name}</td>
                  <td className="px-lg py-md text-on-surface-variant capitalize">{b.type}</td>
                  <td className="px-lg py-md text-on-surface-variant capitalize">{b.status}</td>
                  <td className="px-lg py-md text-right">
                    {b.occupancyPct != null ? (
                      <span className={`font-bold ${b.occupancyPct > 95 ? "text-error" : b.occupancyPct > 85 ? "text-warning" : "text-success"}`}>
                        {b.occupancy}/{b.capacity} ({b.occupancyPct}%)
                      </span>
                    ) : (
                      <span className="text-outline">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {data.blocks.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-lg py-xl text-center text-outline">
                    No hostel blocks configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
      )}
    </StateView>
  );
}
