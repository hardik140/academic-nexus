import { supabase } from "@/lib/supabase";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL!;

class ApiError extends Error {}

/**
 * Calls an app/api/mobile/* Route Handler, authenticated with the current
 * session's access token (Bearer header) — the mobile equivalent of the web
 * app's cookie-based Server Actions. See lib/supabase/mobile.ts and
 * requireRoleFromRequest() on the Next.js side for the matching guard.
 */
export async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new ApiError("Not signed in.");

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(json?.error ?? `Request failed (${res.status}).`);
  }
  return json as T;
}
