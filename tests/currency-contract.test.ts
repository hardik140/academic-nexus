import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { formatMoney } from "@/lib/format";

/**
 * S1 Gate 2 / owner decision D2 — money is INR with en-IN grouping, shown
 * through one formatter (lib/format.ts formatMoney).
 *
 * 1. The formatter's user-visible output.
 * 2. Representative money screens, rendered with fixed amounts: the values a
 *    finance user or student reads are rupees in lakh/crore grouping, never
 *    dollars.
 * 3. A source guard: no USD formatter, and no second currency formatter, can
 *    come back into production code.
 */

// ─── 1. The canonical formatter ────────────────────────────────────────────

describe("formatMoney: the one INR formatter", () => {
  it.each([
    [1234.56, "₹1,234.56"],
    [125000, "₹1,25,000.00"],
    [12345678.9, "₹1,23,45,678.90"],
    [-250.5, "-₹250.50"],
    [0, "₹0.00"],
  ])("%s → %s", (amount, expected) => {
    expect(formatMoney(amount)).toBe(expected);
  });
});

// ─── 2. Money screens, as rendered ─────────────────────────────────────────

const h = vi.hoisted(() => {
  const tables: Record<string, unknown[]> = {};
  function query(table: string): unknown {
    let single = false;
    const self: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          const rows = tables[table] ?? [];
          const value = single ? { data: rows[0] ?? null, error: null } : { data: rows, count: rows.length, error: null };
          return (resolve: (v: unknown) => void) => resolve(value);
        }
        if (prop === "single" || prop === "maybeSingle") {
          return () => {
            single = true;
            return self;
          };
        }
        return () => self;
      },
    });
    return self;
  }
  const client = {
    from: (table: string) => query(table),
    // An RPC returns the rows set for the table named after it (e.g. fee_totals).
    rpc: async (fn: string) => ({ data: tables[fn] ?? [], error: null }),
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
  };
  const exceptions = vi.fn();
  return { tables, client, exceptions };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirected"); } }));
vi.mock("@/lib/cache", () => ({
  getCached: (_key: string, _ttl: number, fetcher: () => unknown) => fetcher(),
  invalidateCacheFamily: async () => {},
  versionedKey: (key: string | null) => key,
}));
vi.mock("@/app/(portal)/finance/exceptions/actions", () => ({ getFinanceExceptions: h.exceptions }));
vi.mock("@/app/(portal)/student/fees/actions", () => ({
  requestRefund: vi.fn(),
  listMyRefundRequests: vi.fn(async () => []),
  submitDispute: vi.fn(),
  listMyDisputes: vi.fn(async () => []),
}));

const PAST = "2020-01-15";
const FEES = [
  // Billed ₹1,25,000.00, paid ₹50,000.00; the first is overdue by ₹75,000.00.
  { id: "f1", type: "tuition", amount: 100000, paid_amount: 25000, status: "pending", due_date: PAST, students: { departments: { name: "Science", code: "SCI" } } },
  { id: "f2", type: "hostel", amount: 25000, paid_amount: 25000, status: "paid", due_date: PAST, students: { departments: { name: "Science", code: "SCI" } } },
];
const PAYMENT = { id: "p1", amount: 1234.5, method: "upi", status: "cleared", transaction_ref: "TXN-000000000001", created_at: "2026-09-01T04:00:00Z", profiles: { full_name: "Asha" } };
const NO_EXCEPTIONS = { overdueFees: [], duplicatePayments: [], overpayments: [], refundsAwaitingApproval: [], disputesNeedingAttention: [] };

function setTables(tables: Record<string, unknown[]>) {
  for (const key of Object.keys(h.tables)) delete h.tables[key];
  Object.assign(h.tables, tables);
}

async function render(page: () => Promise<unknown>) {
  return renderToStaticMarkup((await page()) as Parameters<typeof renderToStaticMarkup>[0]);
}

function expectRupeesOnly(html: string, amounts: string[]) {
  for (const amount of amounts) expect(html).toContain(amount);
  expect(html).not.toMatch(/(US)?\$\s?\d|\bUSD\b/);
}

