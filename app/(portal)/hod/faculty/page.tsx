import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function HodFaculty() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("college_id, department_id").eq("id", user.id).single();

  const { data: faculty } = await supabase
    .from("profiles")
    .select("*, departments:department_id(name)")
    .eq("college_id", profile?.college_id || "")
    .eq("department_id", profile?.department_id || "")
    .in("role", ["teacher", "hod"])
    .order("full_name");

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Faculty Members</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Faculty in your department</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md">
        {(faculty || []).map((f: any) => (
          <div key={f.id} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:shadow-md transition-all">
            <div className="flex items-center gap-sm mb-md">
              <div className="w-10 h-10 rounded-full bg-secondary/10 text-secondary flex items-center justify-center text-sm font-bold">
                {f.full_name?.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
              </div>
              <div>
                <div className="text-sm font-bold text-on-surface">{f.full_name}</div>
                <div className="text-xs text-outline">{f.email}</div>
              </div>
            </div>
            <div className="space-y-xs text-xs text-outline">
              <div>📱 {f.phone || "—"}</div>
              <div>🏢 {(f.departments as any)?.name || "—"}</div>
              <div className="flex items-center gap-sm">
                <span className={`font-semibold px-sm py-xs rounded-full capitalize ${
                  f.status === "active" ? "bg-success/10 text-success" : "bg-warning/10 text-warning"
                }`}>{f.status}</span>
                <span className="font-semibold px-sm py-xs rounded-full bg-secondary/10 text-secondary capitalize">{f.role}</span>
              </div>
            </div>
          </div>
        ))}
        {(!faculty || faculty.length === 0) && (
          <div className="col-span-full bg-surface-container-lowest border border-outline-variant rounded-2xl p-xl text-center text-sm text-outline">
            No faculty members found in your department.
          </div>
        )}
      </div>
    </div>
  );
}
