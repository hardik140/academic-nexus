import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function DirectorFaculty() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [facultyRes, coursesRes] = await Promise.all([
    supabase.from("profiles").select("*, departments:department_id(name, code)").in("role", ["teacher", "hod"]).order("full_name"),
    supabase.from("courses").select("id, instructor_id"),
  ]);

  const faculty = facultyRes.data || [];
  const courseCounts: Record<string, number> = {};
  (coursesRes.data || []).forEach((c: any) => {
    if (!c.instructor_id) return;
    courseCounts[c.instructor_id] = (courseCounts[c.instructor_id] || 0) + 1;
  });

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Faculty</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Institution-wide faculty directory and workload</p>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-low text-on-surface-variant">
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Name</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Role</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Department</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Courses</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {faculty.map((f: any) => (
                <tr key={f.id} className="hover:bg-surface-container-low transition-colors">
                  <td className="px-lg py-md">
                    <div className="flex items-center gap-sm">
                      <div className="w-7 h-7 rounded-full bg-secondary/10 text-secondary flex items-center justify-center text-[10px] font-bold">
                        {f.full_name?.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
                      </div>
                      <span className="font-medium text-on-surface">{f.full_name}</span>
                    </div>
                  </td>
                  <td className="px-lg py-md capitalize text-on-surface-variant">{f.role}</td>
                  <td className="px-lg py-md text-on-surface-variant">{(f.departments as any)?.name || "—"}</td>
                  <td className="px-lg py-md text-on-surface">{courseCounts[f.id] || 0}</td>
                  <td className="px-lg py-md">
                    <span className={`text-xs font-semibold px-sm py-xs rounded-full ${f.status === "active" ? "bg-success/10 text-success" : "bg-error/10 text-error"}`}>{f.status}</span>
                  </td>
                </tr>
              ))}
              {faculty.length === 0 && (
                <tr><td colSpan={5} className="px-lg py-xl text-center text-outline">No faculty records found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
