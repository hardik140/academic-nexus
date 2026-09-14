import { createHmac, createHash, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * The QR credential: what is in it, how it is signed, and what signing it
 * does NOT buy you.
 *
 * A gate pass QR is a bearer token printed on glass. Three separate things
 * have to be true before one opens a gate, and this module owns exactly the
 * first of them:
 *
 *   1. the payload is INTACT and was minted by this installation  <- here
 *   2. the credential row is ACTIVE, in window, and bound to an approved
 *      pass in the scanning guard's college     <- record_gate_movement()
 *   3. the guard is active, permitted, and standing at a gate they operate
 *                                               <- record_gate_movement()
 *
 * Signing alone authorises nothing. A correctly signed payload for a
 * revoked credential, an unapproved pass or another college is refused by
 * the database with the signature still valid, which is the whole point of
 * keeping (2) and (3) out of this file.
 *
 * SHAPE
 *
 *   ANGP1.<credential uuid>.<base64url HMAC-SHA256>
 *
 * The signed message binds the credential to its nonce, its college and its
 * pass, so a signature lifted from one credential cannot be replayed onto
 * another row even by someone who can write the credentials table:
 *
 *   ANGP1|<credential id>|<nonce>|<college id>|<gate pass id>
 *
 * WHERE THE SECRET LIVES
 *
 * GATE_QR_SIGNING_KEY, in the server environment — never in the database
 * and never in a browser bundle. So the two halves of a forgery are held in
 * different places: the database holds the nonce and not the key, the
 * environment holds the key and not the nonce. A dump of either one alone
 * mints nothing.
 *
 * Absent or too short, this module FAILS CLOSED: no credential is rendered
 * and no scan verifies. There is no development fallback key, because a
 * fallback key is a key an attacker also has. Same posture as
 * lib/finance/crypto.ts, for the same reason.
 */

export const PAYLOAD_PREFIX = "ANGP1";

/** 32 hex characters minimum — 128 bits. Shorter is refused, not padded. */
const MIN_KEY_LENGTH = 32;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIG_RE = /^[A-Za-z0-9_-]{43}$/;
const NONCE_RE = /^[0-9a-f]{32,128}$/;

export class CredentialSigningUnavailableError extends Error {
  constructor() {
    super(
      "Gate pass QR credentials are not configured on this server. " +
        "GATE_QR_SIGNING_KEY must be set before passes can be issued or scanned."
    );
    this.name = "CredentialSigningUnavailableError";
  }
}

function signingKey(): Buffer {
  const raw = process.env.GATE_QR_SIGNING_KEY;
  if (!raw || raw.trim().length < MIN_KEY_LENGTH) throw new CredentialSigningUnavailableError();
  return Buffer.from(raw.trim(), "utf8");
}

/** Lets a screen say "not configured" instead of throwing at render time. */
export function credentialSigningConfigured(): boolean {
  const raw = process.env.GATE_QR_SIGNING_KEY;
  return !!raw && raw.trim().length >= MIN_KEY_LENGTH;
}

export interface CredentialBinding {
  credentialId: string;
  nonce: string;
  collegeId: string;
  gatePassId: string;
}

function message(b: CredentialBinding): string {
  return [PAYLOAD_PREFIX, b.credentialId, b.nonce, b.collegeId, b.gatePassId].join("|");
}

function sign(b: CredentialBinding): string {
  return createHmac("sha256", signingKey()).update(message(b), "utf8").digest("base64url");
}

/** The exact string that goes into the QR image. */
export function buildPayload(b: CredentialBinding): string {
  if (!UUID_RE.test(b.credentialId) || !UUID_RE.test(b.collegeId) || !UUID_RE.test(b.gatePassId)) {
    throw new Error("Gate pass credential: identifiers must be UUIDs.");
  }
  if (!NONCE_RE.test(b.nonce)) {
    throw new Error("Gate pass credential: malformed nonce.");
  }
  return `${PAYLOAD_PREFIX}.${b.credentialId}.${sign(b)}`;
}

/**
 * Structure only — no secret is consulted here, so this is safe to run on
 * anything a camera produced. Returns null for a string that is not one of
 * ours at all, which is how a scan of somebody's Wi-Fi QR gets answered
 * with "invalid" and not with a stack trace.
 */
export function parsePayload(raw: string): { credentialId: string; signature: string } | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length > 200) return null;
  const parts = text.split(".");
  if (parts.length !== 3) return null;
  const [prefix, credentialId, signature] = parts;
  if (prefix !== PAYLOAD_PREFIX) return null;
  if (!UUID_RE.test(credentialId)) return null;
  if (!SIG_RE.test(signature)) return null;
  return { credentialId: credentialId.toLowerCase(), signature };
}

/**
 * Constant-time comparison against the signature this installation would
 * have produced for these bindings.
 *
 * timingSafeEqual throws on a length mismatch, so the lengths are checked
 * first — and both operands are fixed-length base64url by construction, so
 * a mismatch here means a malformed payload rather than a near miss.
 */
export function signatureMatches(b: CredentialBinding, signature: string): boolean {
  const expected = Buffer.from(sign(b), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * A short, non-reversible handle for the audit trail. Scan attempts are
 * logged by fingerprint so a rejected payload can be correlated across
 * attempts without the log becoming a list of working credentials.
 */
export function payloadFingerprint(raw: string): string {
  return createHash("sha256").update(String(raw), "utf8").digest("hex").slice(0, 16);
}

/**
 * A syntactically valid payload that will never verify — for tests and for
 * the "what does an unknown QR do" path. Deliberately built here rather
 * than hand-written in each test, so no test accidentally asserts against a
 * string that a future format change would make merely malformed instead of
 * merely unsigned.
 */
export function unsignedPayloadFor(credentialId: string = randomUUID()): string {
  return `${PAYLOAD_PREFIX}.${credentialId}.${"A".repeat(43)}`;
}
