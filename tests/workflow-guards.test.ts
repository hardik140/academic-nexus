import { describe, it, expect, vi, beforeEach } from "vitest";

// These two Server Actions have no Core/ViaRequest split (no mobile screen
// needs them), so — unlike tests/api-mobile.test.ts's mobile-route harness —
// this mocks @/lib/rbac's requireRole and @/lib/supabase/server's createClient
// directly and calls the exported web Server Actions themselves.

const mockRequireRole = vi.fn();
vi.mock("@/lib/rbac", () => ({ requireRole: mockRequireRole }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const insertCalls: { table: string; row: unknown }[] = [];
const updateCalls: { table: string; row: unknown }[] = [];

/** A single-row lookup ({...}.select().eq().single()) that resolves to `result`. */
function selectSingle(result: { data: unknown; error?: unknown }) {
  const builder = {
    eq: () => builder,
    single: () => Promise.resolve(result),
  };
  return builder;
}

/**
 * A write ({...}.update(x).eq()...[.select()]) — thenable, always succeeds.
 *
 * `select()` models the compare-and-swap tail every approval now ends with
 * (see lib/concurrent-claim.ts): it resolves to one matched row, i.e. this
 * caller won the race. `updateLostRace` below is the other outcome.
 */
function updateOk(table: string) {
  return (row: unknown) => {
    updateCalls.push({ table, row });
    const builder = {
      eq: () => builder,
      select: () => Promise.resolve({ data: [{ id: "row-1" }], error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
    };
    return builder;
  };
}

/**
 * The losing side of a compare-and-swap: the status predicate matched no
 * row because someone else already acted. Supabase reports this as success
 * with an empty array and NO error — which is exactly why assertClaimed has
 * to inspect the rows rather than trust `error`.
 */
function updateLostRace(table: string) {
  return (row: unknown) => {
    updateCalls.push({ table, row });
    const builder = {
      eq: () => builder,
      select: () => Promise.resolve({ data: [], error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
    };
    return builder;
  };
}

/** insert/upsert — thenable, records the call, always succeeds. */
function insertOk(table: string) {
  return (row: unknown) => {
    insertCalls.push({ table, row });
    return { then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve) };
  };
}

let fromImpl: (table: string) => unknown;
const mockCreateClient = vi.fn(async () => ({ from: (table: string) => fromImpl(table) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mockCreateClient }));

const actor = { userId: "actor-1", role: "placement_cell", collegeId: "college-1" };

/**
 * Every workflow action validates its own record id with z.string().guid()
 * before doing anything else, so a fixture id has to be a real UUID — a bare
 * label like `app-1` dies in Zod and the guard under test never runs. These
 * stay readable/traceable by encoding the label's number in the last group.
 */
function fixtureId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

const APP_1 = fixtureId(1);
const APP_2 = fixtureId(2);
const APP_3 = fixtureId(3);
const FLAG_1 = fixtureId(11);
const FLAG_2 = fixtureId(12);
const FLAG_3 = fixtureId(13);
const FLAG_4 = fixtureId(14);

beforeEach(() => {
  insertCalls.length = 0;
  updateCalls.length = 0;
  mockRequireRole.mockResolvedValue(actor);
});

describe("updateApplicationStatus — placement-application transition graph", () => {
  it("allows a valid forward transition (applied -> shortlisted)", async () => {
    const { updateApplicationStatus } = await import("@/app/(portal)/placement-cell/drives/actions");
    fromImpl = (table: string) => {
      if (table === "placement_applications") {
        return {
          select: () =>
            selectSingle({
              data: {
                id: APP_1,
                college_id: "college-1",
                student_id: "student-1",
                drive_id: "drive-1",
                status: "applied",
                placement_drives: { job_role: "SDE", package_lpa: 10, company_id: "c1", companies: { name: "Acme" } },
              },
            }),
          update: updateOk("placement_applications"),
        };
      }
      if (table === "student_placement_profiles") return { upsert: insertOk("student_placement_profiles") };
      if (table === "placements") return { insert: insertOk("placements") };
      if (table === "audit_logs") return { insert: insertOk("audit_logs") };
      throw new Error(`unexpected table: ${table}`);
    };

    await expect(updateApplicationStatus(APP_1, "shortlisted")).resolves.toBeUndefined();
    expect(updateCalls).toHaveLength(1);
  });

  it("rejects an invalid jump (rejected -> selected) and performs no placements insert", async () => {
    const { updateApplicationStatus } = await import("@/app/(portal)/placement-cell/drives/actions");
    fromImpl = (table: string) => {
      if (table === "placement_applications") {
        return {
          select: () =>
            selectSingle({
              data: {
                id: APP_2,
                college_id: "college-1",
                student_id: "student-1",
                drive_id: "drive-1",
                status: "rejected",
                placement_drives: { job_role: "SDE", package_lpa: 10, company_id: "c1", companies: { name: "Acme" } },
              },
            }),
          update: updateOk("placement_applications"),
        };
      }
      if (table === "student_placement_profiles") return { upsert: insertOk("student_placement_profiles") };
      if (table === "placements") return { insert: insertOk("placements") };
      if (table === "audit_logs") return { insert: insertOk("audit_logs") };
      throw new Error(`unexpected table: ${table}`);
    };

    await expect(updateApplicationStatus(APP_2, "selected")).rejects.toThrow(
      /Cannot move this application from "rejected" to "selected"/
    );
    expect(insertCalls.find((c) => c.table === "placements")).toBeUndefined();
    expect(updateCalls).toHaveLength(0);
  });

  it("rejects re-applying the same status", async () => {
    const { updateApplicationStatus } = await import("@/app/(portal)/placement-cell/drives/actions");
    fromImpl = (table: string) => {
      if (table === "placement_applications") {
        return {
          select: () =>
            selectSingle({
              data: {
                id: APP_3,
                college_id: "college-1",
                student_id: "student-1",
                drive_id: "drive-1",
                status: "shortlisted",
                placement_drives: { job_role: "SDE", package_lpa: 10, company_id: "c1", companies: { name: "Acme" } },
              },
            }),
          update: updateOk("placement_applications"),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    };

    await expect(updateApplicationStatus(APP_3, "shortlisted")).rejects.toThrow(/already marked shortlisted/);
    expect(updateCalls).toHaveLength(0);
  });
});

describe("reviewRiskFlag — only a resolved escalation can be reviewed", () => {
  it("rejects 'accept' on a flag that is not resolved", async () => {
    const { reviewRiskFlag } = await import("@/app/(portal)/director/attention/actions");
    fromImpl = (table: string) => {
      if (table === "risk_flags") {
        return {
          select: () => selectSingle({ data: { status: "in_progress", assigned_to: "actor-1", title: "Flag" } }),
          update: updateOk("risk_flags"),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    };

    await expect(reviewRiskFlag({ flagId: FLAG_1, outcome: "accept" })).rejects.toThrow(
      /Only a resolved escalation can be reviewed/
    );
    expect(updateCalls).toHaveLength(0);
  });

  it("rejects 'reopen' on a flag that was never resolved", async () => {
    const { reviewRiskFlag } = await import("@/app/(portal)/director/attention/actions");
    fromImpl = (table: string) => {
      if (table === "risk_flags") {
        return {
          select: () => selectSingle({ data: { status: "open", assigned_to: null, title: "Flag" } }),
          update: updateOk("risk_flags"),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    };

    await expect(reviewRiskFlag({ flagId: FLAG_2, outcome: "reopen" })).rejects.toThrow(
      /Only a resolved escalation can be reviewed/
    );
    expect(updateCalls).toHaveLength(0);
  });

  it("allows 'accept' on a resolved flag", async () => {
    const { reviewRiskFlag } = await import("@/app/(portal)/director/attention/actions");
    fromImpl = (table: string) => {
      if (table === "risk_flags") {
        return {
          select: () => selectSingle({ data: { status: "resolved", assigned_to: "assignee-1", title: "Flag" } }),
          update: updateOk("risk_flags"),
        };
      }
      if (table === "notifications") return { insert: insertOk("notifications") };
      if (table === "audit_logs") return { insert: insertOk("audit_logs") };
      throw new Error(`unexpected table: ${table}`);
    };

    await expect(reviewRiskFlag({ flagId: FLAG_3, outcome: "accept" })).resolves.toBeUndefined();
    expect(updateCalls).toHaveLength(1);
  });

  it("allows 'reopen' on a resolved flag", async () => {
    const { reviewRiskFlag } = await import("@/app/(portal)/director/attention/actions");
    fromImpl = (table: string) => {
      if (table === "risk_flags") {
        return {
          select: () => selectSingle({ data: { status: "resolved", assigned_to: "assignee-1", title: "Flag" } }),
          update: updateOk("risk_flags"),
        };
      }
      if (table === "notifications") return { insert: insertOk("notifications") };
      if (table === "audit_logs") return { insert: insertOk("audit_logs") };
      throw new Error(`unexpected table: ${table}`);
    };

    await expect(reviewRiskFlag({ flagId: FLAG_4, outcome: "reopen" })).resolves.toBeUndefined();
    expect(updateCalls).toHaveLength(1);
    expect((updateCalls[0].row as { status?: string }).status).toBe("in_progress");
  });
});

/**
 * The losing side of every compare-and-swap added in the concurrency pass.
 *
 * These are the regression tests that matter most, because the failure they
 * guard against is invisible without them: when the status predicate matches
 * no row, Supabase returns success with an empty array and no error. Before
 * assertClaimed, that path ran straight on into the audit log, the
 * notification, and (for placements) a duplicate ledger insert — all on
 * behalf of a decision someone else had already made.
 */
describe("concurrent claim — the second actor must lose, loudly", () => {
  it("updateApplicationStatus: a racing caller is rejected and writes no placements row", async () => {
    const { updateApplicationStatus } = await import("@/app/(portal)/placement-cell/drives/actions");
    fromImpl = (table: string) => {
      if (table === "placement_applications") {
        return {
          select: () =>
            selectSingle({
              data: {
                id: APP_1,
                college_id: "college-1",
                student_id: "student-1",
                drive_id: "drive-1",
                // Still 'interview' when we read it — the other actor's
                // "selected" write lands between this read and our write.
                status: "interview",
                placement_drives: { job_role: "SDE", package_lpa: 10, company_id: "c1", companies: { name: "Acme" } },
              },
            }),
          update: updateLostRace("placement_applications"),
        };
      }
      if (table === "student_placement_profiles") return { upsert: insertOk("student_placement_profiles") };
      if (table === "placements") return { insert: insertOk("placements") };
      if (table === "audit_logs") return { insert: insertOk("audit_logs") };
      throw new Error(`unexpected table: ${table}`);
    };

    await expect(updateApplicationStatus(APP_1, "selected")).rejects.toThrow(/already actioned by someone else/);
    // The transition graph would have allowed interview -> selected; only the
    // compare-and-swap stops the duplicate offer.
    expect(insertCalls.find((c) => c.table === "placements")).toBeUndefined();
    expect(insertCalls.find((c) => c.table === "audit_logs")).toBeUndefined();
  });

  it("reviewRiskFlag: a racing director is rejected and sends no notification", async () => {
    const { reviewRiskFlag } = await import("@/app/(portal)/director/attention/actions");
    fromImpl = (table: string) => {
      if (table === "risk_flags") {
        return {
          select: () => selectSingle({ data: { status: "resolved", assigned_to: "assignee-1", title: "Flag" } }),
          update: updateLostRace("risk_flags"),
        };
      }
      if (table === "notifications") return { insert: insertOk("notifications") };
      if (table === "audit_logs") return { insert: insertOk("audit_logs") };
      throw new Error(`unexpected table: ${table}`);
    };

    await expect(reviewRiskFlag({ flagId: FLAG_3, outcome: "reopen" })).rejects.toThrow(
      /already actioned by someone else/
    );
    expect(insertCalls.find((c) => c.table === "notifications")).toBeUndefined();
  });

  it("the winning caller still proceeds normally", async () => {
    const { reviewRiskFlag } = await import("@/app/(portal)/director/attention/actions");
    fromImpl = (table: string) => {
      if (table === "risk_flags") {
        return {
          select: () => selectSingle({ data: { status: "resolved", assigned_to: "assignee-1", title: "Flag" } }),
          update: updateOk("risk_flags"),
        };
      }
      if (table === "notifications") return { insert: insertOk("notifications") };
      if (table === "audit_logs") return { insert: insertOk("audit_logs") };
      throw new Error(`unexpected table: ${table}`);
    };

    await expect(reviewRiskFlag({ flagId: FLAG_3, outcome: "reopen" })).resolves.toBeUndefined();
    expect(insertCalls.find((c) => c.table === "notifications")).toBeDefined();
  });
});

/**
 * Separation of duties — the requester may not be the approver.
 *
 * Before lib/segregation-of-duties.ts the only such guard in the whole
 * application was admin/users' "you can't suspend your own account". The
 * leave case below is the one that was concretely reachable: a HOD carries
 * their own department_id (set by lib/invitations.ts), so their own request
 * passes the department-ownership check and shows up in their own queue.
 */
describe("segregation of duties", () => {
  const hodActor = { userId: "hod-1", role: "hod", collegeId: "college-1" };

  it("a HOD cannot approve their own leave request", async () => {
    mockRequireRole.mockResolvedValue(hodActor);
    const { actOnLeaveRequestCore } = await import("@/app/(portal)/hod/approvals/actions");
    fromImpl = (table: string) => {
      if (table === "leave_requests") {
        return {
          select: () =>
            selectSingle({
              data: {
                // The HOD is the requester — and would otherwise pass every
                // other check, because it is their own department.
                requested_by: hodActor.userId,
                start_date: "2026-01-01",
                end_date: "2026-01-02",
                status: "pending",
                profiles: { department_id: "dept-1" },
              },
            }),
          update: updateOk("leave_requests"),
        };
      }
      if (table === "departments") return { select: () => selectSingle({ data: { id: "dept-1" } }) };
      if (table === "audit_logs") return { insert: insertOk("audit_logs") };
      throw new Error(`unexpected table: ${table}`);
    };

    const supabase = { from: (t: string) => fromImpl(t) } as never;
    await expect(
      actOnLeaveRequestCore(supabase, hodActor as never, FLAG_1, "approved")
    ).rejects.toThrow(/can't act on your own leave request/);
    expect(updateCalls).toHaveLength(0);
  });

  it("a HOD can still approve someone else's leave request", async () => {
    mockRequireRole.mockResolvedValue(hodActor);
    const { actOnLeaveRequestCore } = await import("@/app/(portal)/hod/approvals/actions");
    fromImpl = (table: string) => {
      if (table === "leave_requests") {
        return {
          select: () =>
            selectSingle({
              data: {
                requested_by: "teacher-9",
                start_date: "2026-01-01",
                end_date: "2026-01-02",
                status: "pending",
                profiles: { department_id: "dept-1" },
              },
            }),
          update: updateOk("leave_requests"),
        };
      }
      if (table === "departments") return { select: () => selectSingle({ data: { id: "dept-1" } }) };
      // The leave -> substitution path resolves the teacher's classes through
      // course_offerings now: timetable_slots carries no instructor_id after
      // 047. No offerings here means no cover is needed, which is what this
      // test wants — it is about separation of duties on the approval, not
      // about substitution.
      if (table === "course_offerings") return { select: () => ({ eq: () => Promise.resolve({ data: [] }) }) };
      if (table === "timetable_slots") return { select: () => ({ eq: () => Promise.resolve({ data: [] }), in: () => Promise.resolve({ data: [] }) }) };
      if (table === "audit_logs") return { insert: insertOk("audit_logs") };
      throw new Error(`unexpected table: ${table}`);
    };

    const supabase = { from: (t: string) => fromImpl(t) } as never;
    await expect(
      actOnLeaveRequestCore(supabase, hodActor as never, FLAG_1, "approved")
    ).resolves.toBeUndefined();
    expect(updateCalls).toHaveLength(1);
  });
});

/**
 * Director -> Placement Cell lifecycle.
 *
 * These three writes were silently doing nothing in production. `profiles`
 * has only two UPDATE policies — profiles_update_self (own row) and
 * profiles_admin_manage (admin only) — so a director's own client matched
 * zero rows and Supabase returned success with no error. Verified against
 * the live database by measuring affected rows rather than trusting `error`.
 *
 * The fix routes the write through the service-role client (authorization is
 * still the requireRole + college + promotable-role checks in app code) and
 * asserts row effect, so a future policy change surfaces as a loud failure
 * instead of a button that does nothing.
 */
describe("placement-cell lifecycle — writes must actually affect a row", () => {
  const directorActor = { userId: "director-1", role: "director", collegeId: "college-1" };
  const TARGET = fixtureId(42);

  function candidateLookup() {
    return {
      select: () => selectSingle({ data: { id: TARGET, role: "teacher", college_id: "college-1" } }),
    };
  }

  it("promote uses the service-role client and succeeds when a row is affected", async () => {
    const adminUpdates: unknown[] = [];
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: () => ({
        from: () => {
          const chain: Record<string, unknown> = {
            update: (row: unknown) => { adminUpdates.push(row); return chain; },
            eq: () => chain,
            select: () => Promise.resolve({ data: [{ id: TARGET }], error: null }),
          };
          return chain;
        },
      }),
    }));
    vi.resetModules();

    const { promoteToPlacementCellCore } = await import("@/app/(portal)/director/placement-cell/actions");
    fromImpl = (table: string) => {
      if (table === "profiles") return candidateLookup();
      if (table === "audit_logs") return { insert: insertOk("audit_logs") };
      throw new Error(`unexpected table: ${table}`);
    };
    const supabase = { from: (t: string) => fromImpl(t) } as never;

    await expect(
      promoteToPlacementCellCore(supabase, directorActor as never, TARGET)
    ).resolves.toBeUndefined();
    expect(adminUpdates).toEqual([{ role: "placement_cell", status: "active" }]);
    vi.doUnmock("@/lib/supabase/admin");
    vi.resetModules();
  });

  it("promote fails loudly when the write affects zero rows", async () => {
    vi.doMock("@/lib/supabase/admin", () => ({
      createAdminClient: () => ({
        from: () => {
          const chain: Record<string, unknown> = {
            update: () => chain,
            eq: () => chain,
            // The exact shape that made this bug invisible: success, no
            // error, nothing changed.
            select: () => Promise.resolve({ data: [], error: null }),
          };
          return chain;
        },
      }),
    }));
    vi.resetModules();

    const { promoteToPlacementCellCore } = await import("@/app/(portal)/director/placement-cell/actions");
    fromImpl = (table: string) => {
      if (table === "profiles") return candidateLookup();
      if (table === "audit_logs") return { insert: insertOk("audit_logs") };
      throw new Error(`unexpected table: ${table}`);
    };
    const supabase = { from: (t: string) => fromImpl(t) } as never;

    await expect(
      promoteToPlacementCellCore(supabase, directorActor as never, TARGET)
    ).rejects.toThrow(/already actioned by someone else|staff member/);
    vi.doUnmock("@/lib/supabase/admin");
    vi.resetModules();
  });
});
