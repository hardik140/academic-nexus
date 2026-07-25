import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function StudentHostel() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: student } = await supabase.from("students").select("id").eq("user_id", user.id).single();
  const { data: profile } = await supabase.from("profiles").select("college_id").eq("id", user.id).single();

  // Current allocation
  const { data: allocation } = await supabase
    .from("hostel_allocations")
    .select("*, hostel_rooms(block_name, room_number, type, ac, capacity, occupancy)")
    .eq("student_id", student?.id || "")
    .eq("status", "active")
    .single();

  // Mess menu for today
  const todayDay = new Date().getDay();
  const { data: messMenu } = await supabase
    .from("mess_menu")
    .select("*")
    .eq("college_id", profile?.college_id || "")
    .eq("day_of_week", todayDay)
    .order("meal_type");

  const mealOrder = ["breakfast", "lunch", "snacks", "dinner"];
  const sortedMenu = (messMenu || []).sort(
    (a: any, b: any) => mealOrder.indexOf(a.meal_type) - mealOrder.indexOf(b.meal_type)
  );

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Hostel & Mess</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Room details, mess menu, and hostel services</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-md">
        {/* Room Info */}
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">🏠 My Room</h2>
          </div>
          {allocation ? (
            <div className="p-lg space-y-md">
              <div className="grid grid-cols-2 gap-md">
                <div>
                  <div className="text-xs text-outline uppercase tracking-wider">Block</div>
                  <div className="text-lg font-bold text-on-surface">{allocation.hostel_rooms?.block_name}</div>
                </div>
                <div>
                  <div className="text-xs text-outline uppercase tracking-wider">Room</div>
                  <div className="text-lg font-bold text-secondary">{allocation.hostel_rooms?.room_number}</div>
                </div>
                <div>
                  <div className="text-xs text-outline uppercase tracking-wider">Type</div>
                  <div className="text-sm font-medium text-on-surface capitalize">{allocation.hostel_rooms?.type}</div>
                </div>
                <div>
                  <div className="text-xs text-outline uppercase tracking-wider">AC</div>
                  <div className="text-sm font-medium text-on-surface">{allocation.hostel_rooms?.ac ? "Yes ❄️" : "No"}</div>
                </div>
                <div>
                  <div className="text-xs text-outline uppercase tracking-wider">Occupancy</div>
                  <div className="text-sm font-medium text-on-surface">
                    {allocation.hostel_rooms?.occupancy}/{allocation.hostel_rooms?.capacity}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-outline uppercase tracking-wider">Since</div>
                  <div className="text-sm font-medium text-on-surface">{new Date(allocation.allocated_date).toLocaleDateString()}</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-xl text-center text-sm text-outline">
              No hostel room allocated. Contact the warden.
            </div>
          )}
        </div>

        {/* Today's Menu */}
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">🍽️ Today&apos;s Menu — {dayNames[todayDay]}</h2>
          </div>
          <div className="divide-y divide-outline-variant">
            {sortedMenu.length > 0 ? sortedMenu.map((meal: any) => (
              <div key={meal.id} className="px-lg py-md">
                <div className="flex items-center justify-between mb-xs">
                  <span className="text-xs font-bold text-secondary uppercase tracking-wider capitalize">{meal.meal_type}</span>
                  <div className="flex items-center gap-xs">
                    {meal.is_vegetarian && <span className="text-xs bg-success/10 text-success px-xs py-[1px] rounded">Veg</span>}
                    {meal.calories && <span className="text-[10px] text-outline">{meal.calories} cal</span>}
                  </div>
                </div>
                <div className="text-sm text-on-surface">{(meal.items || []).join(" • ")}</div>
              </div>
            )) : (
              <div className="p-xl text-center text-sm text-outline">No menu available for today.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
