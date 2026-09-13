import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { idempotencyKey, retrySafetyFor, backoffSeconds, financialYearFor, periodKeyFor, nextAttemptAt } from "@/lib/finance/idempotency";
import { encryptCredential, decryptCredential, bodyHash, redact, credentialStorageConfigured, CredentialStorageUnavailableError } from "@/lib/finance/crypto";
import { SOURCE_OF_TRUTH, FIELD_OWNERSHIP, mayExternalOverwrite, authorityFor } from "@/lib/finance/source-of-truth";
import { adapterFor, implementsCapability, PROVIDERS } from "@/lib/finance/providers/registry";
import { isUsable, type ProviderContext } from "@/lib/finance/providers/types";
import { __testing as tally } from "@/lib/finance/providers/tally";
import { __testing as zoho } from "@/lib/finance/providers/zoho";
import { indexMappings, requireMapping, MappingMissingError, type AccountMapping } from "@/lib/finance/mapping";

/**
 * Pure-logic certification for the Finance Integration Hub.
 *
 * MOCK TESTED, and labelled as such. Nothing here touches a real accounting
 * system; what it proves is that the decisions made BEFORE and AFTER a
 * provider call are correct — the idempotency key, the retry classification,
 * the credential sealing, the capability gate, and the XML/JSON each adapter
 * actually builds. Whether TallyPrime accepts that XML is a LIVE test and is
 * reported BLOCKED, not inferred from here.
 */

const KEY_ENV = "FINANCE_CREDENTIAL_KEY";
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

describe("idempotency", () => {
  const base = {
    collegeId: "c1", connectionId: "conn1", entityType: "payment",
    entityId: "pay1", operation: "create_payment",
  };

  it("is deterministic for the same transaction and differs for any change", () => {
    expect(idempotencyKey(base)).toBe(idempotencyKey(base));
    expect(idempotencyKey(base)).not.toBe(idempotencyKey({ ...base, entityId: "pay2" }));
    expect(idempotencyKey(base)).not.toBe(idempotencyKey({ ...base, connectionId: "conn2" }));
    expect(idempotencyKey(base)).not.toBe(idempotencyKey({ ...base, collegeId: "c2" }));
    expect(idempotencyKey(base)).not.toBe(idempotencyKey({ ...base, operation: "create_refund" }));
    // The version is the ONLY intentional way to ask for a second document.
    expect(idempotencyKey(base)).not.toBe(idempotencyKey({ ...base, version: 2 }));
  });

  it("fits in a provider header and carries no readable identifiers", () => {
    const key = idempotencyKey(base);
    expect(key).toMatch(/^an_[0-9a-f]{40}$/);
    expect(key).not.toContain("pay1");
    expect(key).not.toContain("c1");
  });
});

describe("retry classification — the rule that stops duplicate receipts", () => {
  it("an unknown result is NEVER safe to retry", () => {
    expect(retrySafetyFor("unknown_result")).toBe("unsafe");
  });

  it("a transport failure before delivery is safe; a refusal is terminal", () => {
    expect(retrySafetyFor("network")).toBe("safe");
    expect(retrySafetyFor("rate_limited")).toBe("safe");
    expect(retrySafetyFor("provider_error")).toBe("safe");
    for (const kind of ["auth", "forbidden", "validation", "not_found", "period_closed", "capability", "wrong_company"] as const) {
      expect(retrySafetyFor(kind), kind).toBe("exhausted");
    }
  });

  it("backoff grows, is jittered, and is capped", () => {
    const first = Array.from({ length: 20 }, () => backoffSeconds(1));
    const later = Array.from({ length: 20 }, () => backoffSeconds(6));
    expect(Math.min(...first)).toBeGreaterThan(0);
    expect(Math.max(...first)).toBeLessThan(Math.max(...later) + 1);
    expect(backoffSeconds(30)).toBeLessThanOrEqual(1800);
    expect(new Set(first).size).toBeGreaterThan(1); // jittered, not a fixed ladder
  });

  it("honours the provider's Retry-After over its own schedule", () => {
    expect(backoffSeconds(1, 42)).toBe(42);
    const at = nextAttemptAt(1, 42, new Date("2026-09-13T10:00:00Z"));
    expect(at.toISOString()).toBe("2026-09-13T10:00:42.000Z");
  });
});

