import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { readFileSync } from "node:fs";
import { startCluster, session, concurrently, owner, REAL_PG_AVAILABLE, type Cluster } from "./realpg/harness";
import { U, S, COLLEGE_A, FEE_A } from "./staging/harness";

/**
 * ONE logical accounting operation, AT MOST ONE external posting —
 * proved with the real pipeline code (lib/finance/pipeline.ts) against real
 * PostgreSQL with real concurrent sessions.
 *
 * HOW. The pipeline talks to the database through a supabase-js shaped
 * client. Here that client translates each call into one SQL statement run
 * in its OWN psql session — so every statement autocommits, exactly as a
 * PostgREST request does, and N workers are N genuinely concurrent database
 * clients. Nothing about the race is simulated: the row locks, the
 * READ COMMITTED re-check of the claim's WHERE clause, and the 049/056
 * triggers are PostgreSQL's own.
 *
 * The accounting provider is a scripted Zoho (the adapter is real; only
 * fetch is replaced). It counts DOCUMENTS CREATED — the number that must
 * never exceed one — separately from requests received.
 *
 * MOCK BOUNDARY: credentials (lib/finance/credentials.ts needs the
 * encryption key and the vault table) and the provider's HTTP endpoint.
 */

vi.mock("@/lib/finance/credentials", () => ({
  loadCredential: async () => ({ kind: "oauth2", clientId: "a", clientSecret: "b", refreshToken: "c", dataCenter: "in" }),
}));
const { runOperation } = await import("@/lib/finance/pipeline");

vi.setConfig({ testTimeout: 600_000, hookTimeout: 300_000 });
const maybe = REAL_PG_AVAILABLE ? describe : describe.skip;
if (!REAL_PG_AVAILABLE) {
  describe("finance sync claim (real PostgreSQL)", () => {
    it.skip("BLOCKED: no PostgreSQL binary on this machine", () => {});
  });
}

// ─────────────────────────────────────────────────────────────
// A supabase-js shaped client over psql: one statement, one session.
// Covers exactly the builder calls lib/finance/pipeline.ts and
// lib/finance/mapping.ts make.
// ─────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code: string; message: string } | null };

function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return `'${s.replace(/'/g, "''")}'`;
}

let statements = 0;
function pgClient(cluster: Cluster, db: string): SupabaseClient<Database> {
  const from = (table: string) => {
    let mode: "select" | "update" | "insert" = "select";
    let cols = "*";
    let payload: Row = {};
    const where: string[] = [];
    let limit: number | null = null;

    const sql = () => {
      const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
      if (mode === "select") {
        return `SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT ${cols} FROM public.${table} ${w}${limit ? ` LIMIT ${limit}` : ""}) t;`;
      }
      if (mode === "update") {
        const set = Object.entries(payload).map(([k, v]) => `${k} = ${lit(v)}`).join(", ");
        return `WITH u AS (UPDATE public.${table} SET ${set} ${w} RETURNING *) SELECT coalesce(json_agg(u), '[]'::json) FROM u;`;
      }
      const keys = Object.keys(payload);
      return `WITH i AS (INSERT INTO public.${table} (${keys.join(", ")}) VALUES (${keys.map((k) => lit(payload[k])).join(", ")}) RETURNING *) SELECT coalesce(json_agg(i), '[]'::json) FROM i;`;
    };

    const exec = async (): Promise<Result> => {
      statements++;
      const r = await session(cluster, db, `\\set VERBOSITY verbose\n${sql()}`);
      if (r.code !== 0) {
        const m = r.stderr.match(/ERROR:\s+([0-9A-Z]{5}):\s*(.*)/);
        return { data: null, error: { code: m?.[1] ?? "XX000", message: m?.[2] ?? r.stderr } };
      }
      return { data: JSON.parse(r.stdout || "[]"), error: null };
    };

    const chain: Record<string, unknown> = {};
    chain.select = (c = "*") => {
      if (mode === "select") cols = c;
      return chain;
    };
    chain.update = (p: Row) => ((mode = "update"), (payload = p), chain);
    chain.insert = (p: Row) => ((mode = "insert"), (payload = p), chain);
    chain.eq = (c: string, v: unknown) => (where.push(`${c} = ${lit(v)}`), chain);
    chain.neq = (c: string, v: unknown) => (where.push(`${c} <> ${lit(v)}`), chain);
    chain.in = (c: string, vs: unknown[]) => (where.push(`${c} IN (${vs.map(lit).join(", ")})`), chain);
    chain.order = () => chain;
    chain.limit = (n: number) => ((limit = n), chain);
    chain.single = async () => {
      const r = await exec();
      if (r.error) return r;
      const rows = r.data as Row[];
      return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { code: "PGRST116", message: `${rows.length} rows` } };
    };
    chain.maybeSingle = async () => {
      const r = await exec();
      if (r.error) return r;
      return { data: (r.data as Row[])[0] ?? null, error: null };
    };
    chain.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => exec().then(res, rej);
    return chain;
  };
  return { from } as unknown as SupabaseClient<Database>;
}

