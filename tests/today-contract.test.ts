import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S1 Gate 3 / owner decision D7 — "today" on a screen is the Asia/Kolkata
 * day. Production runs on a UTC server (Cloudflare Workers), where
 * `new Date().getDay()` and `new Date().toISOString().split("T")[0]` are still
 * YESTERDAY in India until 05:30.
 *
 * So this file runs the process in UTC, like the Worker, and pins the clock to
 * 01:30 IST on Tuesday 29 September 2026 — which is 20:00 UTC on Monday the
 * 28th. Any screen still using the server's own calendar shows Monday.
 */

const h = vi.hoisted(() => {
  const originalTz = process.env.TZ;
  process.env.TZ = "UTC";
  const eqCalls: { table: string; column: string; value: unknown }[] = [];
  const tables: Record<string, unknown[]> = {};
  function query(table: string): unknown {
    let single = false;
    const self: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          const rows = tables[table] ?? [];
          const value = single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
          return (resolve: (v: unknown) => void) => resolve(value);
        }
        if (prop === "single" || prop === "maybeSingle") {
          return () => {
            single = true;
            return self;
          };
        }
        if (prop === "eq") {
          return (column: string, value: unknown) => {
            eqCalls.push({ table, column, value });
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
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    // requireRole's session admission (migration 054): admitted.
    rpc: async () => ({ data: { state: "active" }, error: null }),
  };
  return { originalTz, eqCalls, tables, client };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirected"); } }));

import { todayDayOfWeek, todayInTimeZone } from "@/lib/format";

// 01:30 IST, Tuesday 29 Sep 2026 = 20:00 UTC, Monday 28 Sep 2026.
const EARLY_MORNING_IST = new Date("2026-09-28T20:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(EARLY_MORNING_IST);
  h.eqCalls.length = 0;
  for (const key of Object.keys(h.tables)) delete h.tables[key];
});
afterAll(() => {
  vi.useRealTimers();
  if (h.originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = h.originalTz;
});

describe("the process is a UTC server, as in production", () => {
  it("the server's own calendar says Monday the 28th here", () => {
    expect(new Date().getDay()).toBe(1);
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-09-28");
  });
});

describe("todayDayOfWeek", () => {
  it("is the Asia/Kolkata weekday: Tuesday, not the server's Monday", () => {
    expect(todayInTimeZone()).toBe("2026-09-29");
    expect(todayDayOfWeek()).toBe(2);
  });

  it("changes at IST midnight, not UTC midnight", () => {
    expect(todayDayOfWeek(undefined, new Date("2026-09-28T18:29:59Z"))).toBe(1);
    expect(todayDayOfWeek(undefined, new Date("2026-09-28T18:30:00Z"))).toBe(2);
  });

  it("takes an explicit time zone", () => {
    expect(todayDayOfWeek("UTC", EARLY_MORNING_IST)).toBe(1);
  });
});

describe("screens show the Indian day", () => {
  it("teacher timetable marks Tuesday as TODAY", async () => {
    h.tables.profiles = [{ college_id: "c1" }];
    h.tables.course_offerings = [{ id: "o1" }];
    h.tables.timetable_slots = [];
    const { default: Page } = await import("@/app/(portal)/teacher/timetable/page");
    const html = renderToStaticMarkup(await Page());
    expect(html).toMatch(/Tuesday<\/span><span[^>]*>TODAY</);
    expect(html).not.toMatch(/Monday<\/span><span[^>]*>TODAY</);
  });

  it("student hostel asks for Tuesday's mess menu", async () => {
    h.tables.profiles = [{ college_id: "c1" }];
    const { default: Page } = await import("@/app/(portal)/student/hostel/page");
    await Page();
    expect(h.eqCalls).toContainEqual({ table: "mess_menu", column: "day_of_week", value: 2 });
  });

  it("student schedule highlights Tuesday and reads Tuesday's substitutions", async () => {
    h.tables.profiles = [{ college_id: "c1" }];
    const { default: Page } = await import("@/app/(portal)/student/schedule/page");
    await Page();
    expect(h.eqCalls).toContainEqual({ table: "substitution_assignments", column: "date", value: "2026-09-29" });
  });
});

// ─── Source guard ──────────────────────────────────────────────────────────

/**
 * Screen code (pages and components, not server actions or lib business
 * rules — those are the separate D7 backend track) must not take "today"
 * from the server's calendar.
 */
function screenFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name).replace(/\\/g, "/");
    if (statSync(path).isDirectory()) return path === "app/dev" || path === "app/api" ? [] : screenFiles(path);
    if (!/\.tsx?$/.test(path) || /\.(test|spec)\.tsx?$/.test(path) || /\.dev\.tsx$/.test(path)) return [];
    if (/(^|\/)(actions|route)\.ts$/.test(path)) return [];
    return [path];
  });
}

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const SCREENS = [...screenFiles("app"), ...screenFiles("components"), ...screenFiles("hooks")];

describe("today source guard", () => {
  it("scans the screen code, including every fixed site", () => {
    for (const f of [
      "app/(portal)/student/hostel/page.tsx",
      "app/(portal)/student/schedule/page.tsx",
      "app/(portal)/teacher/attendance/page.tsx",
      "app/(portal)/teacher/dashboard/page.tsx",
      "app/(portal)/teacher/timetable/page.tsx",
      "app/(portal)/finance/integrations/page.tsx",
      "app/(portal)/finance/integrations/reconciliation/page.tsx",
    ]) expect(SCREENS, f).toContain(f);
  });

  it("no screen takes today's date or weekday from the server's calendar", () => {
    const hits = SCREENS.filter((f) =>
      /new Date\(\)\.getDay\(\)|new Date\(\)\.toISOString\(\)\.(split\(\s*["']T["']\s*\)|slice\(\s*0\s*,\s*10\s*\)|substring\(\s*0\s*,\s*10\s*\))/.test(code(f))
    );
    expect(hits).toEqual([]);
  });
});
