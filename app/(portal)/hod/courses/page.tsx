import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function HodCourses() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("college_id, department_id").eq("id", user.id).single();

  const { data: courses } = await supabase
    .from("courses")
    .select("*, profiles:instructor_id(full_name)")
    .eq("department_id", profile?.department_id || "")
    .order("code");

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Department Courses</h1>
        <p className="text-sm text-on-surface-variant mt-xs">All courses under your department</p>
      </div>
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-low text-on-surface-variant">
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Code</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Course</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Instructor</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Credits</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Sem</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Type</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {(courses || []).map((c: any) => (
                <tr key={c.id} className="hover:bg-surface-container-low transition-colors">
                  <td className="px-lg py-md font-mono text-secondary font-semibold">{c.code}</td>
                  <td className="px-lg py-md font-medium text-on-surface">{c.name}</td>
                  <td className="px-lg py-md text-on-surface-variant">{(c.profiles as any)?.full_name || "TBA"}</td>
                  <td className="px-lg py-md">{c.credits}</td>
                  <td className="px-lg py-md">{c.semester}</td>
                  <td className="px-lg py-md capitalize text-on-surface-variant">{c.type}</td>
                  <td className="px-lg py-md">
                    <span className={`text-xs font-semibold px-sm py-xs rounded-full capitalize ${
                      c.status === "active" ? "bg-success/10 text-success" : "bg-warning/10 text-warning"
                    }`}>{c.status}</span>
                  </td>
                </tr>
              ))}
              {(!courses || courses.length === 0) && (
                <tr><td colSpan={7} className="px-lg py-xl text-center text-outline">No courses found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
