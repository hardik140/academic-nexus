import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { feeTotals } from "@/lib/finance/fee-totals";

/**
 * lib/finance/fee-totals.ts — the call into 057, and the deploy-order
 * fallback when 057 has not been applied yet. The SQL itself is proved in
 * tests/staging-fee-totals.test.ts.
 */

function client(rpcResult: { data: unknown; error: { code?: string; message: string } | null }, rows: unknown[] = []) {
  const select = vi.fn(() => ({ eq: async () => ({ data: rows, error: null }) }));
  return {
    rpc: vi.fn(async () => rpcResult),
    from: vi.fn(() => ({ select })),
  } as unknown as SupabaseClient<Database> & { rpc: ReturnType<typeof vi.fn>; from: ReturnType<typeof vi.fn> };
}

describe("feeTotals", () => {
  it("reads the one aggregate row and never selects fee rows", async () => {
    const c = client({ data: [{ total_billed: "1000.50", total_collected: "250", total_pending: "100", total_overdue: "650.5", fee_count: "3" }], error: null });
    expect(await feeTotals(c, "college-1")).toEqual({ billed: 1000.5, collected: 250, pending: 100, overdue: 650.5, feeCount: 3 });
    expect(c.rpc).toHaveBeenCalledWith("fee_totals", { p_college_id: "college-1" });
    expect(c.from).not.toHaveBeenCalled();
  });

  it("before 057 is applied, falls back to the old computation (once warned) instead of failing the page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const past = new Date(Date.now() - 86_400_000 * 3).toISOString().slice(0, 10);
    const c = client({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }, [
      { amount: 100, paid_amount: 0, status: "pending", due_date: past },
      { amount: 50, paid_amount: 50, status: "paid", due_date: past },
    ]);
    expect(await feeTotals(c, "college-1")).toEqual({ billed: 150, collected: 50, pending: 0, overdue: 100, feeCount: 2 });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("any other database error surfaces as a failed read", async () => {
    const c = client({ data: null, error: { code: "42501", message: "permission denied" } });
    await expect(feeTotals(c, "college-1")).rejects.toThrow();
  });
});

describe("feeTotals on a REAL supabase-js client (network stubbed)", () => {
  it("calls POST /rest/v1/rpc/fee_totals with the college id — rpc stays bound to its client", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const seen: { url: string; body: string }[] = [];
    const real = createClient<Database>("https://qa-project.supabase.co", "anon-key", {
      global: {
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          seen.push({ url: String(input), body: String(init?.body ?? "") });
          return new Response(JSON.stringify([{ total_billed: 10, total_collected: 4, total_pending: 6, total_overdue: 0, fee_count: 1 }]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch,
      },
    });
    expect(await feeTotals(real, "c-1")).toEqual({ billed: 10, collected: 4, pending: 6, overdue: 0, feeCount: 1 });
    expect(seen[0].url).toMatch(/\/rest\/v1\/rpc\/fee_totals$/);
    expect(JSON.parse(seen[0].body)).toEqual({ p_college_id: "c-1" });
  });
});
