import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Read-failure contract (S1, owner decision D5) — a behavioural guard.
 *
 * Every server read that feeds a screen must keep "the read failed" apart
 * from "the read found nothing". This finds every exported read function in
 * app/(portal)/**\/actions.ts — one that writes nothing — and drives it
 * against a stand-in Supabase client. For every read the function performs,
 * it makes exactly that read fail ({ data: null, error }). The function must
 * then THROW: it may never resolve, because a resolved value is what a page
 * renders as "No pending requests". The thrown message must not carry the
 * database's words. With every read succeeding it must not throw a read
 * failure — a legitimate empty result stays empty.
 *
 * Reads are exercised twice, with empty results and with one stand-in row
 * per read, so reads reached only when earlier ones find something are
 * covered too. A new read function is covered the day it is written.
 */

type Mode = "empty" | "rows";

const h = vi.hoisted(() => {
  const state = { mode: "empty" as "empty" | "rows", failAt: 0, reads: 0, role: "director" };
  const ID = "00000000-0000-4000-8000-000000000009";
  const DATE = "2026-09-01T04:00:00.000Z";

  // A stand-in row: dates for date-like fields, numbers for numeric ones,
  // an id-shaped string for everything else (nested relations too).
  const NUMERIC = /(amount|count|score|cgpa|pct|percent|capacity|occupancy|occupied|credits|rate|lpa|total|number|value|year|limit|marks|max|min|days|period|order|index|size|attempt)/i;
  const row = (table: string): Record<string, unknown> =>
    new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (table === "security_personnel" && prop === "status") return "ACTIVE";
        if (table === "strategic_goals" && prop === "tracking_mode") return "auto";
        if (table === "strategic_goals" && prop === "metric_key") return "fee_collection_pct";
        if (prop === "profiles") return { department_id: ID, full_name: "Teacher" };
        if (prop === "eligible_batch_years") return [];
        if (prop === "toJSON") return () => ({ id: ID });
        if (typeof prop === "symbol") return undefined;
        if (/(_at|date|time)$/i.test(prop)) return DATE;
        if (/^is_|^has_|enabled$|active$/.test(prop)) return true;
        if (NUMERIC.test(prop)) return 1;
        return ID;
      },
      has: () => true,
      ownKeys: () => ["id"],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: ID }),
    });

  function query(table: string): unknown {
    let single = false;
    // Writes (a view-state upsert, say) are outside this contract: counted
    // as neither reads nor failures.
    let write = false;
    const self: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
            if (write) return Promise.resolve({ data: null, count: null, error: null }).then(resolve, reject);
            state.reads++;
            const failed = state.reads === state.failAt;
            const value = failed
              ? { data: null, count: null, error: { code: "42P01", message: 'relation "secret_internal_table" does not exist' } }
              : state.mode === "rows"
                ? { data: single ? row(table) : [row(table)], count: 1, error: null }
                : { data: single ? null : [], count: 0, error: null };
            return Promise.resolve(value).then(resolve, reject);
          };
        }
        if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") {
          return () => {
            write = true;
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
    rpc: (name: string) => query(name),
    auth: { getUser: async () => ({ data: { user: { id: ID } }, error: null }) },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  };
  const actor = () => ({ userId: ID, collegeId: ID, role: state.role, departmentId: ID, status: "active" });
  return { state, client, actor, ID };
});

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
vi.mock("@/lib/redis", () => ({ redis: null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

/**
 * Exported read functions outside this contract, each with its reason.
 * Keep this list short and specific: never a wildcard.
 */
export const READ_CONTRACT_EXCLUSIONS: Record<string, string> = {
  // Asks a question per key; driven below, question by question.
  "director/ask.answerQuestion": "covered by its own case, one sweep per question",
  // Finance reconciliation (D5 exclusion): lib/finance/credentials and
  // lib/finance/mapping decide integration readiness.
  "finance/integrations.connectionCredentialPresent": "lib/finance/credentials hasCredential (finance reconciliation, D5)",
  "finance/integrations.mappingReadiness": "lib/finance/mapping validateMappings (finance reconciliation, D5)",
};

/** Read functions whose only write is recording that the view was seen. */
const VIEW_STATE_READS = new Set(["director/dashboard.getCommandCenterData", "director/briefing.getExecutiveBriefing"]);

/** A call to an imported write action — invitations, for instance. */
const IMPORTED_WRITE = /\bawait\s+(?!create(?:Admin)?Client\b)(invite|resend|revoke|create|update|delete|assign|approve|reject|send|record|submit|apply|cancel|fanOut|push)[A-Z]\w*\s*\(/;

// Every function that writes: mutations are not read functions. A state-
// changing database function reached through lib/college-access's
// callAccessRpc (set_/revoke_/end_/register_, migrations 053/054) is a write
// too; a read through it (session_enforcement_readiness) stays a read.
const WRITE = /\.(insert|update|upsert|delete)\s*\(|\.rpc\s*\(|auth\.admin\.|storage\.from|sendEmail|revalidatePath|writeAudit|logAudit|sendExpoPushNotifications|invalidateCache|callAccessRpc(?:<[^>]*>)?\(\s*\w+,\s*"(?:set_|revoke_|end_|register_)/;

function actionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return actionFiles(path);
    return entry === "actions.ts" ? [path.replace(/\\/g, "/")] : [];
  });
}

const ROLE_BY_AREA: Record<string, string> = {
  admin: "admin", director: "director", finance: "finance", hod: "hod", "placement-cell": "placement_cell",
  security: "security", student: "student", "super-admin": "super_admin", teacher: "teacher", warden: "warden",
};

type Target = { module: string; fn: string; params: string[]; role: string };

/**
 * Exported async functions that write nothing, from source. A function
 * writes if it writes itself or calls a function in its file that writes
 * (a *ViaRequest wrapper around a *Core mutation, say).
 */
function discover(): Target[] {
  const targets: Target[] = [];
  for (const file of actionFiles("app/(portal)")) {
    const actionModule = file.replace("app/(portal)/", "").replace("/actions.ts", "");
    const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const heads = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=/gm)];
    const fns = heads.map((m, i) => ({
      name: m[1] ?? m[2],
      exported: /^export/.test(m[0]),
      body: src.slice(m.index!, i + 1 < heads.length ? heads[i + 1].index! : src.length),
    }));
    // Direct writes, and calls to imported write actions (lib/invitations's
    // inviteUser, say) whose effects are elsewhere.
    const writers = new Set(fns.filter((f) => WRITE.test(f.body) || IMPORTED_WRITE.test(f.body)).map((f) => f.name));
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of fns) {
        if (writers.has(f.name)) continue;
        if ([...writers].some((w) => new RegExp(`\\b${w}\\s*\\(`).test(f.body.slice(f.body.indexOf("{"))))) {
          writers.add(f.name);
          grew = true;
        }
      }
    }
    for (const f of fns) {
      const key = `${actionModule}.${f.name}`;
      if (!f.exported || key in READ_CONTRACT_EXCLUSIONS) continue;
      if (writers.has(f.name) && !VIEW_STATE_READS.has(key)) continue;
      const sig = /^export\s+async\s+function\s+\w+\s*\(([^)]*)\)/.exec(f.body);
      if (!sig || !/\.from\(|await\s+\w+\(supabase/.test(f.body)) continue;
      const params = sig[1].split(",").map((p) => p.trim().split(/[?:=\s]/)[0]).filter(Boolean);
      targets.push({ module: actionModule, fn: f.name, params, role: ROLE_BY_AREA[actionModule.split("/")[0]] ?? "director" });
    }
  }
  return targets;
}

const QUERY = { search: "", sortKey: null, sortDir: "asc", page: 1 };
function argsFor(params: string[]): unknown[] {
  return params.map((p) => {
    if (/^(q|query)$/.test(p)) return QUERY;
    if (/^(filters|opts|options)$/.test(p)) return {};
    if (p === "limit") return undefined;
    if (p === "supabase") return h.client;
    if (p === "actor") return h.actor();
    return h.ID; // ids: departmentId, requestId, driveIdRaw, passIdRaw, gateId …
  });
}

type Outcome = { threw: false; reads: number } | { threw: true; error: Error; reads: number };
type Fn = (...a: unknown[]) => Promise<unknown>;

async function run(fn: Fn, args: unknown[], mode: Mode, failAt: number, role: string): Promise<Outcome> {
  Object.assign(h.state, { mode, failAt, reads: 0, role });
  try {
    await fn(...args);
    return { threw: false, reads: h.state.reads };
  } catch (error) {
    return { threw: true, error: error as Error, reads: h.state.reads };
  }
}

/** Every "read n fails" case for one function in one mode; returns reads exercised. */
async function sweep(name: string, role: string, mode: Mode, fn: Fn, args: unknown[]): Promise<number> {
  const baseline = await run(fn, args, mode, 0, role);
  // A successful read never surfaces as a read failure.
  if (baseline.threw) baselineErrors[`${name} (${mode})`] = `${baseline.error.name}: ${baseline.error.message}`;
  if (baseline.threw) {
    expect(baseline.error.name).toBe("Error");
    expect(baseline.error.message).toMatch(/^(Risk flag not found\.|Decision not found\.|Department not found\.|Integration connection not found in your college\.|No adapter registered for provider |Leave request not found\.|Placement drive not found in your college\.|No student record found for this account\.|Student profile not found\.)/);
  }
  if (baseline.threw) expect(baseline.error.name, `${name} (${mode}, every read succeeds) threw a read failure`).not.toBe("InternalOperationError");
  for (let n = 1; n <= baseline.reads; n++) {
    const failed = await run(fn, args, mode, n, role);
    expect(failed.threw, `${name}: read ${n} of ${baseline.reads} failed (${mode}) but the function resolved as if it had succeeded`).toBe(true);
    if (failed.threw) {
      expect(failed.error.name, `${name}: read ${n} must fail because of the database, not a fixture error`).not.toBe("TypeError");
      expect(failed.error.message, `${name}: read ${n} (${mode})`).not.toContain("secret_internal_table");
      injectedFailures++;
    }
  }
  return baseline.reads;
}

const TARGETS = discover();
let injectedFailures = 0;
afterAll(() => {
  if (process.env.D5_REPORT_PATH) writeFileSync(process.env.D5_REPORT_PATH, JSON.stringify({ targets: TARGETS.map((t) => `${t.module}.${t.fn}`), exclusions: READ_CONTRACT_EXCLUSIONS, injectedFailures, baselineErrors }, null, 2));
});
const baselineErrors: Record<string, string> = {};

// Tier 1 (the P0 screens) must be among the discovered functions — so that
// narrowing discovery can never quietly drop them.
const TIER_1 = [
  "hod/approvals.listHodApprovals", "hod/approvals.listCorrectionApprovals",
  "finance/refunds.listRefundRequests",
  "warden/transfers.listRoomTransferRequests",
  "warden/gatepasses.listPendingGatePasses", "warden/gatepasses.listProcessedGatePasses", "warden/gatepasses.getGateOperationsSnapshot",
  "director/dashboard.getCommandCenterData",
  "director/attention.listRiskFlags", "director/attention.listMyRiskFlagAssignments", "director/attention.getStudentRiskOverview",
  "director/briefing.getExecutiveBriefing",
  "placement-cell/dashboard.getPlacementCellDashboard",
];

describe("read-failure contract: a failed read never resolves as an empty success", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
  });

  it("discovers every read function, the Tier 1 screens included", () => {
    const names = TARGETS.map((t) => `${t.module}.${t.fn}`);
    for (const name of TIER_1) expect(names, name).toContain(name);
    expect(TARGETS.length).toBeGreaterThanOrEqual(80);
  });

  it.each(TARGETS.map((t) => [`${t.module}.${t.fn}`, t] as const))("%s", async (name, target) => {
    const mod = (await import(`@/app/(portal)/${target.module}/actions.ts`)) as Record<string, Fn>;
    const fn = mod[target.fn];
    let reads = 0;
    // The area's role, then admin: admin-only branches are reads too. (A role
    // the function does not allow becomes its first allowed role.)
    for (const role of new Set([target.role, "admin"])) {
      h.state.role = role;
      const args = argsFor(target.params); // an actor argument carries this role
      reads += (await sweep(`${name} as ${role}`, role, "empty", fn, args)) + (await sweep(`${name} as ${role}`, role, "rows", fn, args));
    }
    expect(reads, `${name} performed no reads — not exercised`).toBeGreaterThan(0);
  });

  it("director/ask.answerQuestion: every question's reads fail loudly", async () => {
    const { QUESTIONS } = await import("@/app/(portal)/director/ask/questions");
    const { answerQuestion } = await import("@/app/(portal)/director/ask/actions");
    // A question answered without the database (reads 0) is legitimate; the
    // family as a whole must be exercised.
    let reads = 0;
    for (const question of QUESTIONS) {
      const name = `answerQuestion(${question.key})`;
      reads += (await sweep(name, "director", "empty", answerQuestion as Fn, [question.key])) + (await sweep(name, "director", "rows", answerQuestion as Fn, [question.key]));
    }
    expect(reads).toBeGreaterThan(0);
  });

  it("lib/offerings: listTeachableOfferings and getActiveSemesterId fail loudly, for every role", async () => {
    const offerings = await import("@/lib/offerings");
    for (const name of ["listTeachableOfferings", "getActiveSemesterId"] as const) {
      for (const role of ["teacher", "hod", "admin"]) {
        const args = [h.client, { ...h.actor(), role }];
        const fn = offerings[name] as unknown as Fn;
        expect((await sweep(`${name} as ${role}`, role, "empty", fn, args)) + (await sweep(`${name} as ${role}`, role, "rows", fn, args))).toBeGreaterThan(0);
      }
    }
  });
});
