import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { formatDate } from "@/lib/utils";

export default async function AdminAuditLog() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: logs } = await supabase
    .from("audit_logs")
    .select("*, profiles:user_id(full_name, email, role)")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Audit Log</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Complete audit trail of all system actions</p>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">System Activity ({(logs || []).length} entries)</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-low text-on-surface-variant">
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Timestamp</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">User</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Role</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Action</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Table</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Record</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {(logs || []).map((log: any) => (
                <tr key={log.id} className="hover:bg-surface-container-low transition-colors">
                  <td className="px-lg py-md text-xs text-on-surface-variant font-mono">
                    {new Date(log.created_at).toLocaleString()}
                  </td>
                  <td className="px-lg py-md">
                    <div className="text-sm font-medium text-on-surface">{(log.profiles as any)?.full_name || "System"}</div>
                    <div className="text-[10px] text-outline">{(log.profiles as any)?.email}</div>
                  </td>
                  <td className="px-lg py-md">
                    <span className="text-xs font-semibold px-sm py-xs rounded-full bg-secondary/10 text-secondary capitalize">
                      {(log.profiles as any)?.role || "system"}
                    </span>
                  </td>
                  <td className="px-lg py-md font-medium text-on-surface">{log.action}</td>
                  <td className="px-lg py-md text-on-surface-variant font-mono text-xs">{log.table_name}</td>
                  <td className="px-lg py-md text-on-surface-variant text-xs font-mono">{log.record_id?.slice(0, 8) || "—"}</td>
                </tr>
              ))}
              {(!logs || logs.length === 0) && (
                <tr><td colSpan={6} className="px-lg py-xl text-center text-outline">No audit log entries recorded yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
