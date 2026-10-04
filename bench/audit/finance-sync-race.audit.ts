import { describe, it, expect, beforeEach, vi } from "vitest";
import { runOperation } from "@/lib/finance/pipeline";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

/**
 * AUDIT (section 9/22/23): can two finance-sync runs post the same operation twice?
 *
 * The fake database is the one in tests/finance-pipeline.test.ts, changed in
 * one way: an UPDATE of the operation honours its equality filters, as
 * PostgREST does. So a compare-and-swap claim (`.eq("status", "QUEUED")`)
 * would make the second runner lose; an unconditional claim would not.
 *
 * Two runners start together (a QStash redelivery overlapping a slow run, or
 * "Sync now" pressed during the cron tick). Each provider call yields, so
 * both runners pass the status check before either posts.
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

    // Every statement takes DB_MS, like a round trip to Supabase, and takes
    // effect when it arrives, not when it is issued.
    const settle = (): Promise<{ data: unknown; error: unknown }> =>
      new Promise((r) => setTimeout(r, DB_MS)).then(() => settleNow() as Promise<{ data: unknown; error: unknown }>);
    const settleNow = () => {
      if (mode === "update") {
        state.updates.push({ table, patch: payload });
        if (table === "finance_sync_operations") {
          const matches = Object.entries(filters).every(([k, v]) => state.operation[k] === v);
          if (!matches) return Promise.resolve({ data: [], error: null });
          state.operation = { ...state.operation, ...payload };
        }
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


let providerPosts = 0;
function slowZoho(): typeof fetch {
  return (async (url: string) => {
    if (String(url).includes("oauth")) return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
    providerPosts++;
    await new Promise((r) => setTimeout(r, 30));
    return new Response(JSON.stringify({ code: 0, payment: { payment_id: "P-" + providerPosts, payment_number: "RV-" + providerPosts } }), { status: 200 });
  }) as unknown as typeof fetch;
}

const DB_MS = 10;

beforeEach(async () => {
  // Warm-up run: the pipeline imports its credential module lazily, and two
  // runners resolving that mocked import in the same tick get different
  // modules (a vitest artifact). One complete run first caches the import.
  state = baseState();
  await runOperation(fakeDb(), OP, { fetchImpl: slowZoho() });
  state = baseState();
  providerPosts = 0;
});

describe("finance sync claim", () => {
  it("two concurrent runners of one QUEUED operation", async () => {
    const [a, b] = await Promise.all([
      runOperation(fakeDb(), OP, { fetchImpl: slowZoho() }),
      runOperation(fakeDb(), OP, { fetchImpl: slowZoho() }),
    ]);
    const finding = {
      providerPostsForOneOperation: providerPosts,
      outcomes: [a, b],
      linksWritten: state.links.length,
      cause: "lib/finance/pipeline.ts reads the status, checks it in memory, then claims with an UPDATE filtered only by id.",
    };
    const path = "bench/results/redis-audit.json";
    const all = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    all.financeSyncDoubleClaim = finding;
    writeFileSync(path, JSON.stringify(all, null, 2) + String.fromCharCode(10));
    // Documents the CURRENT behaviour. When the claim becomes a compare-and-swap, this becomes 1.
    expect(providerPosts).toBe(2);
  });
});
