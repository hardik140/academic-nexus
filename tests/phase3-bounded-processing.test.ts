import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Redis transformation Phase 3 — the TypeScript side of bounded processing.
 * The SQL is tested on the real schema (tests/staging-business-reads.test.ts)
 * and under real concurrency (tests/realpg-phase3-concurrency.test.ts); this
 * pins how the application drives it: page by page, batch by batch, never a
 * whole recipient or payment list in memory, and rpc always called on its
 * client.
 */

const h = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcImpl: null as null | ((fn: string, args: Record<string, unknown>) => unknown),
  audits: [] as unknown[],
  conn: { id: "conn-1", college_id: "c-a", status: "ACTIVE", provider: "zoho_books" },
}));

vi.mock("@/lib/rbac", () => ({ requireRole: async () => ({ userId: "u-fin", collegeId: "c-a", role: "finance" }) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => undefined }));
vi.mock("@/lib/audit", () => ({ logAudit: async (...a: unknown[]) => void h.audits.push(a) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
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

describe("syncNow: bounded database batches until a short one", () => {
  function windowOf(total: number, linkedEvery = 0) {
    // A fake queue_finance_sync_batch over `total` payments ordered by index.
    return (_fn: string, args: Record<string, unknown>) => {
      const start = args.p_after_id ? Number(String(args.p_after_id).slice(1)) + 1 : 0;
      const end = Math.min(total, start + (args.p_limit as number));
      const scanned = Math.max(0, end - start);
      let skipped = 0;
      for (let i = start; i < end; i++) if (linkedEvery && i % linkedEvery === 0) skipped++;
      return {
        data: [
          {
            scanned,
            queued: scanned - skipped,
            skipped,
            last_created: scanned ? `t${end - 1}` : args.p_after_created ?? null,
            last_id: scanned ? `p${end - 1}` : args.p_after_id ?? null,
          },
        ],
        error: null,
      };
    };
  }

  it.each([
    [0, 1],
    [499, 1],
    [500, 2],
    [501, 2],
    [1200, 3],
    [20_000, 41],
  ])("%i payments: every one scanned, in %i calls of at most 500", async (total, calls) => {
    const { syncNow } = await import("@/app/(portal)/finance/integrations/actions");
    h.rpcImpl = windowOf(total, 10);
    const r = await syncNow({ connectionId: "00000000-0000-4000-8000-000000000001", from: "2026-08-01", to: "2026-08-31" });
    expect(h.rpcCalls).toHaveLength(calls);
    expect(h.rpcCalls.every((c) => c.fn === "queue_finance_sync_batch" && (c.args.p_limit as number) <= 500)).toBe(true);
    const skipped = Math.ceil(total / 10);
    expect(r).toEqual({ queued: total - skipped, skipped, complete: true });
    // Each call continues after the previous batch's last row.
    for (let i = 1; i < h.rpcCalls.length; i++) expect(h.rpcCalls[i].args.p_after_id).toBe(`p${i * 500 - 1}`);
  });

  it("stops at its hard ceiling and says the run is incomplete; pressing again continues safely", async () => {
    const { syncNow } = await import("@/app/(portal)/finance/integrations/actions");
    h.rpcImpl = windowOf(10_000_000);
    const r = await syncNow({ connectionId: "00000000-0000-4000-8000-000000000001", from: "2026-08-01", to: "2026-08-31" });
    expect(h.rpcCalls).toHaveLength(200);
    expect(r.complete).toBe(false);
    expect(h.audits[0]).toEqual(expect.arrayContaining([expect.objectContaining({ newValue: expect.objectContaining({ complete: false, batches: 200 }) })]));
  });

  it("a failed batch fails the press (no silent 'nothing to queue')", async () => {
    const { syncNow } = await import("@/app/(portal)/finance/integrations/actions");
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.rpcImpl = () => ({ data: null, error: { message: "statement timeout", code: "57014" } });
    await expect(syncNow({ connectionId: "00000000-0000-4000-8000-000000000001", from: "2026-08-01", to: "2026-08-31" })).rejects.toThrow();
  });
});
