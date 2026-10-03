import { supabase } from "@/lib/supabase";
import { clientHeaders } from "@/lib/device";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL!;

/**
 * A failed mobile API call. `code` is the server's reason when it gave one —
 * notably the college lifecycle and session codes of migrations 053/054:
 * COLLEGE_UNAVAILABLE, SESSION_LIMIT, SESSION_REVOKED, ACCESS_CHECK_FAILED.
 */
export class ApiError extends Error {
  constructor(message: string, public status?: number, public code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** The codes that mean the app itself is closed to this session right now. */
export const ACCESS_CODES = new Set(["COLLEGE_UNAVAILABLE", "SESSION_LIMIT", "SESSION_REVOKED"]);

type AccessListener = (code: string) => void;
const accessListeners = new Set<AccessListener>();

/** Notified when any call is refused for an access reason, so the root can re-check and show the right screen. */
export function onAccessRefused(listener: AccessListener): () => void {
  accessListeners.add(listener);
  return () => accessListeners.delete(listener);
}

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
      ...(await clientHeaders()),
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof json?.code === "string" ? json.code : undefined;
    if (code && ACCESS_CODES.has(code)) accessListeners.forEach((listener) => listener(code));
    throw new ApiError(json?.error ?? `Request failed (${res.status}).`, res.status, code);
  }
  return json as T;
}
