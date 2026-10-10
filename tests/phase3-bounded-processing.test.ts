import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Redis transformation Phase 3 — the TypeScript side of bounded processing.
 * The SQL is tested on the real schema (tests/staging-business-reads.test.ts)
 * and under real concurrency (tests/realpg-phase3-concurrency.test.ts); this
 * pins how the application drives it: page by page, batch by batch, never a
 * whole recipient or payment list in memory, a sync run resumed rather than
 * restarted, reconciliation paged by keyset, and rpc always called on its
 * client.
 */

const h = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcImpl: null as null | ((fn: string, args: Record<string, unknown>) => unknown),
  audits: [] as unknown[],
  conn: { id: "conn-1", college_id: "c-a", status: "ACTIVE", provider: "zoho_books" },
  adapter: {} as Record<string, unknown>,
}));

vi.mock("@/lib/rbac", () => ({ requireRole: async () => ({ userId: "u-fin", collegeId: "c-a", role: "finance" }) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => undefined }));
vi.mock("@/lib/audit", () => ({ logAudit: async (...a: unknown[]) => void h.audits.push(a) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/finance/credentials", async (orig) => ({ ...(await orig<object>()), loadCredential: async () => ({}) }));
vi.mock("@/lib/finance/providers/registry", async (orig) => ({ ...(await orig<object>()), adapterFor: () => h.adapter }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () =>
    client({
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.conn, error: null }) }) }) }) }),
    }),
}));

/** A client whose rpc USES `this`, like SupabaseClient.rpc: a detached call throws. */
function client(extra: Record<string, unknown> = {}) {
  return {
    marker: "bound",
    rpc(this: { marker?: string }, fn: string, args: Record<string, unknown>) {
      if (this?.marker !== "bound") throw new TypeError("Cannot read properties of undefined (reading 'rest')");
      h.rpcCalls.push({ fn, args });
      return Promise.resolve(h.rpcImpl!(fn, args));
    },
    ...extra,
  };
}

beforeEach(() => {
  h.rpcCalls = [];
  h.audits = [];
  h.rpcImpl = null;
});

