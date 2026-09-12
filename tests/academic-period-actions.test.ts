import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Core functions behind app/(portal)/admin/academic-periods — driven
 * with a hand-built client so the assertions are about what the action
 * SENDS and what it does with what comes back, not about Postgres (the
 * database rules are proven in tests/staging-academic-period.test.ts).
 *
 * The two properties that matter here and nowhere else:
 *   - every transition is a compare-and-swap on the status it expects to
 *     leave, and a lost race is an error with no audit row;
 *   - the tenant and status preconditions are checked against a read-back,
 *     never trusted from the caller.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/redis", () => ({ redis: null }));

type Row = Record<string, unknown>;
type Write = { table: string; op: string; payload: unknown; filters: [string, string, unknown][] };
const ACTOR = { userId: "10000000-0000-4000-8000-000000000001", collegeId: "college-A", role: "admin" as const };
const ID = "20000000-0000-4000-8000-000000000001";
const YEAR = "20000000-0000-4000-8000-000000000002";

let reads: Record<string, Row | null>;
let writes: Write[];
let audits: Row[];
let claimedRows: Row[];

function client() {
  const from = (table: string) => {
    const filters: [string, string, unknown][] = [];
    const chain: Record<string, unknown> = {};
    let op = "select";
    let payload: unknown;
    const finish = () => {
      if (op === "select") return Promise.resolve({ data: reads[table] ?? null, error: null });
      writes.push({ table, op, payload, filters });
      if (table === "audit_logs") {
        audits.push(payload as Row);
        return Promise.resolve({ data: null, error: null });
      }
      if (op === "insert") return Promise.resolve({ data: { id: ID }, error: null });
      return Promise.resolve({ data: claimedRows, error: null });
    };
    chain.select = () => chain;
    chain.single = finish;
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => finish().then(res, rej);
    for (const f of ["eq", "neq"]) chain[f] = (col: string, val: unknown) => { filters.push([f, col, val]); return chain; };
    chain.insert = (p: unknown) => { op = "insert"; payload = p; return chain; };
    chain.update = (p: unknown) => { op = "update"; payload = p; return chain; };
    chain.delete = () => { op = "delete"; return chain; };
    return chain;
  };
  return { from } as never;
}

beforeEach(() => {
  reads = {};
  writes = [];
  audits = [];
  claimedRows = [{ id: ID }];
});

const actions = () => import("@/app/(portal)/admin/academic-periods/actions");
const mutations = () => writes.filter((w) => w.table !== "audit_logs");

describe("createSemesterCore", () => {
  it("writes the semester as planned, in the actor's college, and keys the legacy text on the year's name", async () => {
    reads.academic_years = { id: YEAR, name: "2027-28", college_id: "college-A", status: "active" };
    const { createSemesterCore } = await actions();
    await createSemesterCore(client(), ACTOR, { academicYearId: YEAR, name: "Odd 2027", sequenceNo: 1, startDate: "2027-06-01", endDate: "2027-11-30" });
    const ins = writes.find((w) => w.table === "semesters" && w.op === "insert")!;
    expect(ins.payload).toMatchObject({ college_id: "college-A", academic_year_id: YEAR, academic_year: "2027-28", status: "planned", sequence_no: 1 });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ table_name: "semesters", user_id: ACTOR.userId, college_id: "college-A" });
  });

  it("refuses a year that belongs to another college, before writing anything", async () => {
    reads.academic_years = { id: YEAR, name: "2027-28", college_id: "college-B", status: "active" };
    const { createSemesterCore } = await actions();
    await expect(createSemesterCore(client(), ACTOR, { academicYearId: YEAR, name: "x", sequenceNo: 1, startDate: "2027-06-01", endDate: "2027-11-30" }))
      .rejects.toThrow(/not found in your college/);
    expect(writes).toEqual([]);
  });

  it("refuses a closed year and a backwards date range", async () => {
    reads.academic_years = { id: YEAR, name: "2025-26", college_id: "college-A", status: "closed" };
    const { createSemesterCore } = await actions();
    await expect(createSemesterCore(client(), ACTOR, { academicYearId: YEAR, name: "x", sequenceNo: 1, startDate: "2027-06-01", endDate: "2027-11-30" }))
      .rejects.toThrow(/closed/);
    await expect(createSemesterCore(client(), ACTOR, { academicYearId: YEAR, name: "x", sequenceNo: 1, startDate: "2027-11-30", endDate: "2027-06-01" }))
      .rejects.toThrow(/End date must be after/);
    expect(writes).toEqual([]);
  });
});