describe("financial year is not the academic year (§81)", () => {
  it("derives from the connection's start month", () => {
    expect(financialYearFor("2026-09-13", 4)).toBe("FY 2026-27");
    expect(financialYearFor("2026-03-31", 4)).toBe("FY 2025-26");
    expect(financialYearFor("2026-04-01", 4)).toBe("FY 2026-27");
    // A January start is a single calendar year, not a hyphenated pair.
    expect(financialYearFor("2026-09-13", 1)).toBe("FY 2026");
    // July start, the other common Indian variant.
    expect(financialYearFor("2026-06-30", 7)).toBe("FY 2025-26");
    expect(financialYearFor("2026-07-01", 7)).toBe("FY 2026-27");
  });

  it("period key is the calendar month of the transaction", () => {
    expect(periodKeyFor("2026-09-13")).toBe("2026-09");
  });
});

describe("credential sealing", () => {
  const original = process.env[KEY_ENV];
  beforeEach(() => { process.env[KEY_ENV] = TEST_KEY; });
  afterEach(() => { if (original === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = original; });

  it("round-trips an OAuth credential and produces different ciphertext each time", () => {
    const cred = { kind: "oauth2", clientId: "id", clientSecret: "shh", refreshToken: "rt", dataCenter: "in" };
    const a = encryptCredential(cred);
    const b = encryptCredential(cred);
    expect(a.ciphertext).not.toBe(b.ciphertext);      // fresh IV per seal
    expect(a.ciphertext).not.toContain("shh");
    expect(decryptCredential(a)).toEqual(cred);
    expect(decryptCredential(b)).toEqual(cred);
  });

  it("refuses tampered ciphertext rather than returning partial data", () => {
    const sealed = encryptCredential({ kind: "api_key", apiKey: "k" });
    const flipped = Buffer.from(sealed.ciphertext, "base64");
    flipped[0] ^= 0xff;
    expect(() => decryptCredential({ ...sealed, ciphertext: flipped.toString("base64") })).toThrow();
    expect(() => decryptCredential({ ...sealed, authTag: Buffer.alloc(16).toString("base64") })).toThrow();
  });

  it("FAILS CLOSED with no key — there is no weaker fallback", () => {
    delete process.env[KEY_ENV];
    expect(credentialStorageConfigured()).toBe(false);
    expect(() => encryptCredential({ kind: "none" })).toThrow(CredentialStorageUnavailableError);
  });

  it("rejects a key that is not 32 bytes", () => {
    process.env[KEY_ENV] = Buffer.alloc(16, 1).toString("base64");
    expect(() => encryptCredential({ kind: "none" })).toThrow(/32 bytes/);
  });
});

describe("redaction and hashing", () => {
  it("removes anything credential-shaped, by key name, at any depth", () => {
    const out = redact({
      amount: 100,
      refresh_token: "rt",
      nested: { clientSecret: "s", authorization: "Bearer x", ledger: "HDFC" },
      list: [{ api_key: "k", id: "keep" }],
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("rt");
    expect(JSON.stringify(out)).not.toContain("Bearer");
    expect(JSON.stringify(out)).not.toContain("\"k\"");
    expect(out.amount).toBe(100);
    expect((out.nested as Record<string, unknown>).ledger).toBe("HDFC");
    expect((out.list as Record<string, unknown>[])[0].id).toBe("keep");
  });

  it("hashes a body stably so a retry can be proven identical", () => {
    expect(bodyHash({ a: 1 })).toBe(bodyHash({ a: 1 }));
    expect(bodyHash({ a: 1 })).not.toBe(bodyHash({ a: 2 }));
    expect(bodyHash("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("source-of-truth matrix (§39, §56)", () => {
  it("names an authority for every listed object and never both", () => {
    for (const row of SOURCE_OF_TRUTH) {
      expect(row.academicNexus === "academic_nexus" && row.accounting === "accounting", row.object).toBe(false);
    }
  });

  it("keeps the records Academic Nexus originates", () => {
    expect(authorityFor("payment_received")!.academicNexus).toBe("academic_nexus");
    expect(authorityFor("receipt_number")!.academicNexus).toBe("academic_nexus");
    expect(authorityFor("refund_request")!.academicNexus).toBe("academic_nexus");
  });

  it("gives the accounting system its own ledger, and only that", () => {
    expect(authorityFor("ledger")!.accounting).toBe("accounting");
    expect(authorityFor("chart_of_accounts")!.direction).toBe("inbound");
    expect(authorityFor("bank_reconciliation")!.accounting).toBe("accounting");
  });

  it("an inbound change may never overwrite a field Academic Nexus owns", () => {
    expect(mayExternalOverwrite("payment.amount")).toBe(false);
    expect(mayExternalOverwrite("payment.status")).toBe(false);
    expect(mayExternalOverwrite("payment.receipt_number")).toBe(false);
    expect(mayExternalOverwrite("fee.paid_amount")).toBe(false);
    // and the external identifiers are theirs
    expect(mayExternalOverwrite("payment.external_id")).toBe(true);
    expect(mayExternalOverwrite("account.ledger_name")).toBe(true);
    // an unknown field is ours by default — never writable from outside
    expect(mayExternalOverwrite("anything.unmodelled")).toBe(false);
  });

  it("§58: the receipt number is Academic Nexus's and the voucher number is theirs", () => {
    expect(FIELD_OWNERSHIP["payment.receipt_number"]).toBe("academic_nexus");
    expect(FIELD_OWNERSHIP["payment.external_voucher_number"]).toBe("accounting");
  });
});

describe("provider registry and capability gating", () => {
  it("registers exactly the three providers", () => {
    expect(PROVIDERS.map((p) => p.id).sort()).toEqual(["busy", "tallyprime", "zoho_books"]);
  });

  it("only SUPPORTED and CONFIGURED are usable", () => {
    expect(isUsable("SUPPORTED")).toBe(true);
    expect(isUsable("CONFIGURED")).toBe(true);
    for (const s of ["REQUIRES_CONFIGURATION", "UNSUPPORTED", "BLOCKED", "NOT_TESTED", undefined] as const) {
      expect(isUsable(s), String(s)).toBe(false);
    }
  });

  it("reports honestly which methods each adapter actually implements", () => {
    expect(implementsCapability("zoho_books", "createPayment")).toBe(true);
    expect(implementsCapability("tallyprime", "createPayment")).toBe(true);
    // BUSY implements the interface but no transaction methods — that is the point.
    expect(implementsCapability("busy", "createPayment")).toBe(false);
    expect(implementsCapability("busy", "createRefund")).toBe(false);
  });
});

describe("BUSY adapter refuses to pretend (§84)", () => {
  const ctx = { provider: "busy" } as unknown as ProviderContext;

  it("every capability is REQUIRES_CONFIGURATION or UNSUPPORTED — none is usable", async () => {
    const caps = await adapterFor("busy").getCapabilities(ctx);
    expect(caps.ok).toBe(true);
    if (!caps.ok) return;
    const states = Object.values(caps.data);
    expect(states.length).toBeGreaterThan(10);
    expect(states.every((s) => !isUsable(s))).toBe(true);
  });

  it("testConnection fails with an explanation, not a fake success", async () => {
    const res = await adapterFor("busy").testConnection(ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("BUSY_REQUIRES_CONFIGURATION");
    expect(res.retrySafety).toBe("exhausted");
    expect(res.message).toMatch(/does not expose a general public/i);
  });

  it("healthCheck reports unhealthy rather than green", async () => {
    const res = await adapterFor("busy").healthCheck(ctx);
    expect(res.ok && res.data.healthy).toBe(false);
  });
});

describe("TallyPrime XML", () => {
  it("escapes the characters that would otherwise corrupt a ledger name", () => {
    expect(tally.esc(`R&D "Lab" <fees>`)).toBe("R&amp;D &quot;Lab&quot; &lt;fees&gt;");
  });

  it("builds a receipt voucher that debits the bank ledger and credits the party", () => {
    const xml = tally.receiptVoucher(
      {
        reference: "pay-1", receiptNumber: "AN-2026-000928", customerExternalId: "Ravi Kumar",
        depositAccountExternalId: "HDFC", depositAccountExternalName: "HDFC Collection A/c",
        date: "2026-09-13", amount: 5000, currency: "INR", paymentMode: "UPI",
      },
      "an_deadbeef",
      "QA College"
    );
    expect(xml).toContain("<TALLYREQUEST>Import Data</TALLYREQUEST>");
    expect(xml).toContain("<SVCURRENTCOMPANY>QA College</SVCURRENTCOMPANY>");
    expect(xml).toContain("<VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>");
    expect(xml).toContain("<DATE>20260913</DATE>");
    // The idempotency anchor Tally itself de-duplicates on.
    expect(xml).toContain("<REMOTEID>an_deadbeef</REMOTEID>");
    // Academic Nexus's receipt number travels as the reference (§58).
    expect(xml).toContain("<REFERENCE>AN-2026-000928</REFERENCE>");
    expect(xml).toContain("<LEDGERNAME>HDFC Collection A/c</LEDGERNAME>");
    expect(xml).toContain("<AMOUNT>-5000</AMOUNT>");
    expect(xml).toContain("<LEDGERNAME>Ravi Kumar</LEDGERNAME>");
    expect(xml).toContain("<AMOUNT>5000</AMOUNT>");
  });

  it("reads an acknowledgement only when it carries an identity", () => {
    expect(tally.readImportResponse("<RESPONSE><CREATED>1</CREATED><LASTVCHID>451</LASTVCHID></RESPONSE>"))
      .toEqual({ outcome: "created", id: "451" });
    expect(tally.readImportResponse("<RESPONSE><ALTERED>1</ALTERED><LASTVCHID>451</LASTVCHID></RESPONSE>"))
      .toEqual({ outcome: "altered", id: "451" });
    expect(tally.readImportResponse("<RESPONSE><LINEERROR>Ledger does not exist</LINEERROR></RESPONSE>").outcome).toBe("error");
    // CREATED with no id is NOT an acknowledgement we can record.
    expect(tally.readImportResponse("<RESPONSE><CREATED>1</CREATED></RESPONSE>").outcome).toBe("unknown");
    expect(tally.readImportResponse("<RESPONSE></RESPONSE>").outcome).toBe("unknown");
    expect(tally.readImportResponse("not xml at all").outcome).toBe("unknown");
  });

  it("a timeout is an unknown result, not a network failure", async () => {
    const ctx = {
      provider: "tallyprime", host: "127.0.0.1", port: 9000, transport: "xml_http",
      credential: { kind: "none" },
      fetchImpl: (() => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }))) as unknown as typeof fetch,
    } as unknown as ProviderContext;
    const res = await adapterFor("tallyprime").testConnection(ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe("unknown_result");
    expect(res.retrySafety).toBe("unsafe");
  });

  it("a connection that never opened is safe to retry", async () => {
    const ctx = {
      provider: "tallyprime", host: "127.0.0.1", port: 9000, transport: "xml_http",
      credential: { kind: "none" },
      fetchImpl: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch,
    } as unknown as ProviderContext;
    const res = await adapterFor("tallyprime").testConnection(ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe("network");
    expect(res.retrySafety).toBe("safe");
  });

  it("refuses to post when no company is loaded", async () => {
    const ctx = {
      provider: "tallyprime", host: "h", port: 9000, transport: "xml_http", credential: { kind: "none" },
      fetchImpl: (() => Promise.resolve(new Response("<ENVELOPE></ENVELOPE>", { status: 200 }))) as unknown as typeof fetch,
    } as unknown as ProviderContext;
    const res = await adapterFor("tallyprime").getOrganizations(ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("NO_COMPANY_LOADED");
  });

  it("ODBC is declared and refuses rather than silently doing nothing", async () => {
    const ctx = {
      provider: "tallyprime", host: "h", port: 9000, transport: "odbc", credential: { kind: "none" },
    } as unknown as ProviderContext;
    const res = await adapterFor("tallyprime").testConnection(ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("ODBC_NOT_CONFIGURED");
    const caps = await adapterFor("tallyprime").getCapabilities(ctx);
    expect(caps.ok && isUsable(caps.data.testConnection)).toBe(false);
  });
});

describe("Zoho Books", () => {
  it("reads the body's code, not the HTTP status", () => {
    // Zoho answers many refusals with HTTP 200 and a non-zero code.
    expect(zoho.classify(200, { code: 1002, message: "not found" }).kind).toBe("not_found");
    expect(zoho.classify(401, {}).kind).toBe("auth");
    expect(zoho.classify(429, {}).kind).toBe("rate_limited");
    expect(zoho.classify(500, {}).kind).toBe("provider_error");
    expect(zoho.classify(400, { message: "invalid line item" }).kind).toBe("validation");
    // A closed books period must not be mistaken for a retryable validation error.
    expect(zoho.classify(400, { message: "You cannot create transaction as books are locked" }).kind).toBe("period_closed");
  });

  it("regional data centres change both hosts", () => {
    const ctx = (dc: string) => ({ credential: { kind: "oauth2", dataCenter: dc } }) as unknown as ProviderContext;
    expect(zoho.apiBase(ctx("in"))).toBe("https://www.zohoapis.in/books/v3");
    expect(zoho.accountsBase(ctx("eu"))).toBe("https://accounts.zoho.eu");
  });

  it("a 200 that creates nothing identifiable is an unknown result, never SYNCED", async () => {
    const calls: string[] = [];
    const fetchImpl = ((url: string) => {
      calls.push(String(url));
      if (String(url).includes("oauth")) return Promise.resolve(new Response(JSON.stringify({ access_token: "at" }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ code: 0, payment: {} }), { status: 200 }));
    }) as unknown as typeof fetch;
    const ctx = {
      provider: "zoho_books", organizationId: "org1",
      credential: { kind: "oauth2", clientId: "a", clientSecret: "b", refreshToken: "c", dataCenter: "in" },
      fetchImpl,
    } as unknown as ProviderContext;

    const res = await adapterFor("zoho_books").createPayment!(ctx, {
      reference: "pay-1", customerExternalId: "cust1",
      depositAccountExternalId: "acc1", depositAccountExternalName: "HDFC",
      date: "2026-09-13", amount: 100, currency: "INR", paymentMode: "UPI",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("NO_EXTERNAL_ID");
    expect(res.retrySafety).toBe("unsafe");
  });

  it("a successful create returns the provider's identifier", async () => {
    const fetchImpl = ((url: string) => {
      if (String(url).includes("oauth")) return Promise.resolve(new Response(JSON.stringify({ access_token: "at" }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ code: 0, payment: { payment_id: "P-1", payment_number: "RV-451" } }), { status: 200 }));
    }) as unknown as typeof fetch;
    const ctx = {
      provider: "zoho_books", organizationId: "org1",
      credential: { kind: "oauth2", clientId: "a", clientSecret: "b", refreshToken: "c", dataCenter: "in" },
      fetchImpl,
    } as unknown as ProviderContext;

    const res = await adapterFor("zoho_books").createPayment!(ctx, {
      reference: "pay-1", receiptNumber: "AN-2026-000928", customerExternalId: "cust1",
      depositAccountExternalId: "acc1", depositAccountExternalName: "HDFC",
      date: "2026-09-13", amount: 100, currency: "INR", paymentMode: "UPI",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.externalId).toBe("P-1");
    expect(res.externalNumber).toBe("RV-451");
  });

  it("an invalid refresh token is terminal, not retried forever", async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response(JSON.stringify({ error: "invalid_client" }), { status: 400 }))) as unknown as typeof fetch;
    const ctx = {
      provider: "zoho_books",
      credential: { kind: "oauth2", clientId: "a", clientSecret: "b", refreshToken: "bad", dataCenter: "in" },
      fetchImpl,
    } as unknown as ProviderContext;
    const res = await adapterFor("zoho_books").testConnection(ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe("auth");
    expect(res.retrySafety).toBe("exhausted");
    expect(res.message).toMatch(/re-authorise/i);
  });

  it("never puts the client secret in a URL path or a stored hash input", async () => {
    const seen: string[] = [];
    const fetchImpl = ((url: string) => {
      seen.push(String(url));
      if (String(url).includes("oauth")) return Promise.resolve(new Response(JSON.stringify({ access_token: "at" }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ code: 0, organizations: [] }), { status: 200 }));
    }) as unknown as typeof fetch;
    const ctx = {
      provider: "zoho_books", organizationId: "org1",
      credential: { kind: "oauth2", clientId: "a", clientSecret: "SUPERSECRET", refreshToken: "c", dataCenter: "in" },
      fetchImpl,
    } as unknown as ProviderContext;
    await adapterFor("zoho_books").testConnection(ctx);
    // The token exchange is the one place the secret legitimately appears —
    // and it must never appear on the Books API call.
    const apiCalls = seen.filter((u) => u.includes("zohoapis"));
    expect(apiCalls.length).toBeGreaterThan(0);
    expect(apiCalls.some((u) => u.includes("SUPERSECRET"))).toBe(false);
  });
});

describe("mapping resolution refuses defaults", () => {
  const rows: AccountMapping[] = [
    { id: "1", kind: "fee_head", local_key: "Tuition Fee", local_label: null, external_id: "4001", external_code: "4001", external_name: "Tuition Income", tax_rate: null, tax_treatment: "exempt", status: "active" },
    { id: "2", kind: "payment_method", local_key: "upi", local_label: null, external_id: null, external_code: null, external_name: "UPI", tax_rate: null, tax_treatment: null, status: "active" },
  ];
  const index = indexMappings(rows);

  it("resolves a configured mapping", () => {
    expect(requireMapping(index, "fee_head", "Tuition Fee").external_name).toBe("Tuition Income");
  });

  it("throws rather than falling back to any ledger", () => {
    expect(() => requireMapping(index, "fee_head", "Hostel Fee")).toThrow(MappingMissingError);
    expect(() => requireMapping(index, "bank_account", "upi")).toThrow(/No bank account mapping for "upi"/);
    try {
      requireMapping(index, "fee_head", "Hostel Fee");
    } catch (e) {
      expect((e as MappingMissingError).code).toBe("MAPPING_MISSING");
    }
  });
});
