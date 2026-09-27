import { getPlacementReports } from "./actions";

function BarRow({ label, count, max, sublabel }: { label: string; count: number; max: number; sublabel?: string }) {
  return (
    <div className="px-lg py-md">
      <div className="flex items-center justify-between mb-sm">
        <div>
          <span className="text-sm font-semibold text-on-surface">{label}</span>
          {sublabel && <span className="text-xs text-outline ml-sm">{sublabel}</span>}
        </div>
        <span className="text-sm font-bold text-on-surface">{count}</span>
      </div>
      <div className="h-2 bg-surface-container-high rounded-full overflow-hidden">
        <div
          className="h-full rounded-full bg-secondary"
          style={{ width: `${max > 0 ? (count / max) * 100 : 0}%` }}
        />
      </div>
    </div>
  );
}

export default async function PlacementCellReports() {
  const report = await getPlacementReports();

  const maxDept = Math.max(1, ...report.byDepartment.map((d) => d.count));
  const maxCompany = Math.max(1, ...report.byCompany.map((c) => c.count));
  const maxYear = Math.max(1, ...report.byYear.map((y) => y.count));
  const maxPackage = Math.max(1, ...report.packageDistribution.map((p) => p.count));

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Placement Reports</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Institution-wide placement performance</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Placement Rate</div>
          <div className="text-3xl font-extrabold text-secondary">{report.placementRate}%</div>
          <div className="text-xs text-outline mt-xs">{report.totalPlaced} of {report.totalStudents} students</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Students Placed</div>
          <div className="text-3xl font-extrabold text-success">{report.totalPlaced}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Companies Hiring</div>
          <div className="text-3xl font-extrabold text-on-surface">{report.byCompany.length}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-lg">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">Department-wise Placement</h2>
          </div>
          <div className="divide-y divide-outline-variant">
            {report.byDepartment.length === 0 ? (
              <div className="p-xl text-center text-sm text-outline">No placement data yet.</div>
            ) : (
              report.byDepartment.map((d) => <BarRow key={d.name} label={d.name} count={d.count} max={maxDept} />)
            )}
          </div>
        </div>

        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">Company-wise Placement</h2>
          </div>
          <div className="divide-y divide-outline-variant">
            {report.byCompany.length === 0 ? (
              <div className="p-xl text-center text-sm text-outline">No placement data yet.</div>
            ) : (
              report.byCompany.map((c) => <BarRow key={c.name} label={c.name} count={c.count} max={maxCompany} />)
            )}
          </div>
        </div>

        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">Package Distribution</h2>
          </div>
          <div className="divide-y divide-outline-variant">
            {report.packageDistribution.map((p) => (
              <BarRow key={p.range} label={p.range} count={p.count} max={maxPackage} />
            ))}
          </div>
        </div>

        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">Year-wise Placement</h2>
          </div>
          <div className="divide-y divide-outline-variant">
            {report.byYear.length === 0 ? (
              <div className="p-xl text-center text-sm text-outline">No placement data yet.</div>
            ) : (
              report.byYear.map((y) => <BarRow key={y.year} label={`Batch ${y.year}`} count={y.count} max={maxYear} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
