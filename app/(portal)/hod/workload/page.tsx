import { listDepartmentFacultyWorkload } from "../faculty/actions";

const STANDARD_WEEKLY_LOAD = 16;

function workloadColor(pct: number) {
  if (pct > 120) return "text-error";
  if (pct > 100) return "text-warning";
  if (pct < 50) return "text-outline";
  return "text-success";
}

export default async function HodWorkload() {
  const workload = await listDepartmentFacultyWorkload();

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Faculty Workload</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Weekly teaching periods against a standard load of {STANDARD_WEEKLY_LOAD}/week — courses/labs/tutorials scheduled via the timetable only. Mentoring, project supervision, and committee work aren&apos;t tracked in the system yet, so they aren&apos;t reflected here.
        </p>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Department Faculty ({workload.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {workload.length > 0 ? workload.map((f) => (
            <div key={f.id} className="flex items-center justify-between px-lg py-md">
              <div>
                <div className="text-sm font-medium text-on-surface">{f.fullName}</div>
                <div className="text-xs text-outline mt-xs">{f.courseCount} course{f.courseCount !== 1 ? "s" : ""} · {f.weeklyPeriods} periods/week</div>
              </div>
              <div className={`text-xl font-extrabold ${workloadColor(f.workloadPct)}`}>{f.workloadPct}%</div>
            </div>
          )) : (
            <div className="p-xl text-center text-sm text-outline">No faculty members found in your department.</div>
          )}
        </div>
      </div>
    </div>
  );
}
