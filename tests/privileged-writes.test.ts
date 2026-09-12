import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A write that changes someone's authority must not be able to REPORT
 * success it did not have.
 *
 * Supabase reports an RLS-filtered UPDATE as success with zero rows, and
 * migration 042's trigger reports a refused role change as an error the
 * caller is free to ignore. Three admin/director actions ignored both,
 * then wrote an audit row describing a change that never happened:
 *
 *   updateUserProfileCore  "Updated profile (role: director)"     — own role, refused by 042
 *   updateUserStatusCore   "Changed status to suspended"           — foreign college, 0 rows
 *   assignHodCore          (no audit row at all, in either outcome)
 *
 * Each is now confirmed with .select("id") + assertClaimed, exactly as the
 * placement-cell actions already did. These tests pin that: refused ->
 * throws, nothing audited; filtered -> throws, nothing audited; succeeded ->
 * audited with a before/after diff where one exists.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/redis", () => ({ redis: null }));
vi.mock("@/lib/cache", () => ({
  getCached: async (_k: string, _t: number, fn: () => unknown) => fn(),
  invalidateCache: async () => {},
  middlewareProfileCacheKey: (id: string) => `mw:${id}`,
}));

type Row = Record<string, unknown>;
const ACTOR = { userId: "10000000-0000-4000-8000-000000000001", collegeId: "college-A", role: "admin" as const };
const DIRECTOR = { ...ACTOR, role: "director" as const };
const TARGET = "10000000-0000-4000-8000-000000000002";
const DEPT = "10000000-0000-4000-8000-000000000003";

let reads: Record<string, Row | null>;
let audits: Row[];
let updateResult: { data: Row[] | null; error: { message: string } | null };
let updates: { table: string; payload: unknown }[];

function client() {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    let op = "select";
    let payload: unknown;
    const finish = () => {
      if (table === "audit_logs") { audits.push(payload as Row); return Promise.resolve({ data: null, error: null }); }
      if (op === "select") return Promise.resolve({ data: reads[table] ?? null, error: null });
      updates.push({ table, payload });
      return Promise.resolve(updateResult);
    };
    for (const f of ["select", "eq", "neq", "in", "order"]) chain[f] = () => chain;
    chain.single = finish;
    chain.maybeSingle = finish;
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => finish().then(res, rej);
    chain.insert = (p: unknown) => { op = "insert"; payload = p; return chain; };
    chain.update = (p: unknown) => { op = "update"; payload = p; return chain; };
    return chain;
  };
  return { from } as never;
}

beforeEach(() => {
  reads = {};
  audits = [];
  updates = [];
  updateResult = { data: [{ id: TARGET }], error: null };
});

describe("updateUserProfileCore", () => {
  const params = { targetUserId: TARGET, fullName: "T", role: "director" as const };

  it("a write the database refused is an error and is NOT audited", async () => {
    // e.g. an admin editing their OWN role — 042 raises; zod already refuses
    // super_admin before the database is reached.
    updateResult = { data: null, error: { message: "You cannot change your own role, status or department." } };
    const { updateUserProfileCore } = await import("@/app/(portal)/admin/users/actions");
    await expect(updateUserProfileCore(client(), ACTOR, params)).rejects.toThrow(/cannot change your own role/);
    expect(audits).toEqual([]);
  });

  it("a write RLS filtered to zero rows is an error and is NOT audited", async () => {
    updateResult = { data: [], error: null };
    const { updateUserProfileCore } = await import("@/app/(portal)/admin/users/actions");
    await expect(updateUserProfileCore(client(), ACTOR, { ...params, role: "hod" })).rejects.toThrow(/already actioned|Reload/);
    expect(audits).toEqual([]);
  });

  it("a confirmed write is audited", async () => {
    const { updateUserProfileCore } = await import("@/app/(portal)/admin/users/actions");
    await updateUserProfileCore(client(), ACTOR, { ...params, role: "hod" });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ table_name: "profiles", record_id: TARGET });
  });
});

describe("updateUserStatusCore", () => {
  it("zero rows -> error, no audit; confirmed -> audited", async () => {
    const { updateUserStatusCore } = await import("@/app/(portal)/admin/users/actions");
    updateResult = { data: [], error: null };
    await expect(updateUserStatusCore(client(), ACTOR, TARGET, "suspended")).rejects.toThrow();
    expect(audits).toEqual([]);
    updateResult = { data: [{ id: TARGET }], error: null };
    await updateUserStatusCore(client(), ACTOR, TARGET, "suspended");
    expect(audits).toHaveLength(1);
  });
});

describe("assignHodCore", () => {
  beforeEach(() => {
    reads.departments = { id: DEPT, college_id: "college-A", hod_id: "old-hod" };
    reads.profiles = { id: TARGET, role: "teacher", college_id: "college-A" };
  });

  it("records the authority change as a before/after diff", async () => {
    const { assignHodCore } = await import("@/app/(portal)/director/departments/actions");
    await assignHodCore(client(), DIRECTOR, DEPT, TARGET);
    expect(updates).toEqual([{ table: "departments", payload: { hod_id: TARGET } }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "Assigned department head", table_name: "departments", record_id: DEPT,
      old_value: { hod_id: "old-hod" }, new_value: { hod_id: TARGET },
    });
  });

  it("removal is audited too, and a zero-row write is an error with no audit", async () => {
    const { assignHodCore } = await import("@/app/(portal)/director/departments/actions");
    await assignHodCore(client(), DIRECTOR, DEPT, null);
    expect(audits[0]).toMatchObject({ action: "Removed department head", new_value: { hod_id: null } });
    audits = [];
    updateResult = { data: [], error: null };
    await expect(assignHodCore(client(), DIRECTOR, DEPT, TARGET)).rejects.toThrow();
    expect(audits).toEqual([]);
  });

  it("DOCUMENTED (W1): a teacher can be assigned head without their role changing — the assignment is inert", async () => {
    // profiles.role stays 'teacher'; every HOD policy and requireRole(['hod'])
    // reads that column. Whether assign_hod should promote is a design
    // decision (register W1) — this pins that today it does not.
    const { assignHodCore } = await import("@/app/(portal)/director/departments/actions");
    await assignHodCore(client(), DIRECTOR, DEPT, TARGET);
    expect(updates.map((u) => u.table)).toEqual(["departments"]);
  });
});
