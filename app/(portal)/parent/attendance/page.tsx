import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { formatDate, formatPct } from "@/lib/utils";

export default async function ParentAttendance() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("email").eq("id", user.id).single();

  const { data: children } = await supabase
    .from("students")
    .select("id, profiles:user_id(full_name)")
    .eq("parent_email", profile?.email || "");

  const child = (children || [])[0];

  const { data: records } = child
    ? await supabase
        .from("attendance")
        .select("*, courses(name, code)")
        .eq("student_id", child.id)
        .order("date", { ascending: false })
        .limit(50)
    : { data: [] };

  const present = (records || []).filter((r: any) => r.status === "present" || r.status === "late").length;
  const total = (records || []).length;
  const pct = total > 0 ? (present / total) * 100 : 0;

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Attendance</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          {child ? `${(child.profiles as any)?.full_name}'s attendance record` : "Linked child's attendance record"}
        </p>
      </div>

      {child ? (
        <>
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
            <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-xs">Overall Attendance</div>
            <div className={`text-4xl font-extrabold ${pct >= 75 ? "text-success" : "text-error"}`}>{formatPct(pct, 0)}</div>
            <div className="text-xs text-outline mt-xs">{present} present out of {total} classes</div>
          </div>

          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
            <div className="px-lg py-md border-b border-outline-variant">
              <h2 className="text-sm font-bold text-on-surface">Recent Records</h2>
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
                  {(records || []).map((r: any) => (
                    <tr key={r.id} className="hover:bg-surface-container-low transition-colors">
                      <td className="px-lg py-md text-on-surface-variant">{formatDate(r.date)}</td>
                      <td className="px-lg py-md font-medium text-on-surface">{r.courses?.code} — {r.courses?.name}</td>
                      <td className="px-lg py-md">
                        <span className={`text-xs font-semibold px-sm py-xs rounded-full capitalize ${
                          r.status === "present" ? "bg-success/10 text-success" :
                          r.status === "late" ? "bg-warning/10 text-warning" :
                          r.status === "excused" ? "bg-info/10 text-info" : "bg-error/10 text-error"
                        }`}>{r.status}</span>
                      </td>
                    </tr>
                  ))}
                  {(records || []).length === 0 && (
                    <tr><td colSpan={3} className="px-lg py-xl text-center text-outline">No attendance records yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-2xl text-center text-sm text-outline">
          No linked child found for this account.
        </div>
      )}
    </div>
  );
}
