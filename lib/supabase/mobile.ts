import { createServerClient } from "@supabase/ssr";
import type { Database } from "@/types/database";

/**
 * Supabase client for app/api/mobile/* Route Handlers — authenticates via
 * the Bearer access token the RN app sends (mobile/src/lib/api.ts), not
 * cookies. Mirrors lib/supabase/server.ts's role in the cookie-based flow.
 */
export function createMobileClient(accessToken: string) {
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key",
    {
      cookies: { getAll: () => [], setAll: () => {} },
      global: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    }
  );
}

export function bearerTokenFrom(request: Request): string | null {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}
