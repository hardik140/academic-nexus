import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  PAYLOAD_PREFIX,
  buildPayload,
  parsePayload,
  signatureMatches,
  payloadFingerprint,
  credentialSigningConfigured,
  unsignedPayloadFor,
  CredentialSigningUnavailableError,
} from "@/lib/gate-security/credential";

/**
 * The half of QR validation that lives in the application: the payload is
 * intact and was minted by THIS installation with THIS key.
 *
 * The other half — is the credential live, is the pass approved, is the
 * guard allowed to be scanning it — is in tests/staging-gate-security.test.ts
 * against the real database. Neither file proves the system is safe on its
 * own, and the seam between them is deliberate: a signature that verifies
 * still authorises nothing.
 */

const KEY = "0123456789abcdef0123456789abcdef0123456789";
const OTHER_KEY = "fedcba9876543210fedcba9876543210fedcba98";

function binding(overrides: Partial<Parameters<typeof buildPayload>[0]> = {}) {
  return {
    credentialId: "11111111-1111-4111-8111-111111111111",
    nonce: "a".repeat(64),
    collegeId: "22222222-2222-4222-8222-222222222222",
    gatePassId: "33333333-3333-4333-8333-333333333333",
    ...overrides,
  };
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GATE_QR_SIGNING_KEY;
  process.env.GATE_QR_SIGNING_KEY = KEY;
});
afterEach(() => {
  if (saved === undefined) delete process.env.GATE_QR_SIGNING_KEY;
  else process.env.GATE_QR_SIGNING_KEY = saved;
});

describe("the payload", () => {
  it("is prefix, credential id and signature, and verifies against its own bindings", () => {
    const b = binding();
    const payload = buildPayload(b);
    const parts = payload.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(PAYLOAD_PREFIX);
    expect(parts[1]).toBe(b.credentialId);
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const parsed = parsePayload(payload)!;
    expect(parsed.credentialId).toBe(b.credentialId);
    expect(signatureMatches(b, parsed.signature)).toBe(true);
  });

  it("carries no student, name, enrollment number or destination", () => {
    // §17: a QR that leaks who the student is leaks it to anyone who
    // photographs the screen over their shoulder.
    const payload = buildPayload(binding());
    const body = payload.toLowerCase();
    for (const secret of ["rahul", "student", "enroll", "hostel", "@", "2026"]) {
      expect(body).not.toContain(secret);
    }
    // Everything after the prefix is a UUID and base64url — no structure to read.
    expect(payload.replace(`${PAYLOAD_PREFIX}.`, "")).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  });

  it("is deterministic for the same bindings and different for every change", () => {
    const b = binding();
    expect(buildPayload(b)).toBe(buildPayload(b));

    const variants = [
      binding({ credentialId: "44444444-4444-4444-8444-444444444444" }),
      binding({ nonce: "b".repeat(64) }),
      binding({ collegeId: "55555555-5555-4555-8555-555555555555" }),
      binding({ gatePassId: "66666666-6666-4666-8666-666666666666" }),
    ];
    const signatures = new Set([buildPayload(b), ...variants.map(buildPayload)].map((p) => p.split(".")[2]));
    expect(signatures.size).toBe(5);
  });
});

describe("§45 Test 4 — a modified payload does not verify", () => {
  it("flipping any character of the signature is refused", () => {
    const b = binding();
    const signature = buildPayload(b).split(".")[2];
    for (const index of [0, 7, 21, 42]) {
      const ch = signature[index];
      const swapped = signature.slice(0, index) + (ch === "A" ? "B" : "A") + signature.slice(index + 1);
      expect(signatureMatches(b, swapped), `index ${index} accepted`).toBe(false);
    }
  });

  it("a signature lifted from another credential does not transfer", () => {
    // The attack this defends: read the credentials table, take a valid
    // signature, paste it onto a different (live) credential id. The
    // message is bound to the id, the nonce, the college and the pass, so
    // it verifies for exactly one row.
    const mine = binding();
    const theirs = binding({ credentialId: "77777777-7777-4777-8777-777777777777", nonce: "c".repeat(64) });
    const theirSignature = buildPayload(theirs).split(".")[2];
    expect(signatureMatches(mine, theirSignature)).toBe(false);
    expect(signatureMatches({ ...mine, credentialId: theirs.credentialId }, theirSignature)).toBe(false);
  });

  it("the same credential in another tenant does not verify", () => {
    const b = binding();
    const signature = buildPayload(b).split(".")[2];
    expect(signatureMatches({ ...b, collegeId: "88888888-8888-4888-8888-888888888888" }, signature)).toBe(false);
  });

  it("a payload signed with a different key does not verify here", () => {
    // Two installations, or a rotated key: one does not open the other's
    // gates.
    const b = binding();
    process.env.GATE_QR_SIGNING_KEY = OTHER_KEY;
    const elsewhere = buildPayload(b).split(".")[2];
    process.env.GATE_QR_SIGNING_KEY = KEY;
    expect(signatureMatches(b, elsewhere)).toBe(false);
  });
});

