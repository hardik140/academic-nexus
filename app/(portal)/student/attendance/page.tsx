import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { formatDate, formatPct } from "@/lib/utils";
import { StatusBadge } from "@/components/ui/modal";
import { DEFAULT_QUERY_LIMIT } from "@/lib/constants";

export default async function StudentAttendance() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: student } = await supabase.from("students").select("id").eq("user_id", user.id).single();

  const { data: records } = await supabase
    .from("attendance")
    .select("*, course_offerings:offering_id(courses:course_id(name, code), sections:section_id(name))")
    .eq("student_id", student?.id || "")
    .order("date", { ascending: false })
    .limit(DEFAULT_QUERY_LIMIT);

  // Grouped per CLASS, not per course: a student retaking a course, or
  // taking two sections of one, has separate attendance in each and merging
  // them reports a percentage belonging to neither.
  const courseSummary: Record<string, { name: string; code: string; present: number; total: number }> = {};
  (records || []).forEach((r: any) => {
    const key = r.offering_id;
    const course = r.course_offerings?.courses;
    const section = r.course_offerings?.sections?.name;
    if (!courseSummary[key]) {
      courseSummary[key] = {
        name: section ? `${course?.name || ""} (${section})` : course?.name || "",
        code: course?.code || "",
        present: 0,
        total: 0,
      };
    }
    courseSummary[key].total++;
    if (r.status === "present" || r.status === "late") courseSummary[key].present++;
  });

  const summaries = Object.values(courseSummary);
  const overall = summaries.reduce((acc, s) => ({ present: acc.present + s.present, total: acc.total + s.total }), { present: 0, total: 0 });
  const overallPct = overall.total > 0 ? (overall.present / overall.total) * 100 : 0;

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Attendance Report</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Your attendance records across all courses</p>
      </div>

      {/* Overall Stat */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-xs">Overall Attendance</div>
            <div className={`text-4xl font-extrabold ${overallPct >= 75 ? "text-success" : "text-error"}`}>
              {formatPct(overallPct, 0)}
            </div>
            <div className="text-xs text-outline mt-xs">{overall.present} present out of {overall.total} classes</div>
            {overallPct < 75 && overall.total > 0 && (
              <div className="text-xs font-semibold text-error mt-sm bg-error/10 inline-block px-sm py-xs rounded-md">
                ⚠️ Below the 75% requirement
              </div>
            )}
          </div>
          <div className="w-24 h-24 relative">
            <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
              <circle cx="18" cy="18" r="16" fill="none" stroke="var(--color-surface-container-high)" strokeWidth="3" />
              <circle
                cx="18" cy="18" r="16" fill="none"
                stroke={overallPct >= 75 ? "var(--color-success)" : "var(--color-error)"}
                strokeWidth="3" strokeLinecap="round"
                strokeDasharray={`${(overallPct / 100) * 100.53} 100.53`}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className={`text-sm font-bold ${overallPct >= 75 ? "text-success" : "text-error"}`}>
                {formatPct(overallPct, 0)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Per-Course Breakdown */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">📊 Course-wise Attendance</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {summaries.length > 0 ? summaries.map((s) => {
            const pct = (s.present / s.total) * 100;
            return (
              <div key={s.code} className="px-lg py-md">
                <div className="flex items-center justify-between mb-sm">
                  <div>
                    <span className="text-sm font-semibold text-on-surface">{s.code}</span>
                    <span className="text-xs text-outline ml-sm">{s.name}</span>
                  </div>
                  <span className={`text-sm font-bold ${pct >= 75 ? "text-success" : "text-error"}`}>
                    {formatPct(pct, 0)}
                  </span>
                </div>
                <div className="h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${pct >= 75 ? "bg-success" : "bg-error"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="text-[10px] text-outline mt-xs">{s.present}/{s.total} classes</div>
              </div>
            );
          }) : (
            <div className="p-xl text-center text-sm text-outline">No attendance records yet.</div>
          )}
        </div>
      </div>

      {/* Recent Records */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🗓️ Recent Records</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-low text-on-surface-variant">
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Date</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Course</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {(records || []).slice(0, 20).map((r: any) => (
                <tr key={r.id} className="hover:bg-surface-container-low transition-colors">
                  <td className="px-lg py-md text-on-surface-variant">{formatDate(r.date)}</td>
                  <td className="px-lg py-md font-medium text-on-surface">{r.courses?.code} — {r.courses?.name}</td>
                  <td className="px-lg py-md"><StatusBadge status={r.status} /></td>
                </tr>
              ))}
              {(!records || records.length === 0) && (
                <tr><td colSpan={3} className="px-lg py-xl text-center text-outline">No records yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
