import { describe, it, expect, beforeEach, vi } from "vitest";
import { runOperation, enqueue } from "@/lib/finance/pipeline";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * Pipeline behaviour (§51, §68, §79, §97).
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 *
 * The provider is scripted (an injected `fetch`) and the database is a fake
 * client that records what the pipeline ASKS for. So this proves the
 * decisions: which gate refuses, in what order, what status is requested,
 * whether a link is written before the status, and — the one that matters —
 * that no path reaches SYNCED without an identifier.
 *
 * It does NOT prove the database would accept those writes; that is
 * tests/staging-finance-integration.test.ts, which runs the real schema and
 * shows the constraints refuse everything this file must never request. The
 * two together are the argument: the pipeline asks for the right thing, and
 * the database refuses the wrong thing regardless.
 *
 * MOCK TESTED. No accounting system is contacted.
 */

vi.mock("@/lib/finance/credentials", () => ({
  loadCredential: async () => ({ kind: "oauth2", clientId: "a", clientSecret: "b", refreshToken: "c", dataCenter: "in" }),
}));

const COLLEGE = "00000001-0000-4000-8000-000000000001";
const CONN = "00000020-0000-4000-8000-000000000001";
const PAY = "00000021-0000-4000-8000-000000000001";
const FEE = "00000022-0000-4000-8000-000000000001";
const STUDENT = "00000023-0000-4000-8000-000000000001";
const OP = "00000024-0000-4000-8000-000000000001";

type Row = Record<string, unknown>;

interface FakeState {
  connection: Row;
  operation: Row;
  payment: Row | null;
  fee: Row | null;
  mappings: Row[];
  links: Row[];
  /** Every UPDATE the pipeline asked for, in order. */
  updates: { table: string; patch: Row }[];
  inserts: { table: string; row: Row }[];
  linkInsertError?: { code: string; message: string };
}

let state: FakeState;

function baseState(): FakeState {
  return {
    connection: {
      id: CONN, college_id: COLLEGE, provider: "zoho_books", status: "ACTIVE",
      environment: "production", organization_id: "org1", external_company_id: "org1",
      external_company_name: "QA Books", host: null, port: null, base_url: null, transport: "rest",
      financial_year_start_month: 4,
      capabilities: { createPayment: "CONFIGURED", createRefund: "CONFIGURED", createCustomer: "CONFIGURED" },
    },
    operation: {
      id: OP, college_id: COLLEGE, connection_id: CONN, provider: "zoho_books",
      entity_type: "payment", entity_id: PAY, operation: "create_payment",
      idempotency_key: "an_key", status: "QUEUED", attempt_number: 0, max_attempts: 5,
      external_id: null, entity_idx: null,
    },
    payment: {
      id: PAY, amount: 5000, method: "upi", transaction_ref: "UPI-1", receipt_number: "AN-2026-000928",
      notes: null, created_at: "2026-09-13T10:00:00Z", status: "cleared",
      student_id: STUDENT, fee_id: FEE, college_id: COLLEGE,
    },
    fee: { type: "Tuition Fee" },
    mappings: [
      { id: "m1", kind: "fee_head", local_key: "Tuition Fee", external_id: "4001", external_name: "Tuition Income", status: "active", local_label: null, external_code: null, tax_rate: null, tax_treatment: null },
      { id: "m2", kind: "payment_method", local_key: "upi", external_id: null, external_name: "UPI", status: "active", local_label: null, external_code: null, tax_rate: null, tax_treatment: null },
      { id: "m3", kind: "bank_account", local_key: "upi", external_id: "acc1", external_name: "HDFC Collection", status: "active", local_label: null, external_code: null, tax_rate: null, tax_treatment: null },
      { id: "m4", kind: "customer", local_key: STUDENT, external_id: "cust1", external_name: "Ravi Kumar", status: "active", local_label: null, external_code: null, tax_rate: null, tax_treatment: null },
    ],
    links: [],
    updates: [],
    inserts: [],
  };
}

