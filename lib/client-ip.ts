/**
 * Which header actually identifies the caller.
 *
 * THE BYPASS THIS CLOSES
 *
 * The middleware's global bucket used to be keyed like this:
 *
 *   const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
 *   await checkRateLimit(`ip:${ip}`, 100, 60);
 *
 * `X-Forwarded-For` is a request header. Anyone can send one, and its
 * leftmost entry is whatever the client wrote there — proxies append, they do
 * not verify. So a caller sending a fresh random value on each request gets a
 * fresh empty bucket on each request, and the limit is not a limit:
 *
 *   curl -H 'X-Forwarded-For: 1.2.3.4' ...   -> bucket ip:1.2.3.4
 *   curl -H 'X-Forwarded-For: 1.2.3.5' ...   -> bucket ip:1.2.3.5
 *
 * This application deploys behind Cloudflare (wrangler.jsonc /
 * open-next.config.ts). Cloudflare SETS `CF-Connecting-IP` itself on every
 * request and overwrites any value the client supplied, so it is the one
 * header here that a client cannot choose. It is therefore preferred over
 * everything else, and `X-Forwarded-For` is demoted to a last resort.
 *
 * RESIDUAL, AND DELIBERATELY NOT HIDDEN
 *
 * If this ever runs somewhere with no trusted edge in front of it, no header
 * is authoritative and the last resort is spoofable again. That case reports
 * `trusted: false` so the caller can log it rather than quietly believing the
 * number. It is not closed here because it cannot be closed here — it is a
 * property of the deployment, and it is recorded in DEPLOYMENT_VERIFICATION.md.
 */
export interface ClientIp {
  ip: string;
  /** False when the value came from a header the client could have written. */
  trusted: boolean;
}

export function clientIp(headers: Headers): ClientIp {
  // Set by Cloudflare's edge, overwriting anything the client sent.
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return { ip: cf, trusted: true };

  // Set by a reverse proxy that terminates the connection.
  const real = headers.get("x-real-ip")?.trim();
  if (real) return { ip: real, trusted: true };

  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return { ip: forwarded, trusted: false };

  return { ip: "unknown", trusted: false };
}
