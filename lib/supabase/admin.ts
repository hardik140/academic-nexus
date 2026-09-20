import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * Service-role Supabase client. Bypasses RLS entirely — only ever call this
 * from Server Actions/route handlers, after an explicit requireRole() check,
 * and never import it into client ("use client") code. Needed for
 * operations the Supabase Auth Admin API gates behind the service-role key
 * (e.g. auth.admin.createUser), which anon/authenticated clients can't do.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
    process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-service-role-key",
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
