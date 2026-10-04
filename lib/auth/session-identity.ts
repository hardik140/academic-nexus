import { combineChunks, stringFromBase64URL } from "@supabase/ssr";

/**
 * WHO IS THIS REQUEST, cheaply and without trusting it — for RATE LIMITING
 * ONLY. Nothing here authorizes anything: getUser(), session admission,
 * requireRole() and RLS still decide access, unchanged.
 *
 * WHY. The middleware has to pick a rate-limit bucket before it calls
 * Supabase Auth (that is what protects Auth from floods). It used to pick by
 * "does the request carry a session cookie?", and charged every such request
 * to ONE per-campus-IP bucket. A cookie is not a session: one device sending
 * random strings as its cookie spent that bucket for every signed-in user
 * behind the same NAT (Redis audit, finding E1; reproduced in
 * bench/audit/middleware-flood.audit.ts).
 *
 * Here the access token's SIGNATURE is checked locally against the
 * project's published keys (JWKS), so the bucket follows a proven identity:
 *
 *   none          no credentials                       -> anonymous per-IP bucket
 *   invalid       garbled, forged, unknown key         -> anonymous per-IP bucket
 *   verified      signature valid (expired or not)     -> that user's own bucket
 *   unverifiable  a token this isolate cannot check     -> the old shared ceiling
 *                 locally (an HS256 project, or the
 *                 key set unreachable)
 *
 * An EXPIRED but correctly signed token still names its user: only Supabase
 * could have signed it. Ordinary users carry one every hour until the
 * middleware refreshes it, so treating "expired" as anonymous would push
 * real users back into the shared bucket.
 *
 * No network on the hot path: the key set is fetched at most once per
 * JWKS_TTL_MS per isolate, and a failed fetch is not retried for
 * FAILURE_BACKOFF_MS (requests in between are "unverifiable", never
 * "invalid" — an outage of the key endpoint must not reclassify real users
 * as attackers).
 */

export type SessionIdentity =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "verified"; userId: string; expired: boolean }
  | { kind: "unverifiable" };

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
}

export const JWKS_TTL_MS = 10 * 60_000;
export const FAILURE_BACKOFF_MS = 30_000;
/** A kid we have not seen triggers a refetch, at most this often (key rotation). */
const UNKNOWN_KID_REFETCH_MS = 60_000;

const SESSION_COOKIE = /^sb-[A-Za-z0-9-]+-auth-token(\.\d+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RequestLike {
  headers: { get(name: string): string | null };
  cookies: { getAll(): { name: string; value: string }[] };
}

/**
 * The access token the request presents: a Bearer header (mobile API), else
 * the Supabase session cookie (possibly chunked, possibly `base64-` encoded —
 * decoded with @supabase/ssr's own helpers). `""` means credentials are
 * present but unreadable; `null` means none at all.
 */
export async function accessTokenFrom(request: RequestLike): Promise<string | null> {
  const bearer = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
  if (bearer) return bearer[1];

  const cookies = request.cookies.getAll().filter((c) => SESSION_COOKIE.test(c.name) && c.value !== "");
  if (cookies.length === 0) return null;
  const values = new Map(cookies.map((c) => [c.name, c.value]));
  const base = cookies[0].name.replace(/\.\d+$/, "");
  const raw = await combineChunks(base, (name) => values.get(name) ?? null);
  if (!raw) return "";
  try {
    const text = raw.startsWith("base64-") ? stringFromBase64URL(raw.slice("base64-".length)) : raw;
    const session = JSON.parse(text) as unknown;
    const token = Array.isArray(session) ? session[0] : (session as { access_token?: unknown } | null)?.access_token;
    return typeof token === "string" ? token : "";
  } catch {
    return "";
  }
}

// ── Key set ───────────────────────────────────────────────────

let keys: { list: Jwk[]; fetchedAt: number } | null = null;
let failedAt = 0;
let inflight: Promise<Jwk[] | null> | null = null;

/** Test hook. */
export function resetSessionIdentity(): void {
  keys = null;
  failedAt = 0;
  inflight = null;
}

export interface IdentityDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  supabaseUrl?: string;
  apiKey?: string;
}