// ─────────────────────────────────────────────────────────────
// A scripted Zoho Books
// ─────────────────────────────────────────────────────────────

type Mode =
  | "ok"
  | "http500" // refused, nothing created
  | "http500AfterCreate" // created, then answered a JSON 500
  | "garbageAfterCreate" // created, then a gateway page instead of JSON
  | "lostAfterCreate" // created, then the connection dropped before the response
  | "timeoutAfterCreate" // created, then the client gave up waiting (AbortError)
  | "refused" // ECONNREFUSED: nothing was sent
  | "hang"; // never answers (a worker that dies mid-call)

class Provider {
  documents: { id: string; reference: string }[] = [];
  posts = 0;
  lookups = 0;
  constructor(public mode: Mode, public delayMs = 50) {}

  fetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("oauth")) return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && url.includes("/customerpayments")) {
      this.lookups++;
      const ref = new URL(url).searchParams.get("reference_number");
      const hit = this.documents.find((d) => d.reference === ref);
      return new Response(
        JSON.stringify({ code: 0, customerpayments: hit ? [{ payment_id: hit.id, payment_number: `RV-${hit.id}`, reference_number: ref, amount: 1500, date: "2026-10-04" }] : [] }),
        { status: 200 }
      );
    }
    if (method !== "POST" || !url.includes("/customerpayments")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });

    this.posts++;
    if (this.mode === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    if (this.mode === "hang") return new Promise<Response>(() => {});
    await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.mode === "http500") return new Response(JSON.stringify({ code: 500, message: "internal error" }), { status: 500 });

    const body = JSON.parse(String(init?.body ?? "{}"));
    const id = `P-${this.documents.length + 1}`;
    this.documents.push({ id, reference: body.reference_number });
    if (this.mode === "http500AfterCreate") return new Response(JSON.stringify({ code: 500, message: "internal error" }), { status: 500 });
    if (this.mode === "garbageAfterCreate") return new Response("<html>502 bad gateway</html>", { status: 502 });
    if (this.mode === "lostAfterCreate") throw new TypeError("Network connection lost.");
    if (this.mode === "timeoutAfterCreate") throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return new Response(JSON.stringify({ code: 0, payment: { payment_id: id, payment_number: `RV-${id}` } }), { status: 200 });
  }) as unknown as typeof fetch;
}

// ─────────────────────────────────────────────────────────────

