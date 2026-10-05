/**
 * Real, correctly signed Supabase-style session tokens for tests: an ES256
 * key pair generated with WebCrypto, published as the project's JWKS, and
 * cookies in the exact formats @supabase/ssr writes (plain JSON, `base64-`
 * prefixed, chunked). Nothing here talks to Supabase.
 */
import { stringToBase64URL } from "@supabase/ssr";

export const SUPABASE_URL = "https://qa-project.supabase.co";
export const COOKIE = "sb-qa-project-auth-token";

const b64url = (bytes: Uint8Array | ArrayBuffer) =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
const b64urlJson = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export interface Signer {
  kid: string;
  jwk: JsonWebKey & { kid: string; alg: string; use: string };
  sign(payload: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

export async function makeSigner(kid = "qa-key-1"): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    jwk: { ...pub, kid, alg: "ES256", use: "sig" },
    async sign(payload, header = {}) {
      const h = b64urlJson({ alg: "ES256", typ: "JWT", kid, ...header });
      const p = b64urlJson(payload);
      const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
      return `${h}.${p}.${b64url(sig)}`;
    },
  };
}

/** An access token for `sub`, valid for an hour (or already expired). */
export function claims(sub: string, opts: { expiredSecondsAgo?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const exp = opts.expiredSecondsAgo !== undefined ? now - opts.expiredSecondsAgo : now + 3600;
  return { sub, exp, iat: exp - 3600, role: "authenticated", aud: "authenticated" };
}

/** An HS256-looking token (a project still on the legacy shared secret). */
export function hs256Token(sub: string): string {
  return `${b64urlJson({ alg: "HS256", typ: "JWT" })}.${b64urlJson(claims(sub))}.${b64url(new Uint8Array(32))}`;
}

/** The cookie header @supabase/ssr would send for a session holding `accessToken`. */
export function sessionCookie(accessToken: string, opts: { encoding?: "base64" | "raw"; chunkSize?: number } = {}): string {
  const json = JSON.stringify({ access_token: accessToken, refresh_token: "r", token_type: "bearer", expires_in: 3600, user: { id: "x" } });
  const value = opts.encoding === "raw" ? json : `base64-${stringToBase64URL(json)}`;
  if (!opts.chunkSize || value.length <= opts.chunkSize) return `${COOKIE}=${value}`;
  const parts: string[] = [];
  for (let i = 0; i * opts.chunkSize < value.length; i++) parts.push(`${COOKIE}.${i}=${value.slice(i * opts.chunkSize, (i + 1) * opts.chunkSize)}`);
  return parts.join("; ");
}

/** A fetch that serves the JWKS for `signers` (and counts calls); anything else is a 404. */
export function jwksFetch(signers: Signer[], state: { calls: number; down?: boolean } = { calls: 0 }): typeof fetch {
  return (async (url: string | URL | Request) => {
    if (String(url).endsWith("/auth/v1/.well-known/jwks.json")) {
      state.calls++;
      if (state.down) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ keys: signers.map((s) => s.jwk) }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}
