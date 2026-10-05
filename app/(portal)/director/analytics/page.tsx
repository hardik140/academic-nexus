import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getCachedWriteBehind } from "@/lib/cache";
import { assertRead } from "@/lib/read-result-server";

export default async function DirectorAnalytics() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: viewerProfile, error: viewerProfileError } = await supabase
    .from("profiles")
    .select("college_id")
    .eq("id", user.id)
    .single();
  assertRead(viewerProfileError);

  // The views themselves now refresh every 15 min (scheduled via QStash),
  // so this is a second, finer cache layer on top of that.
  const { attendance, fees, enrollment, placement, deptHealth, facultyCount } = await getCachedWriteBehind(
    `analytics:director:${viewerProfile?.college_id}:mv`,
    60,
    async () => {
      const [attRes, feeRes, enrollRes, placeRes, deptHealthRes, facultyRes] = await Promise.all([
        supabase.from("mv_attendance_summary").select("*"),
        supabase.from("mv_fee_summary").select("*").single(),
        supabase.from("mv_department_enrollment").select("*").order("total_students", { ascending: false }),
        supabase.from("mv_placement_summary").select("*").single(),
        supabase.from("mv_department_health").select("*"),
        supabase.from("profiles").select("*", { count: "exact", head: true }).in("role", ["teacher", "hod"]),
      ]);
      for (const res of [attRes, feeRes, enrollRes, placeRes, deptHealthRes, facultyRes]) assertRead(res.error);
      return {
        attendance: attRes.data || [],
        fees: feeRes.data,
        enrollment: enrollRes.data || [],
        placement: placeRes.data,
        deptHealth: deptHealthRes.data || [],
        facultyCount: facultyRes.count || 0,
      };
    }
  );

  const totalStudentsForRetention = enrollment.reduce((s, d) => s + (d.total_students || 0), 0);
  const activeStudentsForRetention = enrollment.reduce((s, d) => s + (d.active_students || 0), 0);
  const retentionPct = totalStudentsForRetention > 0 ? Math.round((activeStudentsForRetention / totalStudentsForRetention) * 1000) / 10 : null;

  const withBacklog = deptHealth.filter((d: any) => d.backlog_rate != null);
  const institutionBacklogRate = withBacklog.length
    ? Math.round((withBacklog.reduce((s: number, d: any) => s + d.backlog_rate, 0) / withBacklog.length) * 10) / 10
    : null;

  const facultyStudentRatio = facultyCount > 0 && activeStudentsForRetention > 0 ? Math.round(activeStudentsForRetention / facultyCount) : null;

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between gap-md flex-wrap">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Analytics</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Institutional KPIs from pre-computed materialized views</p>
        </div>
        <a href="/director/departments/performance" className="text-xs font-medium text-secondary hover:underline">
          Department Heatmap →
        </a>
      </div>

      {/* Institution-wide health signals */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Retention Rate</div>
          {retentionPct != null ? (
            <div className={`text-3xl font-extrabold ${retentionPct >= 90 ? "text-success" : retentionPct >= 75 ? "text-warning" : "text-error"}`}>
              {retentionPct}%
            </div>
          ) : (
            <div className="text-sm text-outline">Insufficient data</div>
          )}
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Backlog Rate</div>
          {institutionBacklogRate != null ? (
            <div className={`text-3xl font-extrabold ${institutionBacklogRate <= 10 ? "text-success" : institutionBacklogRate <= 20 ? "text-warning" : "text-error"}`}>
              {institutionBacklogRate}%
            </div>
          ) : (
            <div className="text-sm text-outline">Insufficient data</div>
          )}
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Faculty : Student Ratio</div>
          {facultyStudentRatio != null ? (
            <div className="text-3xl font-extrabold text-on-surface">1:{facultyStudentRatio}</div>
          ) : (
            <div className="text-sm text-outline">Insufficient data</div>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Total Enrolled</div>
          <div className="text-3xl font-extrabold text-on-surface">
            {enrollment.reduce((s, d) => s + (d.total_students || 0), 0)}
          </div>
          <div className="text-xs text-outline mt-xs">{enrollment.length} departments</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Collection Rate</div>
          <div className={`text-3xl font-extrabold ${(fees?.collection_pct || 0) >= 80 ? "text-success" : "text-warning"}`}>
            {fees?.collection_pct || 0}%
          </div>
          <div className="text-xs text-outline mt-xs">₹{((fees?.total_collected || 0) / 100000).toFixed(1)}L collected</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Students Placed</div>
          <div className="text-3xl font-extrabold text-secondary">{placement?.total_placed || 0}</div>
          <div className="text-xs text-outline mt-xs">{placement?.total_companies || 0} companies</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Avg Package</div>
          <div className="text-3xl font-extrabold text-success">₹{placement?.avg_package || 0}L</div>
          <div className="text-xs text-outline mt-xs">Max: ₹{placement?.max_package || 0}L</div>
        </div>
      </div>

      {/* Department Enrollment */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Department-wise Enrollment</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {enrollment.map((dept: any) => {
            const maxStudents = Math.max(...enrollment.map((d: any) => d.total_students || 1));
            return (
              <div key={dept.department_id} className="px-lg py-md">
                <div className="flex items-center justify-between mb-sm">
                  <div>
                    <span className="text-sm font-semibold text-on-surface">{dept.department_code}</span>
                    <span className="text-xs text-outline ml-sm">{dept.department_name}</span>
                  </div>
                  <div className="flex items-center gap-md text-xs">
                    <span className="text-on-surface font-semibold">{dept.active_students} active</span>
                    <span className="text-outline">CGPA {dept.avg_cgpa || "—"}</span>
                  </div>
                </div>
                <div className="h-2 bg-surface-container-high rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-secondary"
                    style={{ width: `${(dept.total_students / maxStudents) * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
          {enrollment.length === 0 && (
            <div className="p-xl text-center text-sm text-outline">
              Analytics views are empty. Refresh the materialized views after adding data.
            </div>
          )}
        </div>
      </div>

      {/* Attendance by Course */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Attendance Rates by Course</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-low text-on-surface-variant">
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Course</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Present</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Absent</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Attendance %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {attendance.map((a: any) => (
                <tr key={a.course_id} className="hover:bg-surface-container-low transition-colors">
                  <td className="px-lg py-md">
                    <span className="font-mono text-secondary font-semibold">{a.course_code}</span>
                    <span className="text-xs text-outline ml-sm">{a.course_name}</span>
                  </td>
                  <td className="px-lg py-md text-success">{a.present_count}</td>
                  <td className="px-lg py-md text-error">{a.absent_count}</td>
                  <td className="px-lg py-md">
                    <span className={`text-sm font-bold ${(a.attendance_pct || 0) >= 75 ? "text-success" : "text-error"}`}>
                      {a.attendance_pct || 0}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
