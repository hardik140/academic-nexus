import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Credential encryption for accounting-provider secrets.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * This repository has no secret manager. The only secret infrastructure is
 * process environment variables (SMTP_*, SUPABASE_SERVICE_ROLE_KEY,
 * QSTASH_*). An accounting integration holds a third party's OAuth refresh
 * token — a credential that can read and write a college's books — so
 * storing it as a plain column would be worse than every secret this app
 * already handles.
 *
 * So: AES-256-GCM, key from FINANCE_CREDENTIAL_KEY, ciphertext in a table
 * that no authenticated role can read (049 enables RLS on it with no
 * policy). That is a real improvement over plaintext and it is NOT a KMS:
 * the key sits in the same environment as the process that uses it, and
 * rotation is manual. Recorded as a production blocker in the certification
 * report rather than described as solved.
 *
 * FAIL CLOSED. With no key configured, `encryptCredential` throws. The
 * connection wizard surfaces that as "credential storage is not configured"
 * and refuses to create the connection. There is deliberately no fallback
 * that stores anything readable.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_ENV = "FINANCE_CREDENTIAL_KEY";
const CURRENT_KEY_VERSION = 1;

export class CredentialStorageUnavailableError extends Error {
  constructor() {
    super(
      `${KEY_ENV} is not configured, so accounting credentials cannot be stored securely. ` +
        `Set it to a 32-byte key (base64 or 64 hex characters) before creating an integration.`
    );
    this.name = "CredentialStorageUnavailableError";
  }
}

export interface SealedCredential {
  algorithm: "aes-256-gcm";
  keyVersion: number;
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** True when credential storage is usable — the connection wizard asks first. */
export function credentialStorageConfigured(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

function loadKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) throw new CredentialStorageUnavailableError();

  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`${KEY_ENV} must decode to exactly 32 bytes (got ${key.length}).`);
  }
  return key;
}

/**
 * Seals a credential object. The plaintext is JSON so the shape can differ
 * per provider (OAuth vs basic vs none) without a schema change.
 */
export function encryptCredential(credential: unknown): SealedCredential {
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(credential), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    algorithm: ALGORITHM,
    keyVersion: CURRENT_KEY_VERSION,
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Opens a sealed credential. A tampered ciphertext or auth tag throws rather
 * than returning partial data — GCM authenticates, which is why it is the
 * mode chosen here over CBC.
 */
export function decryptCredential<T = unknown>(sealed: SealedCredential): T {
  const key = loadKey();
  if (sealed.algorithm !== ALGORITHM) {
    throw new Error(`Unsupported credential algorithm: ${sealed.algorithm}`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/**
 * SHA-256 of a request or response body.
 *
 * The journal stores these instead of payloads: an operator needs to prove
 * that the retry sent the same thing as the first attempt, which a digest
 * answers, without the journal becoming a second copy of the ledger or a
 * place bank references and tokens accumulate (§53).
 */
export function bodyHash(body: unknown): string {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? null);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Constant-time comparison, for webhook signatures (§69). */
export function signaturesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Redacts anything credential-shaped before it reaches a log or the
 * request_summary column. Keys are matched by name, not value, so a token
 * that happens to look like an id is still removed.
 */
const SECRET_KEYS =
  /(secret|token|password|passwd|authorization|api[_-]?key|refresh|client[_-]?secret|cookie)/i;

export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v);
    }
    return out as unknown as T;
  }
  return value;
}
