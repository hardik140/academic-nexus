import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function AdminSettings() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("college_id").eq("id", user.id).single();
  const { data: college } = await supabase.from("colleges").select("*").eq("id", profile?.college_id || "").single();

  const fields: Array<[string, string | number | null | undefined]> = [
    ["Institution Name", college?.name],
    ["Code", college?.code],
    ["Domain", college?.domain],
    ["Accreditation", college?.accreditation],
    ["Established", college?.established_year],
    ["Email", college?.email],
    ["Phone", college?.phone],
    ["Website", college?.website],
    ["Address", college?.address],
    ["City", college?.city],
    ["State", college?.state],
    ["Country", college?.country],
  ];

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Settings</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Institution profile and configuration</p>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Institution Profile</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 divide-outline-variant">
          {fields.map(([label, value]) => (
            <div key={label} className="px-lg py-md border-b md:border-b-0 border-outline-variant">
              <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-xs">{label}</div>
              <div className="text-sm text-on-surface">{value || "—"}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-info/10 border border-info/20 text-on-surface-variant rounded-xl p-md text-xs">
        Editing is disabled for now — updating institution settings needs a reviewed RLS policy for the{" "}
        <code className="font-mono">colleges</code> table before it can be enabled safely.
      </div>
    </div>
  );
}
