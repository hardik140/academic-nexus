import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { StudentDashboardClient } from "./dashboard-client";

export default async function StudentDashboard() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Fetch student profile
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  // Fetch student academic data
  const { data: student } = await supabase
    .from("students")
    .select("*")
    .eq("user_id", user.id)
    .single();

  // Fetch recent attendance
  const { data: attendance } = await supabase
    .from("attendance")
    .select("*, courses(name, code)")
    .eq("student_id", student?.id || "")
    .order("date", { ascending: false })
    .limit(10);

  // Fetch pending fees
  const { data: fees } = await supabase
    .from("fees")
    .select("*")
    .eq("student_id", student?.id || "")
    .in("status", ["pending", "overdue"])
    .order("due_date", { ascending: true });

  // Fetch notifications
  const { data: notifications } = await supabase
    .from("notifications")
    .select("*")
    .eq("receiver_id", user.id)
    .eq("read", false)
    .order("created_at", { ascending: false })
    .limit(5);

  return (
    <StudentDashboardClient
      profile={profile}
      student={student}
      attendance={attendance || []}
      fees={fees || []}
      notifications={notifications || []}
    />
  );
}
