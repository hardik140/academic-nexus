import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function StudentCourses() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: enrollments } = await supabase
    .from("course_enrollments")
    .select("*, courses(id, name, code, credits, semester, type, department_id, departments:department_id(name), profiles:instructor_id(full_name))")
    .eq("student_id", user.id)
    .order("status");

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">My Courses</h1>
        <p className="text-sm text-on-surface-variant mt-xs">All enrolled, completed, and dropped courses</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md">
        {(enrollments || []).map((e: any) => {
          const course = e.courses;
          return (
            <div key={e.id} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:shadow-md transition-all">
              <div className="flex items-center justify-between mb-sm">
                <span className="text-xs font-bold text-secondary uppercase tracking-wider">{course?.code}</span>
                <span className={`text-xs font-semibold px-sm py-xs rounded-full capitalize ${
                  e.status === "enrolled" ? "bg-success/10 text-success" :
                  e.status === "completed" ? "bg-info/10 text-info" :
                  e.status === "dropped" ? "bg-error/10 text-error" : "bg-warning/10 text-warning"
                }`}>{e.status}</span>
              </div>
              <h3 className="text-sm font-bold text-on-surface mb-xs">{course?.name}</h3>
              <div className="space-y-xs text-xs text-outline">
                <div>📚 {course?.credits} credits • {course?.type} • Sem {course?.semester}</div>
                <div>🏢 {(course?.departments as any)?.name || "—"}</div>
                <div>👨‍🏫 {(course?.profiles as any)?.full_name || "TBA"}</div>
              </div>
              {e.grade && (
                <div className="mt-md pt-sm border-t border-outline-variant flex items-center justify-between">
                  <span className="text-xs text-outline">Grade</span>
                  <span className="text-sm font-bold text-secondary">{e.grade}</span>
                </div>
              )}
            </div>
          );
        })}
        {(!enrollments || enrollments.length === 0) && (
          <div className="col-span-full bg-surface-container-lowest border border-outline-variant rounded-2xl p-xl text-center text-sm text-outline">
            No course enrollments found. Contact your department admin.
          </div>
        )}
      </div>
    </div>
  );
}