maybe("finance sync claim (real PostgreSQL)", () => {
  let cluster: Cluster;
  beforeAll(() => {
    cluster = startCluster();
  });
  afterAll(() => cluster?.stop());

  /** An ACTIVE Zoho connection with complete mappings, and `payments` cleared payments each with a QUEUED operation. */
  function scenario(db: string, payments = 1) {
    const conn = owner(cluster, db,
      `INSERT INTO finance_integration_connections (college_id, provider, display_name, status, external_company_id, external_company_name, organization_id, created_by)
       VALUES ('${COLLEGE_A}','zoho_books','QA Books','DRAFT','org1','QA Books','org1','${U.admin}') RETURNING id`);
    for (const s of ["CONFIGURING", "AUTH_REQUIRED", "AUTHENTICATED", "VERIFIED", "ACTIVE"]) {
      owner(cluster, db, `UPDATE finance_integration_connections SET status='${s}' WHERE id='${conn}'`);
    }
    owner(cluster, db, `UPDATE finance_integration_connections SET capabilities='{"createPayment":"CONFIGURED"}'::jsonb WHERE id='${conn}'`);
    const feeType = owner(cluster, db, `SELECT type FROM fees WHERE id='${FEE_A}'`);
    for (const [kind, key, ext] of [["fee_head", feeType, "4001"], ["payment_method", "upi", null], ["bank_account", "upi", "acc1"], ["customer", S.a, "cust1"]]) {
      owner(cluster, db,
        `INSERT INTO finance_account_mappings (college_id, connection_id, kind, local_key, external_id, external_name, created_by)
         VALUES ('${COLLEGE_A}','${conn}','${kind}',${lit(key)},${lit(ext)},'${kind} name','${U.admin}')`);
    }
    const ops: string[] = [];
    for (let i = 0; i < payments; i++) {
      const pay = owner(cluster, db,
        `INSERT INTO payments (college_id, fee_id, student_id, amount, method, status, processed_by)
         VALUES ('${COLLEGE_A}','${FEE_A}','${S.a}',100,'upi','cleared','${U.finance}') RETURNING id`);
      ops.push(owner(cluster, db,
        `INSERT INTO finance_sync_operations (college_id, connection_id, provider, entity_type, entity_id, operation, idempotency_key, status, system_actor)
         VALUES ('${COLLEGE_A}','${conn}','zoho_books','payment','${pay}','create_payment','an_${pay.slice(0, 8)}_${i}','PENDING','scheduler') RETURNING id`));
      owner(cluster, db, `UPDATE finance_sync_operations SET status='QUEUED' WHERE id='${ops[i]}'`);
    }
    return { conn, ops };
  }

  const opState = (db: string, op: string) =>
    owner(cluster, db, `SELECT status || '|' || attempt_number || '|' || coalesce(retry_safety,'-') || '|' || coalesce(external_id,'-') FROM finance_sync_operations WHERE id='${op}'`);
  const links = (db: string) => Number(owner(cluster, db, `SELECT count(*) FROM finance_external_links`));
  const workers = (db: string, op: string, n: number, provider: Provider) =>
    Promise.all(Array.from({ length: n }, () => runOperation(pgClient(cluster, db), op, { fetchImpl: provider.fetch }).catch((e: Error) => ({ status: "THREW", message: e.message }))));

  it("warm-up: one worker, one operation, one document (sequential baseline)", async () => {
    const db = cluster.fork();
    try {
      const { ops } = scenario(db);
      const provider = new Provider("ok");
      const out = await runOperation(pgClient(cluster, db), ops[0], { fetchImpl: provider.fetch });
      expect(out.status).toBe("SYNCED");
      expect(provider.documents).toHaveLength(1);
      expect(opState(db, ops[0])).toBe("SYNCED|1|-|P-1");
      expect(links(db)).toBe(1);
    } finally {
      cluster.drop(db);
    }
  });

  describe("the race, at the SQL level", () => {
    // Exactly the statement the pre-fix pipeline issued: attempt from a stale read, started_at = now().
    const OLD_CLAIM = (op: string) =>
      `UPDATE finance_sync_operations SET status='PROCESSING', started_at=clock_timestamp(), attempt_number=1 WHERE id='${op}';`;
    const NEW_CLAIM = (op: string) =>
      `UPDATE finance_sync_operations SET status='PROCESSING', attempt_number=1 WHERE id='${op}' AND status='QUEUED' AND attempt_number=0;`;

    it("REPRODUCED under the 049 guard: the old claim lets two sessions both claim one operation", async () => {
      const db = cluster.fork();
      try {
        // Put back the 049 guard function in this one database.
        const sql049 = readFileSync("supabase/migrations/049_finance_integration_hub.sql", "utf8").replace(/\r\n/g, "\n");
        const start = sql049.indexOf("CREATE OR REPLACE FUNCTION public.guard_finance_sync_operation()");
        // Through stdin, not -c: the function text has non-ASCII characters
        // that a Windows command line would mangle.
        const restored = await session(cluster, db, sql049.slice(start, sql049.indexOf("\n$$;", start) + 4));
        expect(restored.code, restored.stderr).toBe(0);
        const { ops } = scenario(db);
        const [a, b] = await concurrently(
          session(cluster, db, `BEGIN; ${OLD_CLAIM(ops[0])} SELECT pg_sleep(1); COMMIT;`),
          session(cluster, db, `SELECT pg_sleep(0.3); ${OLD_CLAIM(ops[0])}`)
        );
        expect(a.code, a.stderr).toBe(0);
        expect(b.code, b.stderr).toBe(0); // the second claim of a PROCESSING row passed
      } finally {
        cluster.drop(db);
      }
    });

    it("056 refuses the old code's second claim, byte for byte", async () => {
      const db = cluster.fork();
      try {
        const { ops } = scenario(db);
        const [a, b] = await concurrently(
          session(cluster, db, `BEGIN; ${OLD_CLAIM(ops[0])} SELECT pg_sleep(1); COMMIT;`),
          session(cluster, db, `SELECT pg_sleep(0.3); ${OLD_CLAIM(ops[0])}`)
        );
        expect(a.code, a.stderr).toBe(0);
        expect(b.code).not.toBe(0);
        expect(b.stderr).toMatch(/already claimed/);
        expect(opState(db, ops[0])).toBe("PROCESSING|1|-|-");
      } finally {
        cluster.drop(db);
      }
    });

    it("the compare-and-swap claim: the second session waits on the row lock, re-checks, and matches nothing", async () => {
      const db = cluster.fork();
      try {
        const { ops } = scenario(db);
        const [a, b] = await concurrently(
          session(cluster, db, `BEGIN; ${NEW_CLAIM(ops[0])} SELECT pg_sleep(1); COMMIT;`),
          session(cluster, db, `SELECT pg_sleep(0.3); ${NEW_CLAIM(ops[0])}`)
        );
        expect(a.code, a.stderr).toBe(0);
        expect(b.code, b.stderr).toBe(0);
        expect(a.stdout).toBe("");
        // psql -q prints nothing for UPDATE; ask the row instead.
        expect(opState(db, ops[0])).toBe("PROCESSING|1|-|-");
        const claims = Number(owner(cluster, db, `SELECT count(*) FROM finance_sync_operations WHERE id='${ops[0]}' AND attempt_number=1`));
        expect(claims).toBe(1);
      } finally {
        cluster.drop(db);
      }
    });
  });

  describe("concurrent workers, real pipeline: at most one document", () => {
    for (const n of [2, 5, 20, 100]) {
      it(`${n} workers on one QUEUED operation`, async () => {
        const db = cluster.fork();
        try {
          const { ops } = scenario(db);
          const provider = new Provider("ok", 200);
          const out = await workers(db, ops[0], n, provider);
          const statuses = out.map((o) => o.status);
          expect(provider.posts).toBe(1);
          expect(provider.documents).toHaveLength(1);
          expect(links(db)).toBe(1);
          expect(statuses.filter((s) => s === "SYNCED")).toHaveLength(1);
          expect(statuses.filter((s) => s === "THREW")).toHaveLength(0);
          expect(opState(db, ops[0])).toBe("SYNCED|1|-|P-1");
        } finally {
          cluster.drop(db);
        }
      });
    }

    it("the application's compare-and-swap holds on its own: 20 workers under the 049 guard (before 056)", async () => {
      const db = cluster.fork();
      try {
        const sql049 = readFileSync("supabase/migrations/049_finance_integration_hub.sql", "utf8").replace(/\r\n/g, "\n");
        const start = sql049.indexOf("CREATE OR REPLACE FUNCTION public.guard_finance_sync_operation()");
        const restored = await session(cluster, db, sql049.slice(start, sql049.indexOf("\n$$;", start) + 4));
        expect(restored.code, restored.stderr).toBe(0);
        const { ops } = scenario(db);
        const provider = new Provider("ok", 200);
        await workers(db, ops[0], 20, provider);
        expect(provider.documents).toHaveLength(1);
        expect(opState(db, ops[0])).toBe("SYNCED|1|-|P-1");
      } finally {
        cluster.drop(db);
      }
    });

    it("10 workers on each of 3 different receipts: exactly one document per receipt", async () => {
      const db = cluster.fork();
      try {
        const { ops } = scenario(db, 3);
        const provider = new Provider("ok", 150);
        await Promise.all(ops.map((op) => workers(db, op, 10, provider)));
        expect(provider.documents).toHaveLength(3);
        expect(new Set(provider.documents.map((d) => d.reference)).size).toBe(3);
        expect(links(db)).toBe(3);
        for (const op of ops) expect(opState(db, op)).toMatch(/^SYNCED\|1\|/);
      } finally {
        cluster.drop(db);
      }
    });

    it("sequential duplicate: the same receipt run twice is posted once", async () => {
      const db = cluster.fork();
      try {
        const { ops } = scenario(db);
        const provider = new Provider("ok");
        await runOperation(pgClient(cluster, db), ops[0], { fetchImpl: provider.fetch });
        const second = await runOperation(pgClient(cluster, db), ops[0], { fetchImpl: provider.fetch });
        expect(second.message).toMatch(/Not runnable from SYNCED/);
        expect(provider.documents).toHaveLength(1);
      } finally {
        cluster.drop(db);
      }
    });
  });

  describe("failures: an uncertain outcome is never posted again", () => {
    /** Operator retry exactly as app/(portal)/finance/integrations/actions.ts does it. */
    const operatorRetry = (db: string, op: string) =>
      session(cluster, db, `UPDATE finance_sync_operations SET status='RETRYING', next_attempt_at=now() WHERE id='${op}' AND status='FAILED';`);

    it("provider timeout after creating the document: RECONCILIATION_REQUIRED, and the database refuses a retry", async () => {
      const db = cluster.fork();
      try {
        const { ops } = scenario(db);
        const provider = new Provider("timeoutAfterCreate");
        const out = await runOperation(pgClient(cluster, db), ops[0], { fetchImpl: provider.fetch });
        expect(out.status).toBe("RECONCILIATION_REQUIRED");
        expect(opState(db, ops[0])).toBe("RECONCILIATION_REQUIRED|1|unsafe|-");
        const retry = await session(cluster, db, `UPDATE finance_sync_operations SET status='RETRYING' WHERE id='${ops[0]}';`);
        expect(retry.code).not.toBe(0);
        const again = await workers(db, ops[0], 5, provider);
        expect(again.every((o) => o.status === "RECONCILIATION_REQUIRED")).toBe(true);
        expect(provider.documents).toHaveLength(1);
      } finally {
        cluster.drop(db);
      }
    });

    it("response lost after success (connection dropped): RECONCILIATION_REQUIRED, never 'safe to retry'", async () => {
      const db = cluster.fork();
      try {
        const { ops } = scenario(db);
        const provider = new Provider("lostAfterCreate");
        const out = await runOperation(pgClient(cluster, db), ops[0], { fetchImpl: provider.fetch });
        expect(out.status).toBe("RECONCILIATION_REQUIRED");
        expect(out.errorCode).toBe("CONNECTION_LOST");
        expect(opState(db, ops[0])).toBe("RECONCILIATION_REQUIRED|1|unsafe|-");
        expect(provider.documents).toHaveLength(1);
      } finally {
        cluster.drop(db);
      }
    });

    it("connection refused (nothing sent): FAILED and safe; the retry posts once", async () => {
      const db = cluster.fork();
      try {
        const { ops } = scenario(db);
        const provider = new Provider("refused");
        const first = await runOperation(pgClient(cluster, db), ops[0], { fetchImpl: provider.fetch });
        expect(first.status).toBe("FAILED");
        expect(opState(db, ops[0])).toBe("FAILED|1|safe|-");
        expect((await operatorRetry(db, ops[0])).code).toBe(0);
        provider.mode = "ok";
        const out = await workers(db, ops[0], 5, provider);
        expect(out.filter((o) => o.status === "SYNCED")).toHaveLength(1);
        expect(provider.documents).toHaveLength(1);
      } finally {
        cluster.drop(db);
      }
    });

    it("HTTP 500 that created nothing: FAILED safe; the retry's pre-flight finds nothing, then posts once", async () => {
      const db = cluster.fork();
      try {
        const { ops } = scenario(db);
        const provider = new Provider("http500");
        expect((await runOperation(pgClient(cluster, db), ops[0], { fetchImpl: provider.fetch })).status).toBe("FAILED");
        expect(provider.documents).toHaveLength(0);
        expect((await operatorRetry(db, ops[0])).code).toBe(0);
        provider.mode = "ok";
        const out = await runOperation(pgClient(cluster, db), ops[0], { fetchImpl: provider.fetch });
        expect(out.status).toBe("SYNCED");
        expect(provider.lookups).toBe(1);
        expect(provider.documents).toHaveLength(1);
        expect(opState(db, ops[0])).toBe("SYNCED|2|-|P-1");
      } finally {
        cluster.drop(db);
      }
    });

    it("HTTP 500 AFTER the provider created the document: the retry finds it and posts nothing", async () => {
      const db = cluster.fork();
      try {
        const { ops } = scenario(db);
        const provider = new Provider("http500AfterCreate");
        expect((await runOperation(pgClient(cluster, db), ops[0], { fetchImpl: provider.fetch })).status).toBe("FAILED");
        expect(provider.documents).toHaveLength(1);
        expect((await operatorRetry(db, ops[0])).code).toBe(0);
        provider.mode = "ok";
        const out = await workers(db, ops[0], 5, provider);
        const synced = out.find((o) => o.status === "SYNCED") as { message?: string } | undefined;
        expect(synced?.message).toMatch(/Found at the provider before retrying/);
        expect(provider.posts).toBe(1); // only the original POST
        expect(provider.documents).toHaveLength(1);
        expect(opState(db, ops[0])).toBe("SYNCED|2|-|P-1");
        expect(links(db)).toBe(1);
      } finally {
        cluster.drop(db);
      }
    });

    it("an unparseable answer after creating the document: RECONCILIATION_REQUIRED, never retried", async () => {
      const db = cluster.fork();
      try {
        const { ops } = scenario(db);
        const provider = new Provider("garbageAfterCreate");
        const out = await runOperation(pgClient(cluster, db), ops[0], { fetchImpl: provider.fetch });
        expect(out.status).toBe("RECONCILIATION_REQUIRED");
        expect(opState(db, ops[0])).toBe("RECONCILIATION_REQUIRED|1|unsafe|-");
        expect(provider.documents).toHaveLength(1);
      } finally {
        cluster.drop(db);
      }
    });

    it("worker crash mid-call: the operation stays PROCESSING and no later worker posts it", async () => {
      const db = cluster.fork();
      try {
        const { ops } = scenario(db);
        const hung = new Provider("hang");
        void runOperation(pgClient(cluster, db), ops[0], { fetchImpl: hung.fetch }); // never settles: the "crashed" worker
        for (let i = 0; i < 100 && !opState(db, ops[0]).startsWith("PROCESSING"); i++) await new Promise((r) => setTimeout(r, 100));
        for (let i = 0; i < 100 && hung.posts === 0; i++) await new Promise((r) => setTimeout(r, 100));
        expect(hung.posts).toBe(1);
        const restarted = new Provider("ok");
        const out = await workers(db, ops[0], 10, restarted);
        expect(out.every((o) => /Not runnable from PROCESSING/.test(String((o as { message?: string }).message)))).toBe(true);
        expect(restarted.posts).toBe(0);
        expect(opState(db, ops[0])).toBe("PROCESSING|1|-|-");
      } finally {
        cluster.drop(db);
      }
    });

    it("link write rolled back after a successful post: RECONCILIATION_REQUIRED, not retried", async () => {
      const db = cluster.fork();
      try {
        const { ops } = scenario(db);
        owner(cluster, db, `CREATE FUNCTION qa_refuse_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;`);
        owner(cluster, db, `CREATE TRIGGER qa_refuse_link BEFORE INSERT ON finance_external_links FOR EACH ROW EXECUTE FUNCTION qa_refuse_link();`);
        const provider = new Provider("ok");
        const out = await runOperation(pgClient(cluster, db), ops[0], { fetchImpl: provider.fetch });
        expect(out.status).toBe("RECONCILIATION_REQUIRED");
        expect(out.errorCode).toBe("LINK_WRITE_FAILED");
        expect(links(db)).toBe(0);
        const again = await workers(db, ops[0], 5, provider);
        expect(again.every((o) => o.status === "RECONCILIATION_REQUIRED")).toBe(true);
        expect(provider.documents).toHaveLength(1);
      } finally {
        cluster.drop(db);
      }
    });

    it("retry after partial completion (link stored, status not): the next run records SYNCED without calling the provider", async () => {
      const db = cluster.fork();
      try {
        const { conn, ops } = scenario(db);
        const pay = owner(cluster, db, `SELECT entity_id FROM finance_sync_operations WHERE id='${ops[0]}'`);
        owner(cluster, db,
          `INSERT INTO finance_external_links (college_id, connection_id, entity_type, entity_id, external_id) VALUES ('${COLLEGE_A}','${conn}','payment','${pay}','P-EXISTING')`);
        const provider = new Provider("ok");
        const out = await workers(db, ops[0], 5, provider);
        expect(out.filter((o) => o.status === "SYNCED")).toHaveLength(1);
        expect(provider.posts).toBe(0);
        expect(opState(db, ops[0])).toBe("SYNCED|1|-|P-EXISTING");
      } finally {
        cluster.drop(db);
      }
    });
  });
});
