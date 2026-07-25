import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function DirectorDashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();

  const [
    { count: totalStudents },
    { count: totalFaculty },
    { count: totalDepartments },
  ] = await Promise.all([
    supabase.from("profiles").select("*", { count: "exact", head: true }).eq("role", "student"),
    supabase.from("profiles").select("*", { count: "exact", head: true }).eq("role", "teacher"),
    supabase.from("departments").select("*", { count: "exact", head: true }),
  ]);

  const { data: departments } = await supabase
    .from("departments")
    .select("*, profiles:hod_id(full_name)")
    .order("name");

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">
          Institutional Overview
        </h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Director&apos;s 360° View • {profile?.full_name}
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-md">
        {[
          { label: "Total Enrollment", value: totalStudents || 0, icon: "🎓" },
          { label: "Faculty Strength", value: totalFaculty || 0, icon: "👨‍🏫" },
          { label: "Departments", value: totalDepartments || 0, icon: "🏢" },
        ].map((kpi) => (
          <div key={kpi.label} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
            <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">{kpi.label}</div>
            <div className="text-3xl font-extrabold text-on-surface">{kpi.value.toLocaleString()}</div>
            <span className="text-xl mt-sm inline-block">{kpi.icon}</span>
          </div>
        ))}
      </div>

      {/* Departments Table */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Department Overview</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-low text-on-surface-variant">
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Department</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Code</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">HOD</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {departments && departments.length > 0 ? departments.map((dept: any) => (
                <tr key={dept.id} className="hover:bg-surface-container-low transition-colors">
                  <td className="px-lg py-md font-medium text-on-surface">{dept.name}</td>
                  <td className="px-lg py-md text-on-surface-variant">{dept.code}</td>
                  <td className="px-lg py-md text-on-surface-variant">{(dept.profiles as any)?.full_name || "—"}</td>
                </tr>
              )) : (
                <tr><td colSpan={3} className="px-lg py-xl text-center text-outline">No departments configured.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
