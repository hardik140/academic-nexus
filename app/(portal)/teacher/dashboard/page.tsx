import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function TeacherDashboard() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  // Fetch assigned courses
  const { data: courses } = await supabase
    .from("courses")
    .select("*")
    .eq("instructor_id", user.id);

  // Fetch today's attendance to mark
  const today = new Date().toISOString().split("T")[0];
  const { data: todayAttendance } = await supabase
    .from("attendance")
    .select("*, students:student_id(enrollment_number)")
    .eq("marked_by", user.id)
    .eq("date", today);

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">
          Welcome, {profile?.full_name?.split(" ")[0] || "Professor"} 👋
        </h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Faculty Dashboard • {today}
        </p>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">
            My Courses
          </div>
          <div className="text-3xl font-extrabold text-on-surface">
            {courses?.length || 0}
          </div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">
            Today&apos;s Entries
          </div>
          <div className="text-3xl font-extrabold text-secondary">
            {todayAttendance?.length || 0}
          </div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">
            Total Students
          </div>
          <div className="text-3xl font-extrabold text-on-surface">
            —
          </div>
          <div className="text-[11px] text-outline mt-xs">
            across all courses
          </div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">
            Avg Attendance
          </div>
          <div className="text-3xl font-extrabold text-success">
            —
          </div>
        </div>
      </div>

      {/* Courses Grid */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface">My Courses</h2>
          <a
            href="/teacher/attendance"
            className="text-xs font-medium text-secondary hover:underline"
          >
            Mark Attendance →
          </a>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md p-lg">
          {courses && courses.length > 0 ? (
            courses.map((course: any) => (
              <div
                key={course.id}
                className="bg-surface-container-low border border-outline-variant rounded-xl p-md hover:shadow-md transition-shadow"
              >
                <div className="flex items-center gap-sm mb-sm">
                  <span className="text-xl">📚</span>
                  <div>
                    <div className="text-sm font-bold text-on-surface">
                      {course.code}
                    </div>
                    <div className="text-xs text-outline">{course.name}</div>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-md pt-sm border-t border-outline-variant">
                  <span className="text-xs text-outline">
                    {course.credits} credits • Sem {course.semester}
                  </span>
                  <a
                    href={`/teacher/attendance?course=${course.id}`}
                    className="text-xs font-semibold text-secondary hover:underline"
                  >
                    Attendance
                  </a>
                </div>
              </div>
            ))
          ) : (
            <div className="col-span-full p-xl text-center text-sm text-outline">
              No courses assigned yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
