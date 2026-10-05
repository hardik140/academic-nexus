import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getCachedWriteBehind } from "@/lib/cache";
import { assertRead } from "@/lib/read-result-server";
import { NO_MATCH_ID } from "@/lib/read-result";

export default async function HodReports() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: dept, error: deptError } = await supabase
    .from("departments")
    .select("id, name, code")
    .eq("hod_id", user.id)
    .single();
  assertRead(deptError);

  const deptId = dept?.id || "";

  const { enrollment, attendance, backlogs } = await getCachedWriteBehind(
    `reports:hod:${deptId}:mv`,
    60,
    async () => {
      const [enrollRes, attendanceRes, coursesRes] = await Promise.all([
        supabase.from("mv_department_enrollment").select("*").eq("department_id", deptId || NO_MATCH_ID).maybeSingle(),
        supabase.from("mv_attendance_summary").select("*").eq("department_id", deptId || NO_MATCH_ID),
        supabase.from("courses").select("id, name, code").eq("department_id", deptId || NO_MATCH_ID),
      ]);
      for (const res of [enrollRes, attendanceRes, coursesRes]) assertRead(res.error);
      const courseIds = (coursesRes.data || []).map((c) => c.id);

      // Enrollment hangs off the offering (047), and its student_id points at
      // students(id) rather than profiles(id) — the old profiles join silently
      // matched nothing.
      const deptOfferingsRes = courseIds.length
        ? await supabase.from("course_offerings").select("id").in("course_id", courseIds)
        : { data: [], error: null };
      assertRead(deptOfferingsRes.error);
      const deptOfferings = deptOfferingsRes.data;
      const offeringIds = ((deptOfferings as { id: string }[] | null) || []).map((o) => o.id);

      const backlogsRes = offeringIds.length
        ? await supabase
            .from("course_enrollments")
            .select(
              "*, course_offerings:offering_id(courses:course_id(name, code), sections:section_id(name)), students:student_id(profiles:user_id(full_name))"
            )
            .in("offering_id", offeringIds)
            .eq("status", "failed")
        : { data: [], error: null };
      assertRead(backlogsRes.error);
      const backlogs = backlogsRes.data;

      return { enrollment: enrollRes.data, attendance: attendanceRes.data || [], backlogs: backlogs || [] };
    }
  );

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Department Reports</h1>
        <p className="text-sm text-on-surface-variant mt-xs">{dept?.name || "Department"} — result analysis, attendance audit &amp; backlogs</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Total Students</div>
          <div className="text-2xl font-extrabold text-on-surface">{enrollment?.total_students || 0}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Active Students</div>
          <div className="text-2xl font-extrabold text-success">{enrollment?.active_students || 0}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Avg CGPA</div>
          <div className="text-2xl font-extrabold text-secondary">{enrollment?.avg_cgpa || "—"}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Backlogs</div>
          <div className="text-2xl font-extrabold text-error">{(backlogs || []).length}</div>
        </div>
      </div>

      {/* Attendance Audit */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">📊 Attendance Audit — By Course</h2>
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
              {attendance.length === 0 && (
                <tr><td colSpan={4} className="px-lg py-xl text-center text-outline">No attendance data yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Backlogs */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">📉 Backlog Students</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {(backlogs || []).length > 0 ? (backlogs || []).map((b: any) => (
            <div key={b.id} className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
              <div>
                <div className="text-sm font-medium text-on-surface">{(b.profiles as any)?.full_name}</div>
                <div className="text-xs text-outline">{(b.courses as any)?.code} — {(b.courses as any)?.name}</div>
              </div>
              <span className="text-xs font-semibold px-sm py-xs rounded-full bg-error/10 text-error">Failed</span>
            </div>
          )) : (
            <div className="p-xl text-center text-sm text-outline">🎉 No backlogs in this department.</div>
          )}
        </div>
      </div>
    </div>
  );
}