describe("pushAnnouncement: device tokens a bounded page at a time", () => {
  it("2,500 tokens: three pages of at most 1,000, each sent, the cursor advancing, then stops", async () => {
    const { pushAnnouncement, PUSH_PAGE } = await import("@/lib/notification-fanout");
    const all = Array.from({ length: 2500 }, (_, i) => `ExpoToken[${String(i).padStart(5, "0")}]`);
    h.rpcImpl = (_fn, args) => {
      const after = args.p_after as string | null;
      const start = after ? all.indexOf(after) + 1 : 0;
      return { data: all.slice(start, start + (args.p_limit as number)).map((t) => ({ expo_push_token: t })), error: null };
    };
    const sent: string[][] = [];
    const r = await pushAnnouncement(client() as never, "ann-1", "t", "b", async (tokens) => void sent.push(tokens));
    expect(r).toEqual({ tokens: 2500, pages: 3 });
    expect(sent.map((p) => p.length)).toEqual([1000, 1000, 500]);
    expect(Math.max(...sent.map((p) => p.length))).toBeLessThanOrEqual(PUSH_PAGE);
    expect(h.rpcCalls.map((c) => c.args.p_after)).toEqual([null, all[999], all[1999]]);
    expect(new Set(sent.flat()).size).toBe(2500);
  });

  it("exactly one full page: one more call confirms the end", async () => {
    const { pushAnnouncement } = await import("@/lib/notification-fanout");
    const all = Array.from({ length: 1000 }, (_, i) => `T${i}`);
    h.rpcImpl = (_fn, args) => ({ data: args.p_after ? [] : all.map((t) => ({ expo_push_token: t })), error: null });
    const r = await pushAnnouncement(client() as never, "ann-1", "t", "b", async () => undefined);
    expect(r).toEqual({ tokens: 1000, pages: 1 });
    expect(h.rpcCalls).toHaveLength(2);
  });

  it("stopping at the page ceiling with more to send is logged as truncated, not passed off as the end", async () => {
    const { pushAnnouncement, PUSH_PAGE } = await import("@/lib/notification-fanout");
    const full = Array.from({ length: PUSH_PAGE }, (_, i) => ({ expo_push_token: `T${i}` }));
    h.rpcImpl = () => ({ data: full, error: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await pushAnnouncement(client() as never, "ann-1", "t", "b", async () => undefined);
    expect(r.pages).toBe(500);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "truncated", pages: 500 }));
    warn.mockRestore();
  });

  it("a failed page is logged and never thrown: the announcement already succeeded", async () => {
    const { pushAnnouncement } = await import("@/lib/notification-fanout");
    h.rpcImpl = () => ({ data: null, error: { message: "boom", code: "57014" } });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(pushAnnouncement(client() as never, "ann-1", "t", "b", async () => undefined)).resolves.toEqual({ tokens: 0, pages: 0 });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("calls rpc on its client (a detached call would throw on every page)", async () => {
    const { fanOutAnnouncement } = await import("@/lib/notification-fanout");
    h.rpcImpl = () => ({ data: [{ announcement_id: "a1", recipient_count: "1500" }], error: null });
    await expect(fanOutAnnouncement(client() as never, { collegeId: "c", title: "t", message: "m", audience: "all" })).resolves.toEqual({
      announcementId: "a1",
      recipientCount: 1500,
    });
  });
});

describe("syncNow: drives a durable run; an incomplete press says so and the next continues it", () => {
  /**
   * A fake finance_sync_step over `total` payments that keeps its run the way
   * migration 060 does: in "the database" (here, `server`), not in the caller.
   */
  function runOver(total: number, linkedEvery = 0, failAtBatch = -1) {
    const server = { run: null as null | { id: string; cursor: number; status: "RUNNING" | "COMPLETE"; scanned: number; queued: number; skipped: number; batches: number }, runs: 0, steps: 0 };
    const impl = (_fn: string, args: Record<string, unknown>) => {
      server.steps++;
      if (!server.run || (args.p_run_id === null && server.run.status === "COMPLETE")) {
        server.run = { id: `run-${++server.runs}`, cursor: 0, status: "RUNNING", scanned: 0, queued: 0, skipped: 0, batches: 0 };
      }
      const r = server.run;
      const row = (scanned: number, queued: number, skipped: number, error: string | null = null) => ({
        data: [
          {
            run_id: r.id, run_status: r.status, scanned, queued, skipped,
            run_scanned: String(r.scanned), run_queued: String(r.queued), run_skipped: String(r.skipped), run_batches: r.batches,
            cutoff_at: "2026-09-01T00:00:00+00:00", error,
          },
        ],
        error: null,
      });
      if (r.status === "COMPLETE") return row(0, 0, 0);
      if (server.steps === failAtBatch) return row(0, 0, 0, "23505: injected");
      const limit = args.p_limit as number;
      const end = Math.min(total, r.cursor + limit);
      const scanned = end - r.cursor;
      let skipped = 0;
      for (let i = r.cursor; i < end; i++) if (linkedEvery && i % linkedEvery === 0) skipped++;
      Object.assign(r, {
        cursor: end,
        scanned: r.scanned + scanned,
        queued: r.queued + scanned - skipped,
        skipped: r.skipped + skipped,
        batches: r.batches + 1,
        status: scanned < limit ? "COMPLETE" : "RUNNING",
      });
      return row(scanned, scanned - skipped, skipped);
    };
    return { server, impl };
  }
  const params = { connectionId: "00000000-0000-4000-8000-000000000001", from: "2026-08-01", to: "2026-08-31" };

  it.each([
    [0, 1],
    [499, 1],
    [500, 2],
    [1200, 3],
    [20_000, 41],
  ])("%i payments: one press, every one scanned, in %i calls of at most 500 on one run", async (total, calls) => {
    const { syncNow } = await import("@/app/(portal)/finance/integrations/actions");
    const f = runOver(total, 10);
    h.rpcImpl = f.impl;
    const r = await syncNow(params);
    expect(h.rpcCalls).toHaveLength(calls);
    expect(h.rpcCalls.every((c) => c.fn === "finance_sync_step" && (c.args.p_limit as number) <= 500)).toBe(true);
    // The first call finds or opens the run; every later one names it.
    expect(h.rpcCalls[0].args.p_run_id).toBeNull();
    expect(h.rpcCalls.slice(1).every((c) => c.args.p_run_id === "run-1")).toBe(true);
    const skipped = Math.ceil(total / 10);
    expect(r).toMatchObject({ runId: "run-1", queued: total - skipped, skipped, complete: true });
    expect(r.run.scanned).toBe(total);
  });

  it("100,500 payments: the first press stops at 200 batches and reports incomplete; the second resumes the SAME run and finishes past 100,000", async () => {
    const { syncNow } = await import("@/app/(portal)/finance/integrations/actions");
    const f = runOver(100_500);
    h.rpcImpl = f.impl;
    const first = await syncNow(params);
    expect(h.rpcCalls).toHaveLength(200);
    expect(first).toMatchObject({ runId: "run-1", queued: 100_000, complete: false, run: { scanned: 100_000 } });
    expect(h.audits[0]).toEqual(expect.arrayContaining(["finance_sync_started", "finance_sync_runs", "run-1", expect.objectContaining({ newValue: expect.objectContaining({ complete: false, batches: 200 }) })]));

    h.rpcCalls = [];
    const second = await syncNow(params); // a fresh press: nothing carried over in memory
    expect(h.rpcCalls[0].args.p_run_id).toBeNull();
    expect(second).toMatchObject({ runId: "run-1", queued: 500, complete: true, run: { scanned: 100_500, queued: 100_500 } });
    expect(f.server.runs).toBe(1); // resumed, not restarted
  });

  it("a batch the database rolled back fails the press with a retry message; the run is kept, and the next press repeats it", async () => {
    const { syncNow } = await import("@/app/(portal)/finance/integrations/actions");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = runOver(1200, 0, 2);
    h.rpcImpl = f.impl;
    await expect(syncNow(params)).rejects.toThrow(/press Sync Now again to retry/);
    expect(h.audits[0]).toEqual(expect.arrayContaining(["finance_sync_failed", "finance_sync_runs", "run-1"]));
    const r = await syncNow(params);
    expect(r).toMatchObject({ runId: "run-1", complete: true, run: { scanned: 1200, queued: 1200 } });
    err.mockRestore();
  });

  it("a failed call (no row at all) fails the press — never a silent 'nothing to queue'", async () => {
    const { syncNow } = await import("@/app/(portal)/finance/integrations/actions");
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.rpcImpl = () => ({ data: null, error: { message: "statement timeout", code: "57014" } });
    await expect(syncNow(params)).rejects.toThrow();
    h.rpcImpl = () => ({ data: [], error: null });
    await expect(syncNow(params)).rejects.toThrow(/did not return its run/);
  });

  it("a backwards window is refused before any call", async () => {
    const { syncNow } = await import("@/app/(portal)/finance/integrations/actions");
    await expect(syncNow({ ...params, from: "2026-08-31", to: "2026-08-01" })).rejects.toThrow(/start must be on or before/);
    expect(h.rpcCalls).toHaveLength(0);
  });
});

describe("reconcile: every local payment by keyset page, links in chunks, failures fail the run", () => {
  const STARTED = "2026-09-01T10:00:00.123456+00:00";
  const pidOf = (i: number) => `00000092-0000-4000-8000-${String(i).padStart(12, "0")}`;
  /** Four payments to a timestamp, microseconds that a JavaScript Date would drop. */
  const payments = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: pidOf(i + 1),
      amount: "100.50",
      created_at: `2026-08-01T00:${String(Math.floor(i / 4 / 60) % 60).padStart(2, "0")}:${String(Math.floor(i / 4) % 60).padStart(2, "0")}.000001+00:00`,
      student_id: "s-1",
      fee_id: `fee-${i + 1}`,
    }));

  function reconDb(opts: { linkError?: boolean } = {}) {
    const state = { items: [] as Record<string, unknown>[], runUpdates: [] as Record<string, unknown>[], linkChunks: [] as string[][] };
    const db = client({
      from(table: string) {
        if (table === "finance_reconciliation_runs") {
          return {
            insert: () => ({ select: () => ({ single: async () => ({ data: { id: "run-r", started_at: STARTED }, error: null }) }) }),
            update: (v: Record<string, unknown>) => ({ eq: async () => void state.runUpdates.push(v) }),
          };
        }
        if (table === "finance_integration_connections") {
          return {
            select: () => ({
              eq: () => ({ single: async () => ({ data: { id: "conn-1", college_id: "c-a", provider: "zoho_books", capabilities: { searchTransactions: "SUPPORTED" } }, error: null }) }),
            }),
          };
        }
        if (table === "finance_external_links") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: async (_col: string, ids: string[]) => {
                    state.linkChunks.push(ids);
                    if (opts.linkError) return { data: null, error: { message: "boom", code: "57014" } };
                    return { data: ids.map((id) => ({ entity_id: id, external_id: `X-${id}` })), error: null };
                  },
                }),
              }),
            }),
          };
        }
        if (table === "finance_reconciliation_items") return { insert: async (rows: Record<string, unknown>[]) => (state.items.push(...rows), { error: null }) };
        throw new Error(`unexpected table ${table}`);
      },
    });
    return { db, state };
  }
  /** finance_reconciliation_payments over `rows`, by keyset on (created_at, id) — string order matches here. */
  const keyset = (rows: ReturnType<typeof payments>) => (_fn: string, args: Record<string, unknown>) => {
    const after = args.p_after_id as string | null;
    const start = after ? rows.findIndex((r) => r.id === after) + 1 : 0;
    return { data: rows.slice(start, start + (args.p_limit as number)), error: null };
  };
  const matchingProvider = (rows: ReturnType<typeof payments>) => {
    h.adapter = {
      searchTransactions: async () => ({
        ok: true,
        data: { transactions: rows.map((r) => ({ id: `X-${r.id}`, type: "payment", date: "2026-08-01", amount: 100.5, reference: r.id })) },
      }),
    };
  };
  const input = { collegeId: "c-a", connectionId: "conn-1", periodStart: "2026-08-01", periodEnd: "2026-08-31", createdBy: "u-fin" };

  it("2,345 payments, all posted and matching: three keyset pages after the database's own cursor, RECONCILED", async () => {
    const { reconcile, RECONCILE_PAGE, LINK_CHUNK } = await import("@/lib/finance/reconciliation");
    const rows = payments(2345);
    h.rpcImpl = keyset(rows);
    matchingProvider(rows);
    const { db, state } = reconDb();
    const out = await reconcile(db as never, input);
    expect(out).toMatchObject({ status: "RECONCILED", localCount: 2345, externalCount: 2345, issues: 0, differenceAmount: 0 });
    expect(out.localAmount).toBe(Math.round(2345 * 100.5 * 100) / 100);
    expect(h.rpcCalls.map((c) => c.fn)).toEqual(Array(3).fill("finance_reconciliation_payments"));
    expect(h.rpcCalls.every((c) => c.args.p_as_of === STARTED && c.args.p_limit === RECONCILE_PAGE)).toBe(true);
    expect(h.rpcCalls[0].args).toMatchObject({ p_after_created: null, p_after_id: null });
    // The cursor is the row's own created_at string: microseconds intact.
    expect(h.rpcCalls[1].args).toMatchObject({ p_after_created: rows[999].created_at, p_after_id: rows[999].id });
    expect(h.rpcCalls[2].args).toMatchObject({ p_after_created: rows[1999].created_at, p_after_id: rows[1999].id });
    expect(state.linkChunks.every((c) => c.length <= LINK_CHUNK)).toBe(true);
    expect(state.linkChunks.flat()).toEqual(rows.map((r) => r.id));
    expect(state.items).toEqual([]);
  });

  it("a failed page fails the run with an actionable error — never a short, 'reconciled' list", async () => {
    const { reconcile } = await import("@/lib/finance/reconciliation");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rows = payments(2500);
    const ok = keyset(rows);
    h.rpcImpl = (fn, args) => (args.p_after_id ? { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } } : ok(fn, args));
    matchingProvider(rows);
    const { db, state } = reconDb();
    const out = await reconcile(db as never, input);
    expect(out.status).toBe("FAILED");
    expect(state.runUpdates.at(-1)).toMatchObject({ status: "FAILED", error_message: expect.stringMatching(/page 2 .*after 1000 read.*run reconciliation again/) });
    expect(state.items).toEqual([]);
  });

  it("a payment returned twice stops the run rather than double-count it", async () => {
    const { reconcile } = await import("@/lib/finance/reconciliation");
    const rows = payments(1500);
    h.rpcImpl = (_fn, args) => ({ data: args.p_after_id ? [rows[999], ...rows.slice(1000)] : rows.slice(0, 1000), error: null });
    matchingProvider(rows);
    const { db, state } = reconDb();
    const out = await reconcile(db as never, input);
    expect(out.status).toBe("FAILED");
    expect(state.runUpdates.at(-1)).toMatchObject({ error_message: expect.stringMatching(/read twice/) });
  });

  it("a failed link read fails the run instead of reporting posted payments as unposted", async () => {
    const { reconcile } = await import("@/lib/finance/reconciliation");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rows = payments(150);
    h.rpcImpl = keyset(rows);
    matchingProvider(rows);
    const { db, state } = reconDb({ linkError: true });
    const out = await reconcile(db as never, input);
    expect(out.status).toBe("FAILED");
    expect(state.items).toEqual([]);
  });

  it("a provider that never stops paging fails the run instead of comparing part of its list", async () => {
    const { reconcile } = await import("@/lib/finance/reconciliation");
    const rows = payments(10);
    h.rpcImpl = keyset(rows);
    let pages = 0;
    h.adapter = { searchTransactions: async () => ({ ok: true, data: { transactions: [], nextCursor: `c${++pages}` } }) };
    const { db, state } = reconDb();
    const out = await reconcile(db as never, input);
    expect(out.status).toBe("FAILED");
    expect(pages).toBe(200);
    expect(state.runUpdates.at(-1)).toMatchObject({ error_message: expect.stringMatching(/200 pages/) });
  });
});
