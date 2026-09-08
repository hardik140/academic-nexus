/**
 * Returns the public origin used in links sent by server-side auth flows.
 * This must be configured in every deployed environment; using localhost in
 * production creates invitation and recovery links that users cannot open.
 */
export function getPublicAppUrl(): string {
  const configuredUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    (["development", "test"].includes(process.env.NODE_ENV ?? "") ? "http://localhost:3000" : undefined);

  if (!configuredUrl) {
    throw new Error(
      "NEXT_PUBLIC_APP_URL is not configured. Set it to the deployed app URL before sending authentication emails."
    );
  }

  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error("NEXT_PUBLIC_APP_URL must be a valid absolute HTTP(S) URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_APP_URL must use http:// or https://.");
  }

  if (
    process.env.NODE_ENV === "production" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  ) {
    throw new Error("NEXT_PUBLIC_APP_URL cannot point to localhost in production.");
  }

  return url.toString().replace(/\/$/, "");
}