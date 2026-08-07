import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { supabase } from "@/lib/supabase";

WebBrowser.maybeCompleteAuthSession();

/** Must also be registered as "scheme" in app.json, and added to the
 * Supabase dashboard's Auth > URL Configuration > Redirect URLs allowlist. */
export const REDIRECT_URL = Linking.createURL("auth/callback");

/**
 * Extracts access/refresh tokens from a Supabase auth redirect URL and
 * establishes the session. Same token-extraction shape used by every
 * disposable E2E script this session (magic-link/OAuth redirects put the
 * tokens in the URL fragment, not query params).
 */
export async function handleAuthRedirect(url: string): Promise<boolean> {
  const { hostname, path, queryParams } = Linking.parse(url);
  if (`${hostname ?? ""}${path ?? ""}` !== "auth/callback" && !url.includes("auth/callback")) {
    return false;
  }

  const fragment = url.split("#")[1];
  const params = new URLSearchParams(fragment ?? "");
  const access_token = params.get("access_token") ?? (queryParams?.access_token as string | undefined);
  const refresh_token = params.get("refresh_token") ?? (queryParams?.refresh_token as string | undefined);

  if (!access_token || !refresh_token) return false;

  const { error } = await supabase.auth.setSession({ access_token, refresh_token });
  return !error;
}

export async function signInWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: REDIRECT_URL, skipBrowserRedirect: true },
  });
  if (error || !data.url) throw error ?? new Error("No OAuth URL returned.");

  const result = await WebBrowser.openAuthSessionAsync(data.url, REDIRECT_URL);
  if (result.type === "success" && result.url) {
    const ok = await handleAuthRedirect(result.url);
    if (!ok) throw new Error("Failed to establish session from OAuth redirect.");
  } else if (result.type !== "success") {
    throw new Error("Google sign-in was cancelled.");
  }
}

export async function signInWithMagicLink(email: string) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: REDIRECT_URL },
  });
  if (error) throw error;
}
