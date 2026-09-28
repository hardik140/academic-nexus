import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getCached } from "@/lib/cache";

export default async function AdminRoles() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: viewerProfile } = await supabase
    .from("profiles")
    .select("college_id")
    .eq("id", user.id)
    .single();

  // This data changes essentially never — a 5 minute TTL is safe.
  // `permissions` is a global catalog (no college_id column); `role_permissions`
  // is college-scoped, so its cache key must be too.
  const { permissions, rolePerms } = await getCached(
    `admin:roles:${viewerProfile?.college_id}:matrix`,
    300,
    async () => {
      const [permissionsRes, rolePermsRes] = await Promise.all([
        supabase.from("permissions").select("*").order("module").order("name"),
        supabase.from("role_permissions").select("*, permissions(name, description)"),
      ]);
      return { permissions: permissionsRes.data, rolePerms: rolePermsRes.data };
    }
  );

  const roles = ["student", "teacher", "hod", "finance", "director", "admin", "warden"];
  const modules = [...new Set((permissions || []).map((p: any) => p.module))];

  // Build role → permission set
  const rolePermMap: Record<string, Set<string>> = {};
  roles.forEach(r => { rolePermMap[r] = new Set(); });
  (rolePerms || []).forEach((rp: any) => {
    if (rolePermMap[rp.role]) rolePermMap[rp.role].add(rp.permission_id);
  });

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Roles & Permissions</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Configure what each role can access in the system</p>
      </div>

      {modules.map((mod) => (
        <div key={mod} className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface capitalize">📦 {mod} Module</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-container-low text-on-surface-variant">
                  <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider min-w-[180px]">Permission</th>
                  {roles.map(r => (
                    <th key={r} className="text-center px-sm py-sm font-semibold text-xs uppercase tracking-wider">{r}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {(permissions || []).filter((p: any) => p.module === mod).map((p: any) => (
                  <tr key={p.id} className="hover:bg-surface-container-low transition-colors">
                    <td className="px-lg py-md">
                      <div className="text-sm font-medium text-on-surface">{p.name}</div>
                      <div className="text-[10px] text-outline">{p.description}</div>
                    </td>
                    {roles.map(r => (
                      <td key={r} className="text-center px-sm py-md">
                        {rolePermMap[r]?.has(p.id) ? (
                          <span className="text-success text-base">✓</span>
                        ) : (
                          <span className="text-outline-variant text-base">·</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {(!permissions || permissions.length === 0) && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-xl text-center text-sm text-outline">
          No permissions configured. Run the seed migration to populate defaults.
        </div>
      )}
    </div>
  );
}
