import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S1 / owner decision D5 — the P0 screens, state by state.
 *
 * For each P0 read: records come back as records; a successful empty read is
 * a legitimate empty result (and cached as before); a failed read throws a
 * safe error — logged for operators, never cached, never carrying the
 * database's words — so the page shows its error state instead of "No
 * pending requests". The two reads that record a view also must not record
 * one for a view that failed. The broad contract, over every read function,
 * is tests/read-failure-contract.test.ts.
 */

type TableState = "rows" | "empty" | "fail";

const h = vi.hoisted(() => {
  const ID = "00000000-0000-4000-8000-000000000009";
  const DB_MESSAGE = 'relation "secret_internal_table" does not exist';
  const state = {
    tables: {} as Record<string, "rows" | "empty" | "fail">,
    fallback: "rows" as "rows" | "empty" | "fail",
    role: "director",
    writes: [] as string[],
    reads: [] as string[],
    failAt: 0,
    overrides: {} as Record<string, Record<string, unknown>>,
  };
  const row = (table: string): Record<string, unknown> =>
    new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (typeof prop === "string" && prop in (state.overrides[table] ?? {})) return state.overrides[table][prop];
        if (prop === "toJSON") return () => ({ id: ID });
        if (typeof prop === "symbol") return undefined;
        if (/(_at|date|time)$/.test(prop)) return "2026-09-01T04:00:00.000Z";
        if (/(score|count|capacity|occupancy|amount|cgpa|pct|rate)/.test(prop)) return 1;
        return ID;
      },
    });

  function query(table: string): unknown {
    let single = false;
    let write: string | null = null;
    const self: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
            if (write) {
              state.writes.push(`${write}:${table}`);
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            }
            state.reads.push(table);
            const mode = state.failAt === state.reads.length ? "fail" : state.tables[table] ?? state.fallback;
            const value =
              mode === "fail"
                ? { data: null, count: null, error: { code: "42P01", message: DB_MESSAGE } }
                : mode === "rows"
                  ? { data: single ? row(table) : [row(table), row(table)], count: 2, error: null }
                  : { data: single ? null : [], count: 0, error: null };
            return Promise.resolve(value).then(resolve, reject);
          };
        }
        if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") {
          return () => {
            write = String(prop);
            return self;
          };
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
    rpc: (fn: string) => query(`rpc:${fn}`),
    auth: { getUser: async () => ({ data: { user: { id: ID } }, error: null }) },
  };
  // In-memory Redis: what getCached stores is inspectable.
  const store = new Map<string, unknown>();
  const redis = {
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    // Versioned families (lib/cache.ts) read value + version in one MGET and
    // bump the version through a pipeline.
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => (store.has(k) ? store.get(k) : null))),
    pipeline: () => {
      const ops: Array<() => unknown> = [];
      const p = {
        incr: (k: string) => (ops.push(() => store.set(k, Number(store.get(k) ?? 0) + 1)), p),
        expire: () => p,
        exec: async () => ops.map((op) => op()),
      };
      return p;
    },
  };
  const actor = () => ({ userId: ID, collegeId: ID, role: state.role, departmentId: ID, status: "active" });
  return { ID, DB_MESSAGE, state, client, redis, store, actor };
});

