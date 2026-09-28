/**
 * Where a redirect after authentication may send the browser.
 *
 * /auth/callback and /auth/confirm used to redirect to `${origin}${next}`
 * with `next` taken straight from the query string. Concatenated onto the
 * origin, `next=.evil.example` becomes https://<our-host>.evil.example/ and
 * `next=@evil.example` becomes https://<our-host>@evil.example/ — both a
 * different site. This helper is the one check every such redirect passes
 * through: it returns a same-origin path, or null, and a caller that gets
 * null uses its own safe default (it fails closed).
 *
 * Accepted: a path that starts with exactly one "/", with no backslash,
 * whitespace or control character, that still resolves to our own origin
 * after URL parsing. The path is returned in its parsed, normalised form, so
 * the value that was checked is the value that is used ("/a/../api" is
 * checked, and rejected, as "/api").
 *
 * Two policies, because two kinds of redirect need different destinations:
 *
 *   • "after-sign-in" — where to go once signed in (the login page's `next`).
 *     Never /login, /auth/* or /api/*: back to a sign-in page, into another
 *     auth step, or onto a machine endpoint.
 *   • "auth-link" — where an emailed or OAuth link lands after
 *     /auth/callback or /auth/confirm has set the session. The same rules,
 *     except the two auth steps those links exist to reach:
 *     /auth/reset-password (password recovery) and /auth/accept-invite
 *     (invitations).
 *
 * This decides only where the browser goes. Whether the user may see that
 * page is still decided when it loads: the proxy's session and role checks
 * (lib/supabase/middleware.ts) and each page's own authorization are
 * untouched by it.
 */

export type RedirectPolicy = "after-sign-in" | "auth-link";

/** The auth steps an auth link may land on. Exact paths only. */
const AUTH_LINK_DESTINATIONS = new Set(["/auth/reset-password", "/auth/accept-invite"]);

/** First path segments no redirect after authentication may enter. */
const RESERVED = new Set(["login", "auth", "api"]);

// A base no real request uses: if parsing lands anywhere else, the value was
// not a plain path on our own origin.
const BASE = "http://redirect-check.invalid";

const MAX_LENGTH = 2048;

/**
 * The first check, on the text as given: a plain path with exactly one
 * leading slash ("//host" is protocol-relative, and browsers read a
 * backslash as a slash, so "/\host" is too), and no backslash, whitespace or
 * control character anywhere.
 */
export function isPlainPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) return false;
  if (value[0] !== "/" || value[1] === "/") return false;
  return !/[\\\s\u0000-\u001f\u007f]/.test(value);
}

export function safeRedirectPath(value: unknown, policy: RedirectPolicy): string | null {
  if (!isPlainPath(value)) return null;

  // The second check, independent of the first: parsed, it must still be a
  // path on our own origin. No plain path fails it today; it stays as the
  // backstop should the first check ever be loosened.
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;

  const path = url.pathname;
  let first: string;
  try {
    // Decoded, so "/%61pi" and "/api%2Fx" are recognised as /api.
    first = decodeURIComponent(path.split("/")[1] ?? "").split("/")[0].toLowerCase();
  } catch {
    return null;
  }
  if (RESERVED.has(first) && !(policy === "auth-link" && AUTH_LINK_DESTINATIONS.has(path))) return null;

  return `${path}${url.search}${url.hash}`;
}