describe("§45 Test 5 — a guessed or malformed payload is rejected before anything is looked up", () => {
  it("parsePayload refuses everything that is not one of ours", () => {
    const rubbish = [
      "",
      "   ",
      "hello",
      "WIFI:S:campus;T:WPA;P:hunter2;;",
      "https://example.com/gate",
      `${PAYLOAD_PREFIX}.not-a-uuid.${"A".repeat(43)}`,
      `ANGP2.${randomUUID()}.${"A".repeat(43)}`,
      `${PAYLOAD_PREFIX}.${randomUUID()}`,
      `${PAYLOAD_PREFIX}.${randomUUID()}.${"A".repeat(42)}`,
      `${PAYLOAD_PREFIX}.${randomUUID()}.${"A".repeat(44)}`,
      `${PAYLOAD_PREFIX}.${randomUUID()}.${"A".repeat(43)}.extra`,
      `${PAYLOAD_PREFIX}.${randomUUID()}.${"!".repeat(43)}`,
      // Over the length cap, so a 2KB "QR" never reaches the regex engine.
      `${PAYLOAD_PREFIX}.${randomUUID()}.${"A".repeat(43)}${"x".repeat(300)}`,
    ];
    for (const input of rubbish) {
      expect(parsePayload(input), JSON.stringify(input.slice(0, 40))).toBeNull();
    }
  });

  it("a structurally valid but unsigned payload parses and then fails verification", () => {
    // The two steps are separate on purpose: parsing tells the scanner "this
    // is one of ours, look it up", verification tells it "and it is real".
    const id = randomUUID();
    const forged = unsignedPayloadFor(id);
    const parsed = parsePayload(forged);
    expect(parsed?.credentialId).toBe(id);
    expect(signatureMatches(binding({ credentialId: id }), parsed!.signature)).toBe(false);
  });

  it("whitespace around a real payload is tolerated — a scanner adds it, an attacker gains nothing", () => {
    const payload = buildPayload(binding());
    expect(parsePayload(`  ${payload}\n`)?.signature).toBe(payload.split(".")[2]);
  });
});

describe("the key", () => {
  it("fails closed when absent, and does not fall back to a default", () => {
    delete process.env.GATE_QR_SIGNING_KEY;
    expect(credentialSigningConfigured()).toBe(false);
    expect(() => buildPayload(binding())).toThrow(CredentialSigningUnavailableError);
    expect(() => signatureMatches(binding(), "x".repeat(43))).toThrow(CredentialSigningUnavailableError);
  });

  it("refuses a key short enough to be guessed", () => {
    process.env.GATE_QR_SIGNING_KEY = "short";
    expect(credentialSigningConfigured()).toBe(false);
    expect(() => buildPayload(binding())).toThrow(CredentialSigningUnavailableError);
  });

  it("parsing still works with no key, so an unknown QR is answered rather than crashing", () => {
    delete process.env.GATE_QR_SIGNING_KEY;
    expect(parsePayload(`${PAYLOAD_PREFIX}.${randomUUID()}.${"A".repeat(43)}`)).not.toBeNull();
    expect(parsePayload("rubbish")).toBeNull();
  });
});

describe("malformed inputs to buildPayload are refused rather than signed", () => {
  it("a non-UUID identifier or a malformed nonce throws", () => {
    expect(() => buildPayload(binding({ credentialId: "1" }))).toThrow(/UUID/);
    expect(() => buildPayload(binding({ collegeId: "nope" }))).toThrow(/UUID/);
    expect(() => buildPayload(binding({ gatePassId: "" }))).toThrow(/UUID/);
    expect(() => buildPayload(binding({ nonce: "xyz" }))).toThrow(/nonce/);
    expect(() => buildPayload(binding({ nonce: "A".repeat(64) }))).toThrow(/nonce/);
  });
});

describe("the audit fingerprint", () => {
  it("is stable, short, and not reversible to the payload", () => {
    const payload = buildPayload(binding());
    const fp = payloadFingerprint(payload);
    expect(fp).toHaveLength(16);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(payloadFingerprint(payload)).toBe(fp);
    expect(payload).not.toContain(fp);
    expect(payloadFingerprint(`${payload}x`)).not.toBe(fp);
  });

  it("does not need a key, so a refused scan can still be logged", () => {
    delete process.env.GATE_QR_SIGNING_KEY;
    expect(payloadFingerprint("anything at all")).toMatch(/^[0-9a-f]{16}$/);
  });
});