describe("money screens render INR, never USD", () => {
  it("finance dashboard: KPIs and recent transactions", async () => {
    setTables({
      profiles: [{ college_id: "c1" }],
      fees: FEES,
      payments: [PAYMENT],
      // What fee_totals() (057) returns for FEES.
      fee_totals: [{ total_billed: 125000, total_collected: 50000, total_pending: 0, total_overdue: 75000, fee_count: 2 }],
    });
    h.exceptions.mockResolvedValue(NO_EXCEPTIONS);
    const { default: Page } = await import("@/app/(portal)/finance/dashboard/page");
    expectRupeesOnly(await render(Page), ["₹1,25,000.00", "₹50,000.00", "₹75,000.00", "₹1,234.50"]);
  });

  it("finance reports: institution totals and department breakdown", async () => {
    setTables({ profiles: [{ college_id: "c1" }], mv_fee_summary: [{ total_billed: 12345678.9, total_collected: 5000 }], fees: FEES });
    const { default: Page } = await import("@/app/(portal)/finance/reports/page");
    expectRupeesOnly(await render(Page), ["₹1,23,45,678.90", "₹5,000.00", "₹75,000.00", "₹50,000.00 / ₹1,25,000.00"]);
  });

  it("finance exceptions: flagged amounts", async () => {
    h.exceptions.mockResolvedValue({
      ...NO_EXCEPTIONS,
      overdueFees: [{ id: "e1", studentName: "Asha", enrollmentNumber: "EN1", amount: 250000.5, detail: "Tuition" }],
    });
    const { default: Page } = await import("@/app/(portal)/finance/exceptions/page");
    expectRupeesOnly(await render(Page), ["₹2,50,000.50"]);
  });

  it("student fees: totals, fee rows and payments", async () => {
    setTables({ students: [{ id: "s1" }], fees: FEES, payments: [PAYMENT] });
    const { default: Page } = await import("@/app/(portal)/student/fees/page");
    expectRupeesOnly(await render(Page), ["₹1,25,000.00", "₹50,000.00", "₹75,000.00", "₹1,00,000.00", "₹1,234.50"]);
  });
});

// ─── 3. Source guard ───────────────────────────────────────────────────────

const ROOTS = ["app", "components", "lib", "hooks"];

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name).replace(/\\/g, "/");
    if (statSync(path).isDirectory()) return path === "app/dev" ? [] : productionFiles(path);
    if (!/\.(ts|tsx)$/.test(path) || /\.(test|spec)\.tsx?$/.test(path) || /\.dev\.tsx$/.test(path)) return [];
    return [path];
  });
}

/** Source without comments, so prose about USD is not a violation. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const FILES = ROOTS.flatMap(productionFiles);

// Every production screen that displays money, all through formatMoney.
const MONEY_SCREENS = [
  "app/(portal)/admin/users/page.tsx",
  "app/(portal)/director/decisions/page.tsx",
  "app/(portal)/director/decisions/[id]/page.tsx",
  "app/(portal)/finance/dashboard/page.tsx",
  "app/(portal)/finance/exceptions/page.tsx",
  "app/(portal)/finance/integrations/reconciliation/page.tsx",
  "app/(portal)/finance/invoices/page.tsx",
  "app/(portal)/finance/refunds/page.tsx",
  "app/(portal)/finance/reports/page.tsx",
  "app/(portal)/finance/scholarships/page.tsx",
  "app/(portal)/finance/transactions/page.tsx",
  "app/(portal)/student/dashboard/dashboard-client.tsx",
  "app/(portal)/student/fees/finance-requests-panel.tsx",
  "app/(portal)/student/fees/page.tsx",
];

describe("currency source guard", () => {
  it("scans the production tree", () => {
    expect(FILES.length).toBeGreaterThan(100);
    for (const screen of MONEY_SCREENS) expect(FILES, screen).toContain(screen);
  });

  it("no production code formats USD or uses an en-US currency formatter", () => {
    const hits = FILES.filter((f) => /\bUSD\b|["']en-US["'][^)]*currency|formatCurrency\b/.test(code(f)));
    expect(hits).toEqual([]);
  });

  it("lib/format.ts holds the only currency formatter", () => {
    const hits = FILES.filter((f) => f !== "lib/format.ts" && /style:\s*["']currency["']/.test(code(f)));
    expect(hits).toEqual([]);
  });

  it("no hand-built rupee amounts from toLocaleString()", () => {
    const hits = FILES.filter((f) => /₹\$?\{[^}]*toLocaleString\(/.test(code(f)));
    expect(hits).toEqual([]);
  });

  it("every money screen formats through formatMoney", () => {
    const missing = MONEY_SCREENS.filter((f) => !/import\s*\{[^}]*\bformatMoney\b[^}]*\}\s*from\s*["']@\/lib\/format["']/.test(code(f)) || !/\bformatMoney\(/.test(code(f)));
    expect(missing).toEqual([]);
  });
});