describe("transitionSemesterCore", () => {
  it("activate is a compare-and-swap from planned, scoped to the actor's college, and audited as a diff", async () => {
    reads.semesters = { id: ID, name: "Odd 2027", status: "planned", college_id: "college-A" };
    const { transitionSemesterCore } = await actions();
    await transitionSemesterCore(client(), ACTOR, ID, "activate");
    const [upd] = mutations();
    expect(upd).toMatchObject({ table: "semesters", op: "update", payload: { status: "active" } });
    expect(upd.filters).toEqual(expect.arrayContaining([["eq", "id", ID], ["eq", "college_id", "college-A"], ["eq", "status", "planned"]]));
    expect(audits[0]).toMatchObject({ table_name: "semesters", record_id: ID, old_value: { status: "planned" }, new_value: { status: "active" } });
  });

  it("a lost race — the predicate matched nothing — is an error, and nothing is audited", async () => {
    reads.semesters = { id: ID, name: "Odd 2027", status: "active", college_id: "college-A" };
    claimedRows = [];
    const { transitionSemesterCore } = await actions();
    await expect(transitionSemesterCore(client(), ACTOR, ID, "close")).rejects.toThrow(/already actioned/);
    expect(audits).toEqual([]);
  });

  it("refuses the wrong starting status and another college's semester without writing", async () => {
    const { transitionSemesterCore } = await actions();
    reads.semesters = { id: ID, name: "x", status: "closed", college_id: "college-A" };
    await expect(transitionSemesterCore(client(), ACTOR, ID, "activate")).rejects.toThrow(/Only a planned semester/);
    reads.semesters = { id: ID, name: "x", status: "planned", college_id: "college-B" };
    await expect(transitionSemesterCore(client(), ACTOR, ID, "activate")).rejects.toThrow(/not found in your college/);
    expect(writes).toEqual([]);
  });

  it("translates the one-active index violation into an instruction", async () => {
    reads.semesters = { id: ID, name: "x", status: "planned", college_id: "college-A" };
    const failing = {
      from: (table: string) => {
        const c = client() as unknown as { from: (t: string) => Record<string, unknown> };
        const chain = c.from(table);
        if (table === "semesters") {
          const orig = chain.update as (p: unknown) => Record<string, unknown>;
          chain.update = (p: unknown) => {
            const q = orig(p);
            q.then = (res: (v: unknown) => unknown) =>
              Promise.resolve({ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "idx_semesters_one_active"' } }).then(res);
            return q;
          };
        }
        return chain;
      },
    } as never;
    const { transitionSemesterCore } = await actions();
    await expect(transitionSemesterCore(failing, ACTOR, ID, "activate")).rejects.toThrow(/Close it before activating/);
    expect(audits).toEqual([]);
  });
});

describe("deleteSemesterCore", () => {
  it("only deletes a planned semester, as a compare-and-swap on that status", async () => {
    reads.semesters = { id: ID, name: "x", status: "planned", college_id: "college-A" };
    const { deleteSemesterCore } = await actions();
    await deleteSemesterCore(client(), ACTOR, ID);
    const [del] = mutations();
    expect(del.op).toBe("delete");
    expect(del.filters).toEqual(expect.arrayContaining([["eq", "status", "planned"], ["eq", "college_id", "college-A"]]));
    reads.semesters = { id: ID, name: "x", status: "active", college_id: "college-A" };
    await expect(deleteSemesterCore(client(), ACTOR, ID)).rejects.toThrow(/Only a planned semester/);
  });
});
