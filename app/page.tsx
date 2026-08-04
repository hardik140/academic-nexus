import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Root page — redirects based on auth status.
 * - Authenticated users → their role-specific dashboard
 * - Unauthenticated → /login
 */
export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Fetch role to determine redirect
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const roleRoutes: Record<string, string> = {
    student: "/student/dashboard",
    teacher: "/teacher/dashboard",
    hod: "/hod/dashboard",
    finance: "/finance/dashboard",
    director: "/director/dashboard",
    admin: "/admin/dashboard",
    warden: "/warden/dashboard",
    parent: "/parent/dashboard",
  };

  const destination = roleRoutes[profile?.role || "student"] || "/student/dashboard";
  redirect(destination);
}
