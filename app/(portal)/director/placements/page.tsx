import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { formatDate } from "@/lib/utils";

export default async function DirectorPlacements() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [summaryRes, placementsRes] = await Promise.all([
    supabase.from("mv_placement_summary").select("*").maybeSingle(),
    supabase.from("placements").select("*, students:student_id(enrollment_number, profiles:user_id(full_name), departments(name))").order("placement_date", { ascending: false }),
  ]);

  const summary = summaryRes.data;
  const placements = placementsRes.data || [];

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Placements</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Institution-wide placement outcomes</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Students Placed</div>
          <div className="text-2xl font-extrabold text-secondary">{summary?.total_placed || 0}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Companies</div>
          <div className="text-2xl font-extrabold text-on-surface">{summary?.total_companies || 0}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Avg Package</div>
          <div className="text-2xl font-extrabold text-success">₹{summary?.avg_package || 0}L</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Max Package</div>
          <div className="text-2xl font-extrabold text-success">₹{summary?.max_package || 0}L</div>
        </div>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Placement Records</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-low text-on-surface-variant">
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Student</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Department</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Company</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Role</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Package</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {placements.map((p: any) => (
                <tr key={p.id} className="hover:bg-surface-container-low transition-colors">
                  <td className="px-lg py-md font-medium text-on-surface">{(p.students as any)?.profiles?.full_name || "—"}</td>
                  <td className="px-lg py-md text-on-surface-variant">{(p.students as any)?.departments?.name || "—"}</td>
                  <td className="px-lg py-md text-on-surface">{p.company_name}</td>
                  <td className="px-lg py-md text-on-surface-variant">{p.role_title}</td>
                  <td className="px-lg py-md text-success font-semibold">{p.package_lpa ? `₹${p.package_lpa}L` : "—"}</td>
                  <td className="px-lg py-md">
                    <span className={`text-xs font-semibold px-sm py-xs rounded-full capitalize ${
                      p.status === "placed" || p.status === "joined" ? "bg-success/10 text-success" :
                      p.status === "declined" ? "bg-warning/10 text-warning" : "bg-error/10 text-error"
                    }`}>{p.status}</span>
                  </td>
                </tr>
              ))}
              {placements.length === 0 && (
                <tr><td colSpan={6} className="px-lg py-xl text-center text-outline">No placement records yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