vi.mock("@/lib/redis", () => ({ redis: h.redis }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.client }));
vi.mock("@/lib/rbac", () => ({
  requireRole: async (allowed: readonly string[]) => {
    h.state.role = allowed.includes(h.state.role) ? h.state.role : allowed[0];
    return h.actor();
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ success: true }),
}));
vi.mock("@/lib/push", () => ({ sendExpoPushNotifications: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.store.clear();
  h.redis.set.mockClear();
  h.state.tables = {};
  h.state.fallback = "rows";
  h.state.writes = [];
  h.state.reads = [];
  h.state.failAt = 0;
  h.state.overrides = {};
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => log.mockRestore());

function use(role: string, fallback: TableState, tables: Record<string, TableState> = {}) {
  Object.assign(h.state, { role, fallback, tables });
}

/** The failure a P0 read must produce: thrown, safe, logged, not cached. */
async function expectReadFailure(call: () => Promise<unknown>, { cached }: { cached: boolean }) {
  let thrown: unknown;
  try {
    await call();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "a failed read resolved as if it had succeeded").toBeInstanceOf(Error);
  expect((thrown as Error).name).toBe("InternalOperationError");
  expect((thrown as Error).message).not.toContain("secret_internal_table");
  expect(log.mock.calls.some(([first]: unknown[]) => String(first).includes("[internal] database/service call failed"))).toBe(true);
  if (cached) {
    expect(h.redis.set, "a failed read was cached").not.toHaveBeenCalled();
    expect(h.store.size).toBe(0);
  }
}

// ─── Tier 1: the eight P0 screens ────────────────────────────────────────

describe("HOD approvals", () => {
  const load = async () => (await import("@/app/(portal)/hod/approvals/actions")).listHodApprovals();

  it("returns the queue's records", async () => {
    use("hod", "rows");
    const result = await load();
    expect(result.pending).toHaveLength(2);
    expect(result.processed).toHaveLength(2);
  });

  it("an empty queue is a legitimate empty result, cached as before", async () => {
    use("hod", "rows", { leave_requests: "empty" });
    expect(await load()).toEqual({ pending: [], processed: [] });
    expect(h.redis.set).toHaveBeenCalledTimes(1);
  });

  it("a failed read throws — never 'No pending requests' — and is not cached", async () => {
    use("hod", "rows", { leave_requests: "fail" });
    await expectReadFailure(load, { cached: true });
  });

  it("a failed department or staff lookup fails too, instead of reading as 'no department'", async () => {
    use("hod", "rows", { departments: "fail" });
    await expectReadFailure(load, { cached: true });
    use("hod", "rows", { profiles: "fail" });
    await expectReadFailure(load, { cached: true });
  });

  it("attendance corrections: the same three states", async () => {
    const corrections = async () => (await import("@/app/(portal)/hod/approvals/actions")).listCorrectionApprovals();
    use("hod", "rows");
    expect((await corrections()).pending).toHaveLength(2);
    h.store.clear();
    use("hod", "rows", { attendance_correction_requests: "empty" });
    expect(await corrections()).toEqual({ pending: [], processed: [] });
    h.store.clear();
    h.redis.set.mockClear();
    use("hod", "rows", { attendance_correction_requests: "fail" });
    await expectReadFailure(corrections, { cached: true });
  });
});

describe("Finance refunds", () => {
  const load = async () => (await import("@/app/(portal)/finance/refunds/actions")).listRefundRequests();
  it("records, empty (cached), failed (thrown, not cached)", async () => {
    use("finance", "rows");
    expect((await load()).pending).toHaveLength(2);
    h.store.clear();
    h.redis.set.mockClear();
    use("finance", "empty");
    expect(await load()).toEqual({ pending: [], processed: [] });
    expect(h.redis.set).toHaveBeenCalledTimes(1);
    h.store.clear();
    h.redis.set.mockClear();
    use("finance", "rows", { refund_requests: "fail" });
    await expectReadFailure(load, { cached: true });
  });
});

describe("Warden transfers", () => {
  const load = async () => (await import("@/app/(portal)/warden/transfers/actions")).listRoomTransferRequests();
  it("records, empty, failed transfer read, failed block lookup", async () => {
    use("admin", "rows");
    expect((await load()).pending).toHaveLength(2);
    h.store.clear();
    use("admin", "rows", { room_transfer_requests: "empty" });
    expect(await load()).toEqual({ pending: [], processed: [] });
    h.store.clear();
    h.redis.set.mockClear();
    use("warden", "rows", { room_transfer_requests: "fail" });
    await expectReadFailure(load, { cached: true });
    use("warden", "rows", { hostel_blocks: "fail" });
    await expectReadFailure(load, { cached: true });
  });
});

describe("Warden gate passes", () => {
  const actions = () => import("@/app/(portal)/warden/gatepasses/actions");
  it("pending queue: records, empty, failed read, failed scope lookup", async () => {
    const load = async () => (await actions()).listPendingGatePasses();
    use("warden", "rows");
    expect(await load()).toHaveLength(2);
    h.store.clear();
    use("warden", "rows", { gate_passes: "empty" });
    expect(await load()).toEqual([]);
    h.store.clear();
    h.redis.set.mockClear();
    use("warden", "rows", { gate_passes: "fail" });
    await expectReadFailure(load, { cached: true });
    // There is no scope lookup to fail any more: the warden's block scope is
    // PostgreSQL's (gate_passes_staff_read, migration 050), applied to this
    // one read. The old capped id-list lookups are gone (Phase 3).
    expect([...new Set(h.state.reads)]).toEqual(["gate_passes"]);
  });

  it("gate operations snapshot: a failed read is an error, not zero passes out or zero residents", async () => {
    const load = async () => (await actions()).getGateOperationsSnapshot();
    use("warden", "rows");
    await expect(load()).resolves.toBeDefined();
    for (const [role, table] of [["warden", "gate_passes"], ["admin", "gate_passes"], ["admin", "hostel_allocations"]] as const) {
      h.store.clear();
      h.redis.set.mockClear();
      use(role, "rows", { [table]: "fail" });
      await expectReadFailure(load, { cached: true });
    }
  });
});

describe("Director dashboard (Command Center)", () => {
  const load = async () => (await import("@/app/(portal)/director/dashboard/actions")).getCommandCenterData();
  it("records the view only after its reads succeed", async () => {
    use("director", "rows");
    await load();
    expect(h.state.writes).toContain("upsert:command_center_view_state");
  });

  it("empty data is a legitimate empty Command Center", async () => {
    use("director", "empty");
    const result = await load();
    expect(result.topRiskFlags).toEqual([]);
    expect(result.topDecisions).toEqual([]);
  });

  it("a failed read throws, and no misleading 'viewed' state is written", async () => {
    for (const table of ["institution_metric_snapshots", "risk_flags", "decisions", "command_center_view_state"]) {
      use("director", "rows", { [table]: "fail" });
      await expectReadFailure(load, { cached: false });
      expect(h.state.writes, table).toEqual([]);
    }
  });
});

describe("Director attention", () => {
  const actions = () => import("@/app/(portal)/director/attention/actions");
  it("risk flags: records, empty, failed", async () => {
    const load = async () => (await actions()).listRiskFlags();
    use("director", "rows");
    expect((await load()).open).toHaveLength(2);
    h.store.clear();
    use("director", "empty");
    expect(await load()).toEqual({ open: [], resolved: [] });
    h.store.clear();
    h.redis.set.mockClear();
    use("director", "rows", { risk_flags: "fail" });
    await expectReadFailure(load, { cached: true });
  });

  it("assignments and the student risk overview fail loudly", async () => {
    const mod = await actions();
    use("director", "rows", { risk_flags: "fail" });
    await expectReadFailure(() => mod.listMyRiskFlagAssignments(), { cached: false });
    // One database call since Phase 3 (student_risk_overview, migration 059).
    use("director", "rows", { "rpc:student_risk_overview": "fail" });
    h.store.clear();
    h.redis.set.mockClear();
    await expectReadFailure(() => mod.getStudentRiskOverview(), { cached: true });
  });
});

describe("Director briefing", () => {
  const load = async () => (await import("@/app/(portal)/director/briefing/actions")).getExecutiveBriefing();
  it("records, and records the briefing as generated", async () => {
    use("director", "rows");
    await expect(load()).resolves.toBeDefined();
    expect(h.state.writes.some((w) => w.startsWith("upsert:"))).toBe(true);
  });

  it("empty data is a legitimate empty briefing", async () => {
    use("director", "empty");
    await expect(load()).resolves.toBeDefined();
  });

  it("a failed read throws, and the briefing is not recorded as generated", async () => {
    for (const table of ["institution_metric_snapshots", "risk_flags", "decisions", "strategic_goals"]) {
      use("director", "rows", { [table]: "fail" });
      await expectReadFailure(load, { cached: false });
      expect(h.state.writes, table).toEqual([]);
    }
  });
});

describe("Placement dashboard", () => {
  const load = async () => (await import("@/app/(portal)/placement-cell/dashboard/actions")).getPlacementCellDashboard();
  it("records, empty (cached), and every failed read thrown and not cached", async () => {
    use("placement_cell", "rows");
    await expect(load()).resolves.toBeDefined();
    h.store.clear();
    h.redis.set.mockClear();
    use("placement_cell", "empty");
    await expect(load()).resolves.toBeDefined();
    expect(h.redis.set).toHaveBeenCalledTimes(1);
    for (const table of ["students", "student_placement_profiles", "mv_placement_summary", "companies", "placement_drives", "placement_applications"]) {
      h.store.clear();
      h.redis.set.mockClear();
      use("placement_cell", "rows", { [table]: "fail" });
      await expectReadFailure(load, { cached: true });
    }
  });
});

// ─── Recipient lookup (placement notifications) ─────────────────────────

describe("placement notifications: a failed recipient lookup cannot report a send", () => {
  const send = async (params: Record<string, unknown>) =>
    (await import("@/app/(portal)/placement-cell/notifications/actions")).sendPlacementNotification(params as never);
  const base = { title: "Drive tomorrow", message: "Report at 10:00." };

  // Since Phase 3 the recipients are selected and their notifications
  // written by ONE database call (send_placement_notification, 059): there
  // is no client-side insert to observe, so the call itself is.
  const sent = (count: number) => (h.state.overrides["rpc:send_placement_notification"] = { recipient_count: count, announcement_id: h.ID });

  it("a successful send says to how many", async () => {
    use("placement_cell", "rows");
    sent(2);
    await expect(send({ ...base, targetType: "college" })).resolves.toEqual({ recipientCount: 2 });
    expect(h.state.reads).toContain("rpc:send_placement_notification");
  });

  it("a send that reaches nobody keeps its explicit 'No recipients' error, and pushes nothing", async () => {
    use("placement_cell", "rows", { "rpc:send_placement_notification": "empty" });
    const { sendExpoPushNotifications } = await import("@/lib/push");
    vi.mocked(sendExpoPushNotifications).mockClear();
    await expect(send({ ...base, targetType: "college" })).rejects.toThrow("No recipients found for the selected audience.");
    expect(sendExpoPushNotifications).not.toHaveBeenCalled();
  });

  it("a failed send or a failed audience check fails loudly — no false success", async () => {
    use("placement_cell", "rows", { "rpc:send_placement_notification": "fail" });
    await expectReadFailure(() => send({ ...base, targetType: "college" }), { cached: false });
    use("placement_cell", "rows", { departments: "fail" });
    sent(2);
    h.state.reads = [];
    await expectReadFailure(() => send({ ...base, targetType: "department", departmentId: h.ID }), { cached: false });
    expect(h.state.reads).not.toContain("rpc:send_placement_notification"); // the audience check failed before any send
  });
});

// ─── lib/offerings: the class and semester pickers ──────────────────────

describe("lib/offerings: an empty picker only when the read succeeded", () => {
  it("listTeachableOfferings: records, legitimate empty, failure thrown", async () => {
    const { listTeachableOfferings } = await import("@/lib/offerings");
    const teacher = { ...h.actor(), role: "teacher" } as never;
    use("teacher", "rows");
    expect(await listTeachableOfferings(h.client as never, teacher)).toHaveLength(2);
    use("teacher", "empty");
    expect(await listTeachableOfferings(h.client as never, teacher)).toEqual([]);
    use("teacher", "rows", { course_offerings: "fail" });
    await expectReadFailure(() => listTeachableOfferings(h.client as never, teacher), { cached: false });
  });

  it("getActiveSemesterId: an id, null when there is none, failure thrown", async () => {
    const { getActiveSemesterId } = await import("@/lib/offerings");
    const teacher = { ...h.actor(), role: "teacher" } as never;
    use("teacher", "rows");
    expect(await getActiveSemesterId(h.client as never, teacher)).toBe(h.ID);
    use("teacher", "empty");
    expect(await getActiveSemesterId(h.client as never, teacher)).toBeNull();
    use("teacher", "rows", { semesters: "fail" });
    await expectReadFailure(() => getActiveSemesterId(h.client as never, teacher), { cached: false });
  });
});

// Inject each query independently, including two reads against the same table.
const p0Cases = [
  ["hod/approvals", "listHodApprovals", "hod", 4, 30],
  ["hod/approvals", "listCorrectionApprovals", "hod", 4, 30],
  ["hod/approvals", "listCorrectionApprovals", "admin", 2, 30],
  ["finance/refunds", "listRefundRequests", "finance", 2, 30],
  ["warden/transfers", "listRoomTransferRequests", "warden", 3, 30],
  // Phase 3: one read each, scoped by RLS; the capped scope lookups are gone.
  ["warden/gatepasses", "listPendingGatePasses", "warden", 1, 15],
  ["warden/gatepasses", "listProcessedGatePasses", "warden", 1, 30],
  // Residents, outside, late returns, pending exits — four counted reads for both roles.
  ["warden/gatepasses", "getGateOperationsSnapshot", "warden", 4, 30],
  ["warden/gatepasses", "getGateOperationsSnapshot", "admin", 4, 30],
  ["director/dashboard", "getCommandCenterData", "director", 5, 0],
  ["director/attention", "listRiskFlags", "hod", 3, 30],
  ["director/attention", "listRiskFlags", "director", 2, 30],
  ["director/attention", "listMyRiskFlagAssignments", "hod", 1, 30],
  // The HOD's department, then one database call (student_risk_overview).
  ["director/attention", "getStudentRiskOverview", "hod", 2, 120],
  ["director/briefing", "getExecutiveBriefing", "director", 4, 0],
  ["placement-cell/dashboard", "getPlacementCellDashboard", "placement_cell", 8, 60],
] as const;

for (const [area, name, role, reads, ttl] of p0Cases) {
  describe(`${area}.${name} as ${role}: query-by-query contract`, () => {
    const call = async () => {
      const actions = await import(`@/app/(portal)/${area}/actions.ts`);
      return actions[name]({ search: "", sortKey: null, sortDir: "asc", page: 0 });
    };
    it.each(["rows", "empty"] as const)("successful %s result retains caching", async (mode) => {
      use(role, mode);
      const result = await call();
      expect(result).toBeDefined();
      if (mode === "rows") expect(h.state.reads).toHaveLength(reads);
      if (ttl) {
        expect(h.redis.set).toHaveBeenCalledTimes(1);
        // A versioned family (lib/cache.ts) stores { v, d }; the cached
        // payload must be exactly the result either way. Compared by
        // identity: the fake rows are proxies, not plain data.
        const [, stored, opts] = h.redis.set.mock.lastCall! as unknown as [string, unknown, unknown];
        expect(opts).toEqual({ ex: ttl });
        const payload =
          stored && typeof stored === "object" && "v" in stored && "d" in stored ? (stored as { d: unknown }).d : stored;
        expect(payload).toBe(result);
        expect(await call()).toEqual(result);
        expect(h.redis.set).toHaveBeenCalledTimes(1);
      }
    });
    it.each(Array.from({ length: reads }, (_, i) => i + 1))("read %i fails safely and cannot be cached or record a view", async (ordinal) => {
      use(role, "rows");
      h.state.failAt = ordinal;
      await expectReadFailure(call, { cached: !!ttl });
      expect(h.state.reads.length).toBeGreaterThanOrEqual(ordinal);
      expect(h.state.writes).toEqual([]);
    });
  });
}

describe("recipient lookup: every audience and every read", () => {
  const cases = [
    // The audience check (department / drive), then the one send call.
    { targetType: "college", reads: 1 },
    { targetType: "department", departmentId: h.ID, reads: 2 },
    { targetType: "batch_year", batchYear: 2026, reads: 1 },
    { targetType: "eligible", driveId: h.ID, reads: 2 },
    { targetType: "custom", studentUserIds: [h.ID], reads: 1 },
  ];
  for (const audience of cases) {
    const send = async () => (await import("@/app/(portal)/placement-cell/notifications/actions")).sendPlacementNotification({ title: "Drive", message: "Tomorrow", ...audience } as never);
    it(`${audience.targetType}: success and zero-recipient semantics`, async () => {
      use("placement_cell", "rows");
      h.state.overrides.placement_drives = { min_cgpa: 0, eligible_batch_years: [] };
      h.state.overrides["rpc:send_placement_notification"] = { recipient_count: 2, announcement_id: h.ID };
      await expect(send()).resolves.toEqual({ recipientCount: 2 });
      h.state.writes = [];
      h.state.tables["rpc:send_placement_notification"] = "empty";
      await expect(send()).rejects.toThrow("No recipients found for the selected audience.");
      expect(h.state.writes).toEqual([]);
    });
    for (let ordinal = 1; ordinal <= audience.reads; ordinal++) {
      it(`${audience.targetType}: read ${ordinal} fails before any send`, async () => {
        use("placement_cell", "rows");
        h.state.overrides.placement_drives = { min_cgpa: 0, eligible_batch_years: [] };
        h.state.overrides["rpc:send_placement_notification"] = { recipient_count: 2, announcement_id: h.ID };
        h.state.failAt = ordinal;
        const { sendExpoPushNotifications } = await import("@/lib/push");
        vi.mocked(sendExpoPushNotifications).mockClear();
        await expectReadFailure(send, { cached: false });
        expect(h.state.writes).toEqual([]);
        expect(sendExpoPushNotifications).not.toHaveBeenCalled();
      });
    }
  }
});

describe("shared helpers: read callers opt in without changing write decisions", () => {
  it.each([
    ["placement_rate", "mv_department_health"], ["avg_cgpa", "mv_department_enrollment"],
    ["attendance_pct", "mv_department_health"], ["fee_collection_pct", "mv_fee_summary"],
    ["hostel_occupancy_pct", "hostel_blocks"], ["hostel_occupancy_pct", "rpc:hostel_block_capacity"],
  ])("auto goal %s propagates a failed %s lookup", async (metric, table) => {
    use("director", "rows", { [table]: "fail" });
    h.state.overrides.strategic_goals = { tracking_mode: "auto", metric_key: metric };
    const { listGoals } = await import("@/app/(portal)/director/goals/actions");
    await expectReadFailure(listGoals, { cached: false });
    expect(h.state.writes).toEqual([]);
    h.state.tables[table] = "empty";
    const rows = await listGoals();
    expect(rows).toHaveLength(2);
    expect(rows.every((goal) => goal.current_value === null)).toBe(true);
  });
  it.each(["course_offerings", "timetable_slots"])("leave preview propagates failed %s", async (table) => {
    use("admin", "rows", { [table]: "fail" });
    const { previewLeaveImpact } = await import("@/app/(portal)/hod/approvals/actions");
    await expectReadFailure(() => previewLeaveImpact(h.ID), { cached: false });
    expect(h.state.writes).toEqual([]);
    h.state.tables[table] = "empty";
    expect((await previewLeaveImpact(h.ID)).affectedClasses).toEqual([]);
  });
});