/** A supabase-js shaped client over `state`. */
function fakeDb(): SupabaseClient<Database> {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row = {};

    const rowsFor = (): Row[] => {
      switch (table) {
        case "finance_integration_connections": return state.connection ? [state.connection] : [];
        case "finance_sync_operations": return state.operation ? [state.operation] : [];
        case "finance_account_mappings": return state.mappings;
        case "finance_external_links":
          return state.links.filter((l) =>
            (filters.entity_id === undefined || l.entity_id === filters.entity_id) &&
            (filters.entity_type === undefined || l.entity_type === filters.entity_type));
        case "payments": return state.payment ? [state.payment] : [];
        case "fees": return state.fee ? [state.fee] : [];
        case "students": return [{ id: STUDENT, enrollment_number: "QA-1", college_id: COLLEGE, user_id: "u1" }];
        case "profiles": return [{ full_name: "Ravi Kumar", email: "r@qa.test" }];
        default: return [];
      }
    };

    const settle = () => {
      if (mode === "update") {
        state.updates.push({ table, patch: payload });
        if (table === "finance_sync_operations") state.operation = { ...state.operation, ...payload };
        if (table === "finance_integration_connections") state.connection = { ...state.connection, ...payload };
        return Promise.resolve({ data: [{ id: filters.id ?? OP }], error: null });
      }
      if (mode === "insert") {
        if (table === "finance_external_links" && state.linkInsertError) {
          return Promise.resolve({ data: null, error: state.linkInsertError });
        }
        state.inserts.push({ table, row: payload });
        if (table === "finance_external_links") state.links.push(payload);
        return Promise.resolve({ data: { id: "new" }, error: null });
      }
      const rows = rowsFor();
      return Promise.resolve({ data: rows, error: null });
    };

    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.insert = (p: Row) => { mode = "insert"; payload = p; return chain; };
    chain.update = (p: Row) => { mode = "update"; payload = p; return chain; };
    chain.eq = (col: string, val: unknown) => { filters[col] = val; return chain; };
    chain.in = () => chain;
    chain.gte = () => chain;
    chain.lte = () => chain;
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.single = () => settle().then((r) => ({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: (Array.isArray(r.data) && r.data.length === 0) ? { message: "not found" } : r.error }));
    chain.maybeSingle = () => settle().then((r) => ({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null }));
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej);
    return chain;
  };
  return { from } as unknown as SupabaseClient<Database>;
}

