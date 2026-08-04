import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function DirectorDepartments() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [deptRes, enrollRes] = await Promise.all([
    supabase.from("departments").select("*, profiles:hod_id(full_name)").order("name"),
    supabase.from("mv_department_enrollment").select("*"),
  ]);

  const departments = deptRes.data || [];
  const enrollmentByDept: Record<string, any> = {};
  (enrollRes.data || []).forEach((e: any) => { enrollmentByDept[e.department_id] = e; });

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Departments</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Institution-wide department overview</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md">
        {departments.map((d: any) => {
          const e = enrollmentByDept[d.id];
          return (
            <div key={d.id} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:shadow-md transition-all">
              <div className="flex items-center justify-between mb-md">
                <span className="font-mono text-sm font-bold text-secondary">{d.code}</span>
                <span className={`text-xs font-semibold px-sm py-xs rounded-full ${d.status === "active" ? "bg-success/10 text-success" : "bg-error/10 text-error"}`}>{d.status}</span>
              </div>
              <h3 className="text-sm font-bold text-on-surface mb-xs">{d.name}</h3>
              <p className="text-xs text-outline mb-md">HOD: {(d.profiles as any)?.full_name || "Unassigned"}</p>
              <div className="grid grid-cols-2 gap-sm text-xs">
                <div>
                  <div className="text-outline uppercase tracking-wider">Students</div>
                  <div className="font-bold text-on-surface">{e?.total_students || 0}</div>
                </div>
                <div>
                  <div className="text-outline uppercase tracking-wider">Avg CGPA</div>
                  <div className="font-bold text-on-surface">{e?.avg_cgpa || "—"}</div>
                </div>
              </div>
            </div>
          );
        })}
        {departments.length === 0 && (
          <div className="col-span-full p-xl text-center text-sm text-outline bg-surface-container-lowest border border-outline-variant rounded-2xl">
            No departments found.
          </div>
        )}
      </div>
    </div>
  );
}
