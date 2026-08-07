import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { dashboardPathFor } from "@/lib/auth/role-routes";

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

  redirect(dashboardPathFor(profile?.role));
}