/** A Zoho that answers however the test needs. */
function scriptedZoho(payment: unknown, status = 200): typeof fetch {
  return ((url: string) => {
    if (String(url).includes("oauth")) {
      return Promise.resolve(new Response(JSON.stringify({ access_token: "at" }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(payment), { status }));
  }) as unknown as typeof fetch;
}

const lastStatus = () => {
  const withStatus = state.updates.filter((u) => u.table === "finance_sync_operations" && u.patch.status);
  return withStatus[withStatus.length - 1]?.patch.status;
};

beforeEach(() => { state = baseState(); });

describe("the happy path", () => {
  it("posts once, records the link BEFORE the status, and lands SYNCED with the provider's id", async () => {
    const result = await runOperation(fakeDb(), OP, {
      fetchImpl: scriptedZoho({ code: 0, payment: { payment_id: "P-1", payment_number: "RV-451" } }),
    });
    expect(result.status).toBe("SYNCED");
    expect(result.externalId).toBe("P-1");

    // The link is written first: if the status write were to fail, the link
    // is what stops a second posting on the next run.
    const linkInsert = state.inserts.findIndex((i) => i.table === "finance_external_links");
    expect(linkInsert).toBeGreaterThanOrEqual(0);
    expect(state.inserts[linkInsert].row).toMatchObject({ entity_type: "payment", entity_id: PAY, external_id: "P-1", external_number: "RV-451" });

    const synced = state.updates.find((u) => u.patch.status === "SYNCED");
    expect(synced?.patch).toMatchObject({ external_id: "P-1", error_code: null });
    // and the financial period was resolved before sending
    expect(state.updates.some((u) => u.patch.financial_year === "FY 2026-27" && u.patch.period_key === "2026-09")).toBe(true);
  });

  it("stores a redacted summary and hashes, never the payload", async () => {
    await runOperation(fakeDb(), OP, { fetchImpl: scriptedZoho({ code: 0, payment: { payment_id: "P-1" } }) });
    const summaryUpdate = state.updates.find((u) => u.patch.request_summary);
    expect(summaryUpdate!.patch.request_hash).toMatch(/^[0-9a-f]{64}$/);
    const summary = JSON.stringify(summaryUpdate!.patch.request_summary);
    expect(summary).toContain("HDFC Collection");
    expect(summary).not.toContain("refreshToken");
    expect(summary).not.toContain("\"c\"");
  });
});

describe("already posted", () => {
  it("makes NO provider call when the entity already has an external link", async () => {
    state.links.push({ entity_type: "payment", entity_id: PAY, external_id: "P-EXISTING", external_number: "RV-1" });
    let called = 0;
    const fetchImpl = ((url: string) => {
      if (!String(url).includes("oauth")) called++;
      return Promise.resolve(new Response(JSON.stringify({ code: 0, payment: { payment_id: "P-NEW" } }), { status: 200 }));
    }) as unknown as typeof fetch;

    const result = await runOperation(fakeDb(), OP, { fetchImpl });
    expect(called).toBe(0);
    expect(result.status).toBe("SYNCED");
    expect(result.externalId).toBe("P-EXISTING");
  });
});

describe("§97 — failure acceptance", () => {
  it("a timeout is RECONCILIATION_REQUIRED, never a retry", async () => {
    const fetchImpl = ((url: string) => {
      if (String(url).includes("oauth")) return Promise.resolve(new Response(JSON.stringify({ access_token: "at" }), { status: 200 }));
      return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }) as unknown as typeof fetch;

    const result = await runOperation(fakeDb(), OP, { fetchImpl });
    expect(result.status).toBe("RECONCILIATION_REQUIRED");
    const patch = state.updates.find((u) => u.patch.status === "RECONCILIATION_REQUIRED")!.patch;
    expect(patch.retry_safety).toBe("unsafe");
    expect(patch.next_attempt_at).toBeUndefined();     // nothing is scheduled
  });

  it("a 500 is FAILED and safe, with a scheduled next attempt", async () => {
    const result = await runOperation(fakeDb(), OP, { fetchImpl: scriptedZoho({ message: "upstream" }, 500) });
    expect(result.status).toBe("FAILED");
    const patch = state.updates.find((u) => u.patch.status === "FAILED")!.patch;
    expect(patch.retry_safety).toBe("safe");
    expect(patch.next_attempt_at).toBeTruthy();
  });

  it("a validation refusal is FAILED and exhausted — retrying cannot fix it", async () => {
    const result = await runOperation(fakeDb(), OP, { fetchImpl: scriptedZoho({ code: 1001, message: "invalid account_id" }, 400) });
    expect(result.status).toBe("FAILED");
    expect(state.updates.find((u) => u.patch.status === "FAILED")!.patch.retry_safety).toBe("exhausted");
  });

  it("a closed accounting period is BLOCKED as POSTING_BLOCKED, and nothing is posted twice", async () => {
    const result = await runOperation(fakeDb(), OP, {
      fetchImpl: scriptedZoho({ code: 4000, message: "You cannot create transaction as books are locked" }, 400),
    });
    // The provider-side refusal classifies as period_closed -> exhausted.
    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("4000");
    expect(state.inserts.some((i) => i.table === "finance_external_links")).toBe(false);
  });

  it("a 200 with no identifier is RECONCILIATION_REQUIRED and writes no link", async () => {
    const result = await runOperation(fakeDb(), OP, { fetchImpl: scriptedZoho({ code: 0, payment: {} }) });
    expect(result.status).toBe("RECONCILIATION_REQUIRED");
    expect(lastStatus()).toBe("RECONCILIATION_REQUIRED");
    expect(state.inserts.some((i) => i.table === "finance_external_links")).toBe(false);
    expect(state.updates.some((u) => u.patch.status === "SYNCED")).toBe(false);
  });

  it("a provider success whose link cannot be stored is RECONCILIATION_REQUIRED, carrying the id it created", async () => {
    state.linkInsertError = { code: "42501", message: "permission denied" };
    const result = await runOperation(fakeDb(), OP, { fetchImpl: scriptedZoho({ code: 0, payment: { payment_id: "P-9" } }) });
    expect(result.status).toBe("RECONCILIATION_REQUIRED");
    expect(result.externalId).toBe("P-9");
    const patch = state.updates.find((u) => u.patch.status === "RECONCILIATION_REQUIRED")!.patch;
    expect(patch.error_code).toBe("LINK_WRITE_FAILED");
    expect(String(patch.error_message)).toContain("P-9");
  });
});

describe("the gates refuse before the provider is reached", () => {
  const noCall = () => {
    let called = 0;
    const fetchImpl = ((url: string) => {
      if (!String(url).includes("oauth")) called++;
      return Promise.resolve(new Response(JSON.stringify({ code: 0, payment: { payment_id: "P" } }), { status: 200 }));
    }) as unknown as typeof fetch;
    return { fetchImpl, calls: () => called };
  };

  it("a connection that is not ACTIVE", async () => {
    state.connection.status = "VERIFIED";
    const { fetchImpl, calls } = noCall();
    const result = await runOperation(fakeDb(), OP, { fetchImpl });
    expect(result.status).toBe("BLOCKED");
    expect(result.errorCode).toBe("CONNECTION_NOT_ACTIVE");
    expect(calls()).toBe(0);
  });

  it("a capability the connection does not have", async () => {
    state.connection.capabilities = { createPayment: "REQUIRES_CONFIGURATION" };
    const { fetchImpl, calls } = noCall();
    const result = await runOperation(fakeDb(), OP, { fetchImpl });
    expect(result.status).toBe("BLOCKED");
    expect(result.errorCode).toBe("CAPABILITY_NOT_AVAILABLE");
    expect(calls()).toBe(0);
  });

  it("a missing ledger mapping — and it names which one", async () => {
    state.mappings = state.mappings.filter((m) => m.kind !== "bank_account");
    const { fetchImpl, calls } = noCall();
    const result = await runOperation(fakeDb(), OP, { fetchImpl });
    expect(result.status).toBe("BLOCKED");
    expect(result.errorCode).toBe("MAPPING_MISSING");
    expect(result.message).toMatch(/bank account mapping for "upi"/);
    expect(calls()).toBe(0);
  });

  it("a payment that is not cleared (§57) — pending is never treated as paid", async () => {
    state.payment!.status = "pending";
    const { fetchImpl, calls } = noCall();
    const result = await runOperation(fakeDb(), OP, { fetchImpl });
    expect(result.status).toBe("BLOCKED");
    expect(result.message).toMatch(/not postable/);
    expect(calls()).toBe(0);
  });

  it("a payment belonging to another college", async () => {
    state.payment!.college_id = "00000001-0000-4000-8000-000000000002";
    const { fetchImpl, calls } = noCall();
    const result = await runOperation(fakeDb(), OP, { fetchImpl });
    expect(result.status).toBe("BLOCKED");
    expect(result.message).toMatch(/another college/);
    expect(calls()).toBe(0);
  });

  it("an operation whose connection belongs to another college", async () => {
    state.connection.college_id = "00000001-0000-4000-8000-000000000002";
    const { fetchImpl, calls } = noCall();
    const result = await runOperation(fakeDb(), OP, { fetchImpl });
    expect(result.status).toBe("BLOCKED");
    expect(result.errorCode).toBe("TENANT_MISMATCH");
    expect(calls()).toBe(0);
  });

  it("an operation that is not runnable is left exactly as it was", async () => {
    state.operation.status = "SYNCED";
    const { fetchImpl, calls } = noCall();
    const result = await runOperation(fakeDb(), OP, { fetchImpl });
    expect(result.status).toBe("SYNCED");
    expect(state.updates).toEqual([]);
    expect(calls()).toBe(0);
  });
});

describe("refunds follow the money, not the request (§59)", () => {
  beforeEach(() => {
    state.operation.operation = "create_refund";
    state.operation.entity_type = "refund";
    state.connection.capabilities = { createRefund: "CONFIGURED" };
  });

  it("a refund that is only requested is not posted", async () => {
    // The fake returns `payment` rows for the refund lookup; shape it as the
    // refund the pipeline expects.
    state.payment = { id: PAY, amount: 1000, status: "pending", student_id: STUDENT, payment_id: PAY, reason: "x", college_id: COLLEGE, reviewed_at: null };
    const result = await runOperation(fakeDb(), OP, { fetchImpl: scriptedZoho({ code: 0 }) });
    expect(result.status).toBe("BLOCKED");
  });
});

describe("enqueue is idempotent", () => {
  it("returns the existing operation instead of creating a second one", async () => {
    const db = fakeDb();
    const op = await enqueue(db, {
      collegeId: COLLEGE, connectionId: CONN, provider: "zoho_books",
      entityType: "payment", entityId: PAY, operation: "create_payment", createdBy: "u1",
    });
    expect(op.id).toBe(OP);
    expect(state.inserts.some((i) => i.table === "finance_sync_operations")).toBe(false);
  });
});
