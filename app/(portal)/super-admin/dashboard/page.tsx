import { createClient } from "@/lib/supabase/server";
import { PLATFORM_COLLEGE_ID } from "@/lib/constants";

export default async function SuperAdminDashboardPage() {
  const supabase = await createClient();

  const [collegesRes, adminsRes, invitationsRes] = await Promise.all([
    supabase.from("colleges").select("id", { count: "exact", head: true }).neq("id", PLATFORM_COLLEGE_ID),
    supabase.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin"),
    supabase.from("invitations").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);

  const stats = [
    { label: "Colleges", value: collegesRes.count || 0, icon: "🏛️" },
    { label: "College Admins", value: adminsRes.count || 0, icon: "👤" },
    { label: "Pending Invitations", value: invitationsRes.count || 0, icon: "✉️" },
  ];

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Platform Overview</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Create colleges and invite their first Admin from the Colleges page.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-md">
        {stats.map((s) => (
          <div key={s.label} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
            <div className="text-2xl">{s.icon}</div>
            <div className="text-2xl font-extrabold text-on-surface mt-sm">{s.value}</div>
            <div className="text-xs text-outline uppercase tracking-wider mt-xs">{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
