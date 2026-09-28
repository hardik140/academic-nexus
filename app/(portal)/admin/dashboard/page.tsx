import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getCached } from "@/lib/cache";

export default async function AdminDashboard() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: viewerProfile } = await supabase
    .from("profiles")
    .select("college_id")
    .eq("id", user.id)
    .single();

  // Cache key is college-scoped — this table is multi-tenant, and a cached
  // count from one college must never be served to another's admin.
  const [
    totalStudents,
    totalTeachers,
    totalCourses,
    totalDepartments,
    pendingComplaints,
    pendingGatePasses,
  ] = await getCached(
    `dashboard:admin:${viewerProfile?.college_id}:counts`,
    60,
    async () => {
      const [
        { count: totalStudents },
        { count: totalTeachers },
        { count: totalCourses },
        { count: totalDepartments },
        { count: pendingComplaints },
        { count: pendingGatePasses },
      ] = await Promise.all([
        supabase.from("profiles").select("*", { count: "exact", head: true }).eq("role", "student"),
        supabase.from("profiles").select("*", { count: "exact", head: true }).eq("role", "teacher"),
        supabase.from("courses").select("*", { count: "exact", head: true }),
        supabase.from("departments").select("*", { count: "exact", head: true }),
        supabase.from("complaints").select("*", { count: "exact", head: true }).eq("status", "open"),
        supabase.from("gate_passes").select("*", { count: "exact", head: true }).eq("status", "pending"),
      ]);
      return [totalStudents, totalTeachers, totalCourses, totalDepartments, pendingComplaints, pendingGatePasses];
    }
  );

  // Recent audit logs
  const { data: recentLogs } = await supabase
    .from("audit_logs")
    .select("*, profiles:user_id(full_name)")
    .order("created_at", { ascending: false })
    .limit(8);

  const stats = [
    { label: "Total Students", value: totalStudents || 0, icon: "🎓", color: "bg-secondary/10 text-secondary" },
    { label: "Faculty Members", value: totalTeachers || 0, icon: "👨‍🏫", color: "bg-success/10 text-success" },
    { label: "Active Courses", value: totalCourses || 0, icon: "📚", color: "bg-info/10 text-info" },
    { label: "Departments", value: totalDepartments || 0, icon: "🏢", color: "bg-warning/10 text-warning" },
    { label: "Open Complaints", value: pendingComplaints || 0, icon: "🛠️", color: "bg-error/10 text-error" },
    { label: "Pending Gate Passes", value: pendingGatePasses || 0, icon: "🚪", color: "bg-tertiary-container text-on-tertiary-container" },
  ];

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">
          System Administration
        </h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Manage users, roles, departments, and system configuration
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-md">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm"
          >
            <div className="flex items-center justify-between mb-sm">
              <span className="text-xs font-semibold text-outline uppercase tracking-wider">
                {stat.label}
              </span>
              <span className={`text-xl p-xs rounded-lg ${stat.color}`}>
                {stat.icon}
              </span>
            </div>
            <div className="text-3xl font-extrabold text-on-surface">
              {stat.value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      {/* Quick Actions + Audit Log */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-md">
        {/* Quick Actions */}
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">Quick Actions</h2>
          </div>
          <div className="p-md space-y-sm">
            {[
              { label: "Add New User", href: "/admin/users?action=create", icon: "👤" },
              { label: "Create Department", href: "/admin/departments?action=create", icon: "🏢" },
              { label: "Add Course", href: "/admin/courses?action=create", icon: "📚" },
              { label: "Manage Roles", href: "/admin/roles", icon: "🔐" },
              { label: "View Audit Log", href: "/admin/audit", icon: "📜" },
              { label: "System Settings", href: "/admin/settings", icon: "⚙️" },
            ].map((action) => (
              <a
                key={action.href}
                href={action.href}
                className="flex items-center gap-sm px-md py-sm rounded-xl text-sm font-medium text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors"
              >
                <span>{action.icon}</span>
                <span>{action.label}</span>
              </a>
            ))}
          </div>
        </div>

        {/* Audit Log */}
        <div className="lg:col-span-2 bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
          <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
            <h2 className="text-sm font-bold text-on-surface">Recent Audit Log</h2>
            <a
              href="/admin/audit"
              className="text-xs font-medium text-secondary hover:underline"
            >
              View All →
            </a>
          </div>
          <div className="divide-y divide-outline-variant">
            {recentLogs && recentLogs.length > 0 ? (
              recentLogs.map((log: any) => (
                <div
                  key={log.id}
                  className="px-lg py-md hover:bg-surface-container-low transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-on-surface">
                      {log.action}
                    </span>
                    <span className="text-[10px] text-outline">
                      {new Date(log.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="text-xs text-outline mt-xs">
                    {(log.profiles as any)?.full_name || "System"} •{" "}
                    {log.table_name}
                  </div>
                </div>
              ))
            ) : (
              <div className="p-xl text-center text-sm text-outline">
                No audit log entries yet.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
