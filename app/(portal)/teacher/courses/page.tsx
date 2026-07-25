import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function TeacherCourses() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: courses } = await supabase
    .from("courses")
    .select("*, departments:department_id(name, code)")
    .eq("instructor_id", user.id)
    .order("code");

  // Fetch enrollment counts
  const courseIds = (courses || []).map((c: any) => c.id);
  const { data: enrollments } = courseIds.length > 0
    ? await supabase.from("course_enrollments").select("course_id").in("course_id", courseIds).eq("status", "enrolled")
    : { data: [] };

  const enrollCounts: Record<string, number> = {};
  (enrollments || []).forEach((e: any) => {
    enrollCounts[e.course_id] = (enrollCounts[e.course_id] || 0) + 1;
  });

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">My Courses</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Courses assigned to you this semester</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md">
        {(courses || []).map((c: any) => (
          <div key={c.id} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:shadow-md transition-all group">
            <div className="flex items-center justify-between mb-sm">
              <span className="text-xs font-bold text-secondary uppercase tracking-wider">{c.code}</span>
              <span className={`text-xs font-semibold px-sm py-xs rounded-full capitalize ${
                c.status === "active" ? "bg-success/10 text-success" : "bg-warning/10 text-warning"
              }`}>{c.status}</span>
            </div>
            <h3 className="text-sm font-bold text-on-surface mb-xs group-hover:text-secondary transition-colors">{c.name}</h3>
            <div className="space-y-xs text-xs text-outline">
              <div>🏢 {(c.departments as any)?.name || "—"}</div>
              <div>📚 {c.credits} credits • Semester {c.semester} • {c.type}</div>
              <div>👥 {enrollCounts[c.id] || 0} students enrolled</div>
            </div>
          </div>
        ))}
        {(!courses || courses.length === 0) && (
          <div className="col-span-full bg-surface-container-lowest border border-outline-variant rounded-2xl p-xl text-center text-sm text-outline">
            No courses assigned. Contact admin for course assignments.
          </div>
        )}
      </div>
    </div>
  );
}
