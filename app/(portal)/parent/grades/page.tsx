import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function ParentGrades() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("email").eq("id", user.id).single();

  const { data: children } = await supabase
    .from("students")
    .select("id, cgpa, profiles:user_id(full_name)")
    .eq("parent_email", profile?.email || "");

  const child = (children || [])[0];

  const { data: marks } = child
    ? await supabase.from("marks").select("*, courses(name, code)").eq("student_id", child.id).order("created_at", { ascending: false })
    : { data: [] };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Grades</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          {child ? `${(child.profiles as any)?.full_name}'s exam performance` : "Linked child's exam performance"}
        </p>
      </div>

      {child ? (
        <>
          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
            <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-xs">Current CGPA</div>
            <div className="text-4xl font-extrabold text-secondary">{child.cgpa || "—"}</div>
          </div>

          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
            <div className="px-lg py-md border-b border-outline-variant">
              <h2 className="text-sm font-bold text-on-surface">Marks by Course</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-container-low text-on-surface-variant">
                    <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Course</th>
                    <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Exam</th>
                    <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Marks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant">
                  {(marks || []).map((m: any) => {
                    const pct = m.max_marks > 0 ? (m.obtained_marks / m.max_marks) * 100 : 0;
                    return (
                      <tr key={m.id} className="hover:bg-surface-container-low transition-colors">
                        <td className="px-lg py-md font-medium text-on-surface">{m.courses?.code} — {m.courses?.name}</td>
                        <td className="px-lg py-md text-on-surface-variant capitalize">{m.exam_type.replace(/_/g, " ")}</td>
                        <td className="px-lg py-md">
                          <span className={`font-semibold ${pct >= 50 ? "text-success" : "text-error"}`}>
                            {m.obtained_marks}/{m.max_marks}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {(marks || []).length === 0 && (
                    <tr><td colSpan={3} className="px-lg py-xl text-center text-outline">No marks recorded yet.</td></tr>
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
