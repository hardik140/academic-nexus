import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { formatDate } from "@/lib/utils";

export default async function StudentSchedule() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: student } = await supabase
    .from("students")
    .select("id, department_id")
    .eq("user_id", user.id)
    .single();

  // Fetch enrolled courses with timetable
  const { data: enrollments } = await supabase
    .from("course_enrollments")
    .select("*, courses(id, name, code, credits, instructor_id, profiles:instructor_id(full_name))")
    .eq("student_id", user.id)
    .eq("status", "enrolled");

  // Fetch timetable slots
  const { data: slots } = await supabase
    .from("timetable_slots")
    .select("*, courses(name, code)")
    .eq("college_id", (await supabase.from("profiles").select("college_id").eq("id", user.id).single()).data?.college_id || "")
    .order("day_of_week")
    .order("start_time");

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const groupedSlots: Record<number, any[]> = {};
  (slots || []).forEach((slot: any) => {
    if (!groupedSlots[slot.day_of_week]) groupedSlots[slot.day_of_week] = [];
    groupedSlots[slot.day_of_week].push(slot);
  });

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">
          Class Schedule
        </h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Your weekly timetable and enrolled courses
        </p>
      </div>

      {/* Weekly Timetable */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Weekly Timetable</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {[1, 2, 3, 4, 5, 6].map((day) => (
            <div key={day} className="px-lg py-md">
              <div className="text-xs font-bold text-secondary uppercase tracking-wider mb-sm">
                {dayNames[day]}
              </div>
              {groupedSlots[day] && groupedSlots[day].length > 0 ? (
                <div className="flex flex-wrap gap-sm">
                  {groupedSlots[day].map((slot: any) => (
                    <div
                      key={slot.id}
                      className="bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm"
                    >
                      <div className="text-sm font-semibold text-on-surface">
                        {slot.courses?.code} — {slot.courses?.name}
                      </div>
                      <div className="text-xs text-outline mt-xs">
                        {slot.start_time?.slice(0, 5)} – {slot.end_time?.slice(0, 5)}
                        {slot.room && ` • Room ${slot.room}`}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-outline italic">No classes scheduled</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Enrolled Courses */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Enrolled Courses</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-low text-on-surface-variant">
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Code</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Course</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Credits</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Instructor</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {enrollments && enrollments.length > 0 ? enrollments.map((e: any) => (
                <tr key={e.id} className="hover:bg-surface-container-low transition-colors">
                  <td className="px-lg py-md font-mono text-secondary font-semibold">{e.courses?.code}</td>
                  <td className="px-lg py-md font-medium text-on-surface">{e.courses?.name}</td>
                  <td className="px-lg py-md text-on-surface-variant">{e.courses?.credits}</td>
                  <td className="px-lg py-md text-on-surface-variant">{(e.courses?.profiles as any)?.full_name || "TBA"}</td>
                  <td className="px-lg py-md">
                    <span className="text-xs font-semibold px-sm py-xs rounded-full bg-success/10 text-success capitalize">{e.status}</span>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={5} className="px-lg py-xl text-center text-outline">No courses enrolled yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
