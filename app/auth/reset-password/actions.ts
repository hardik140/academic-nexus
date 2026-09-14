"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { dashboardPathFor } from "@/lib/auth/role-routes";
import { dbError } from "@/lib/internal-error";

const ResetPasswordSchema = z.object({
  password: z.string().min(8, { message: "Password must be at least 8 characters." }).max(200),
});

export async function resetPassword(password: string) {
  const { password: validPassword } = ResetPasswordSchema.parse({ password });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("Your reset link has expired. Request a new one from the sign-in page.");
  }

  const { error } = await supabase.auth.updateUser({ password: validPassword });
  if (error) {
    throw dbError(error);
  }

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  redirect(dashboardPathFor(profile?.role ?? null));
}