async function fetchKeys(deps: IdentityDeps): Promise<Jwk[] | null> {
  const now = deps.now ?? Date.now;
  const base = deps.supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await (deps.fetchImpl ?? fetch)(`${base.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`, {
        headers: { apikey: deps.apiKey ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "" },
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) throw new Error(`jwks ${res.status}`);
      const body = (await res.json()) as { keys?: Jwk[] };
      const list = Array.isArray(body.keys) ? body.keys : [];
      keys = { list, fetchedAt: now() };
      failedAt = 0;
      return list;
    } catch {
      failedAt = now();
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * The key for `kid`. null = a key set fetched for this request does not have
 * it: forged. "unavailable" = no key set, or an unknown kid we may not refetch
 * for yet. A key the project rotated to inside the refetch window must not be
 * called forged, or every signed-in user would fall into the strict anonymous
 * bucket until the window passed. That gives an attacker nothing new: any
 * HS256 header already reaches "unverifiable", and the middleware still
 * charges a request Supabase rejects to the strict per-IP bucket.
 */
async function keyFor(kid: string, deps: IdentityDeps): Promise<Jwk | null | "unavailable"> {
  const now = (deps.now ?? Date.now)();
  const stale = !keys || now - keys.fetchedAt > JWKS_TTL_MS;
  let fetchedNow = false;
  if (stale) {
    if (!keys && failedAt && now - failedAt < FAILURE_BACKOFF_MS) return "unavailable";
    const list = await fetchKeys(deps);
    if (!list && !keys) return "unavailable";
    fetchedNow = list !== null;
  }
  const hit = keys!.list.find((k) => k.kid === kid) ?? null;
  if (hit || fetchedNow) return hit;
  if (now - keys!.fetchedAt <= UNKNOWN_KID_REFETCH_MS) return "unavailable";
  if (failedAt && now - failedAt < FAILURE_BACKOFF_MS) return "unavailable";
  const fresh = await fetchKeys(deps); // rotation: a new key may have been published
  if (!fresh) return "unavailable";
  return fresh.find((k) => k.kid === kid) ?? null;
}

// ── Verification ──────────────────────────────────────────────

function decodePart<T>(part: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64urlBytes(part))) as T;
  } catch {
    return null;
  }
}

function base64urlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const ALGORITHMS: Record<string, { importAs: EcKeyImportParams | RsaHashedImportParams; verifyAs: EcdsaParams | AlgorithmIdentifier }> = {
  ES256: { importAs: { name: "ECDSA", namedCurve: "P-256" }, verifyAs: { name: "ECDSA", hash: "SHA-256" } },
  RS256: { importAs: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verifyAs: { name: "RSASSA-PKCS1-v1_5" } },
};

export async function verifySessionToken(token: string, deps: IdentityDeps = {}): Promise<SessionIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p === "")) return { kind: "invalid" };
  const header = decodePart<{ alg?: string; kid?: string }>(parts[0]);
  const payload = decodePart<{ sub?: unknown; exp?: unknown }>(parts[1]);
  if (!header || !payload) return { kind: "invalid" };
  if (typeof payload.sub !== "string" || !UUID.test(payload.sub)) return { kind: "invalid" };

  const algorithm = header.alg ? ALGORITHMS[header.alg] : undefined;
  if (!algorithm || !header.kid) {
    // HS256 (a project still on the legacy shared secret) cannot be checked
    // without that secret, which the app does not hold. Not proof of forgery.
    return header.alg?.startsWith("HS") ? { kind: "unverifiable" } : { kind: "invalid" };
  }
  if (!("crypto" in globalThis) || !globalThis.crypto?.subtle) return { kind: "unverifiable" };

  const jwk = await keyFor(header.kid, deps);
  if (jwk === "unavailable") return { kind: "unverifiable" };
  if (!jwk) return { kind: "invalid" };

  try {
    const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, algorithm.importAs, false, ["verify"]);
    const ok = await crypto.subtle.verify(
      algorithm.verifyAs,
      key,
      base64urlBytes(parts[2]) as BufferSource,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`) as BufferSource
    );
    if (!ok) return { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
  const now = (deps.now ?? Date.now)();
  const expired = typeof payload.exp === "number" ? payload.exp * 1000 <= now : true;
  return { kind: "verified", userId: payload.sub, expired };
}

/** accessTokenFrom + verifySessionToken. */
export async function sessionIdentity(request: RequestLike, deps: IdentityDeps = {}): Promise<SessionIdentity> {
  const token = await accessTokenFrom(request);
  if (token === null) return { kind: "none" };
  if (token === "") return { kind: "invalid" };
  return verifySessionToken(token, deps);
}
