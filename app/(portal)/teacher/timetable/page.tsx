import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function TeacherTimetable() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("college_id").eq("id", user.id).single();

  const { data: slots } = await supabase
    .from("timetable_slots")
    .select("*, courses(name, code)")
    .eq("college_id", profile?.college_id || "")
    .eq("teacher_id", user.id)
    .order("day_of_week")
    .order("start_time");

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const grouped: Record<number, any[]> = {};
  (slots || []).forEach((s: any) => {
    if (!grouped[s.day_of_week]) grouped[s.day_of_week] = [];
    grouped[s.day_of_week].push(s);
  });

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">My Timetable</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Your teaching schedule for the week</p>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="divide-y divide-outline-variant">
          {[1, 2, 3, 4, 5, 6].map((day) => (
            <div key={day} className="px-lg py-md">
              <div className="text-xs font-bold text-secondary uppercase tracking-wider mb-sm">{dayNames[day]}</div>
              {grouped[day] && grouped[day].length > 0 ? (
                <div className="flex flex-wrap gap-sm">
                  {grouped[day].map((slot: any) => (
                    <div key={slot.id} className="bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm">
                      <div className="text-sm font-semibold text-on-surface">{slot.courses?.code} — {slot.courses?.name}</div>
                      <div className="text-xs text-outline mt-xs">
                        {slot.start_time?.slice(0, 5)} – {slot.end_time?.slice(0, 5)}
                        {slot.room && ` • Room ${slot.room}`}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-outline italic">Free</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
