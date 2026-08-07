import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getCached } from "@/lib/cache";

export default async function HodDashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();

  // Get HOD's department
  const { data: department } = await supabase
    .from("departments")
    .select("*")
    .eq("hod_id", user.id)
    .single();

  const { faculty, courses } = await getCached(
    `dashboard:hod:${department?.id}:faculty-courses`,
    60,
    async () => {
      const [facultyRes, coursesRes] = await Promise.all([
        supabase.from("profiles").select("*").eq("role", "teacher").eq("department_id", department?.id || ""),
        supabase.from("courses").select("*").eq("department_id", department?.id || ""),
      ]);
      return { faculty: facultyRes.data, courses: coursesRes.data };
    }
  );

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">
          {department?.name || "Department"} — HOD Dashboard
        </h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Head of Department • {profile?.full_name}
        </p>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-3 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Faculty Members</div>
          <div className="text-3xl font-extrabold text-on-surface">{faculty?.length || 0}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Active Courses</div>
          <div className="text-3xl font-extrabold text-secondary">{courses?.length || 0}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Dept Code</div>
          <div className="text-3xl font-extrabold text-on-surface">{department?.code || "—"}</div>
        </div>
      </div>

      {/* Faculty List */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Faculty Members</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {faculty && faculty.length > 0 ? faculty.map((f: any) => (
            <div key={f.id} className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
              <div className="flex items-center gap-sm">
                <div className="w-8 h-8 rounded-full bg-secondary text-on-secondary flex items-center justify-center text-xs font-bold">
                  {f.full_name?.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
                </div>
                <div>
                  <div className="text-sm font-medium text-on-surface">{f.full_name}</div>
                  <div className="text-xs text-outline">{f.email}</div>
                </div>
              </div>
              <span className={`text-xs font-semibold px-sm py-xs rounded-full ${
                f.status === "active" ? "bg-success/10 text-success" : "bg-error/10 text-error"
              }`}>{f.status}</span>
            </div>
          )) : (
            <div className="p-xl text-center text-sm text-outline">No faculty members assigned to this department.</div>
          )}
        </div>
      </div>
    </div>
  );
}
