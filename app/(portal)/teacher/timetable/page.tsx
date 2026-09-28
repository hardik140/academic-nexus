import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { assertRead } from "@/lib/read-result-server";
import { NO_MATCH_ID } from "@/lib/read-result";

export default async function TeacherTimetable() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile, error: profileError } = await supabase.from("profiles").select("college_id").eq("id", user.id).single();
  assertRead(profileError);

  // timetable_slots has no instructor_id after 047 — a slot belongs to an
  // offering, and the offering names the instructor. Read-only page: this
  // phase deliberately adds no timetable WRITE policy.
  const { data: myOfferings, error: myOfferingsError } = await supabase
    .from("course_offerings")
    .select("id")
    .eq("instructor_id", user.id);
  assertRead(myOfferingsError);
  const myOfferingIds = ((myOfferings as any[]) || []).map((o) => o.id);

  const slotsRes = myOfferingIds.length
    ? await supabase
        .from("timetable_slots")
        .select("*, course_offerings:offering_id(courses:course_id(name, code), sections:section_id(name))")
        .eq("college_id", profile?.college_id || NO_MATCH_ID)
        .in("offering_id", myOfferingIds)
        .order("day_of_week")
        .order("start_time")
    : { data: [], error: null };
  assertRead(slotsRes.error);
  const slots = slotsRes.data;

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const todayIndex = new Date().getDay();
  const grouped: Record<number, any[]> = {};
  (slots || []).forEach((s: any) => {
    if (!grouped[s.day_of_week]) grouped[s.day_of_week] = [];
    grouped[s.day_of_week].push(s);
  });

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">My Timetable</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Your teaching schedule for the week</p>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="divide-y divide-outline-variant">
          {[1, 2, 3, 4, 5, 6].map((day) => {
            const isToday = day === todayIndex;
            return (
              <div key={day} className={`px-lg py-md ${isToday ? "bg-secondary/5" : ""}`}>
                <div className="flex items-center gap-sm mb-sm">
                  <span className={`text-xs font-bold uppercase tracking-wider ${isToday ? "text-secondary" : "text-on-surface-variant"}`}>
                    {dayNames[day]}
                  </span>
                  {isToday && (
                    <span className="text-[10px] font-bold text-on-secondary bg-secondary px-sm py-[1px] rounded-full">TODAY</span>
                  )}
                </div>
                {grouped[day] && grouped[day].length > 0 ? (
                  <div className="flex flex-wrap gap-sm">
                    {grouped[day].map((slot: any) => (
                      <div
                        key={slot.id}
                        className={`border rounded-xl px-md py-sm ${
                          isToday ? "bg-surface-container-lowest border-secondary/30 shadow-sm" : "bg-surface-container-low border-outline-variant"
                        }`}
                      >
                        <div className="text-sm font-semibold text-on-surface">
                          📚 {slot.course_offerings?.courses?.code} — {slot.course_offerings?.courses?.name}
                          {slot.course_offerings?.sections?.name && (
                            <span className="text-outline font-medium"> · {slot.course_offerings.sections.name}</span>
                          )}
                        </div>
                        <div className="text-xs text-outline mt-xs">
                          🕐 {slot.start_time?.slice(0, 5)} – {slot.end_time?.slice(0, 5)}
                          {slot.room && ` • 📍 Room ${slot.room}`}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-outline italic">✅ Free — no classes scheduled</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
