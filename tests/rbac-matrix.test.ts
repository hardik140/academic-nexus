import { describe, it, expect, vi, beforeEach } from "vitest";
import { RBAC_MATRIX, ACTION_ALLOWED_ROLES } from "./rbac-matrix";
import type { UserRole } from "@/types/database";

/**
 * Role × action → allow/deny, asserted against the REAL Server Actions.
 *
 * The previous version of this file called `requireRole(ACTION_ALLOWED_ROLES[action])`
 * directly with a mocked profile. That only ever proved `requireRole` filters
 * a list it was handed — it never imported a single Server Action, so if
 * `actOnLeaveRequest` were widened to `["hod", "admin", "teacher"]` tomorrow,
 * every case here would still pass. The matrix documented the policy without
 * enforcing it.
 *
 * Now each matrix entry is bound to the actual exported action via
 * ACTION_INVOKERS below, and the test drives that action end-to-end with only
 * the role varying:
 *
 *   - expected "deny"  → must reject with RbacError code FORBIDDEN.
 *   - expected "allow" → must NOT reject with FORBIDDEN. Anything else
 *     (validation error, "not found" against the empty mock DB) counts as a
 *     pass: it proves the call got past the authorization gate, which is the
 *     only thing this matrix is responsible for.
 *
 * `requireRole` itself is deliberately NOT mocked here — it is the subject.
 * Only the I/O underneath it is.
 *
 * Per .agent/.rules/rules.md §3, a PR that changes a role or permission must
 * update the matrix, the RLS policy, and the backend check together. This file
 * is what makes the third of those non-optional.
 */

const UUID_ACTOR = "10000000-0000-4000-8000-000000000001";
const UUID_TARGET = "10000000-0000-4000-8000-000000000002";
const UUID_RECORD = "10000000-0000-4000-8000-000000000003";

let currentProfile: { role: UserRole; college_id: string; status: string } | null = null;

/**
 * A permissive query builder: every filter/modifier returns itself, so any
 * chain the action under test happens to build resolves. `profiles` returns
 * the role being tested (this is what `requireRole` reads); every other table
 * returns nothing, so actions fail fast with "not found" *after* the gate.
 */
function makeBuilder(table: string) {
  const single = table === "profiles" ? { data: currentProfile, error: null } : { data: null, error: null };
  const list = { data: [], error: null, count: 0 };

  const builder: Record<string, unknown> = {};
  for (const passthrough of [
    "select", "insert", "update", "upsert", "delete",
    "eq", "neq", "in", "is", "not", "or", "gt", "gte", "lt", "lte",
    "ilike", "like", "contains", "order", "limit", "range",
  ]) {
    builder[passthrough] = () => builder;
  }
  builder.single = () => Promise.resolve(single);
  builder.maybeSingle = () => Promise.resolve(single);
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(list).then(resolve);
  return builder;
}

const supabaseStub = {
  auth: { getUser: () => Promise.resolve({ data: { user: { id: UUID_ACTOR } }, error: null }) },
  from: (table: string) => makeBuilder(table),
  rpc: () => Promise.resolve({ data: null, error: null }),
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabaseStub }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    ...supabaseStub,
    auth: {
      ...supabaseStub.auth,
      admin: {
        generateLink: () =>
          Promise.resolve({
            data: { user: { id: UUID_TARGET }, properties: { action_link: "https://example.test/invite" } },
            error: null,
          }),
        deleteUser: () => Promise.resolve({ error: null }),
      },
    },
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/email", () => ({ sendInvitationEmail: () => Promise.resolve() }));

/**
 * Binds each matrix action name to the real exported Server Action.
 *
 * Arguments only need to be shaped well enough to reach (and get past) the
 * `requireRole` call at the top of each action — every one of these is the
 * first statement in its function body, before any validation. A Zod failure
 * afterwards is a pass for the allow case.
 */
const ACTION_INVOKERS: Record<string, () => Promise<unknown>> = {
  updateUserProfile: async () =>
    (await import("@/app/(portal)/admin/users/actions")).updateUserProfile(UUID_TARGET, "Test User", "student"),
  updateUserStatus: async () =>
    (await import("@/app/(portal)/admin/users/actions")).updateUserStatus(UUID_TARGET, "active"),
  actOnLeaveRequest: async () =>
    (await import("@/app/(portal)/hod/approvals/actions")).actOnLeaveRequest(UUID_RECORD, "approved"),
  actOnGatePass: async () =>
    (await import("@/app/(portal)/warden/gatepasses/actions")).actOnGatePass(UUID_RECORD, "approved"),
  markAttendance: async () =>
    (await import("@/app/(portal)/teacher/attendance/actions")).saveAttendance({
      courseId: UUID_RECORD,
      date: "2026-01-01",
      entries: [],
    } as never),
  saveMarks: async () =>
    (await import("@/app/(portal)/teacher/grading/actions")).saveMarks({
      courseId: UUID_RECORD,
      examType: "internal_1",
      maxMarks: 100,
      entries: [],
    } as never),

  createCollege: async () =>
    (await import("@/app/(portal)/super-admin/colleges/actions")).createCollege({
      name: "Test College",
      code: "TEST",
    } as never),
  inviteUserAsSuperAdmin: async () =>
    (await import("@/app/(portal)/super-admin/colleges/actions")).inviteUser({
      email: "a@example.test",
      fullName: "A",
      role: "admin",
      collegeId: UUID_RECORD,
    } as never),
  inviteUserAsAdmin: async () =>
    (await import("@/app/(portal)/admin/users/actions")).inviteUser({
      email: "a@example.test",
      fullName: "A",
      role: "director",
    } as never),
  inviteUserAsDirector: async () =>
    (await import("@/app/(portal)/director/team/actions")).inviteUser({
      email: "a@example.test",
      fullName: "A",
      role: "hod",
    } as never),
  inviteUserAsHod: async () =>
    (await import("@/app/(portal)/hod/team/actions")).inviteUser({
      email: "a@example.test",
      fullName: "A",
      role: "teacher",
    } as never),

  assignPlacementCell: async () =>
    (await import("@/app/(portal)/director/placement-cell/actions")).assignPlacementCell({
      email: "a@example.test",
      fullName: "A",
    } as never),
  revokePlacementCell: async () =>
    (await import("@/app/(portal)/director/placement-cell/actions")).revokePlacementCell(UUID_TARGET),
  managePlacementCompanies: async () =>
    (await import("@/app/(portal)/placement-cell/companies/actions")).createCompany({ name: "Acme" } as never),
  managePlacementDrives: async () =>
    (await import("@/app/(portal)/placement-cell/drives/actions")).createDrive({
      companyId: UUID_RECORD,
      jobRole: "SDE",
      applicationDeadline: "2030-01-01T00:00:00.000Z",
    } as never),
  updatePlacementApplicationStatus: async () =>
    (await import("@/app/(portal)/placement-cell/drives/actions")).updateApplicationStatus(UUID_RECORD, "shortlisted"),
  updateStudentPlacementStatus: async () =>
    (await import("@/app/(portal)/placement-cell/records/actions")).updateStudentPlacementStatus(UUID_TARGET, "eligible"),
  sendPlacementNotification: async () =>
    (await import("@/app/(portal)/placement-cell/notifications/actions")).sendPlacementNotification({
      title: "T",
      message: "M",
      audience: "all",
    } as never),
  readPlacementCellData: async () =>
    (await import("@/app/(portal)/placement-cell/reports/actions")).getPlacementReports(),
  applyToPlacementDrive: async () =>
    (await import("@/app/(portal)/student/placements/actions")).applyToDrive(UUID_RECORD),
  createSemester: async () =>
    (await import("@/app/(portal)/admin/academic-periods/actions")).createSemester({
      academicYearId: UUID_RECORD,
      name: "Odd",
      sequenceNo: 1,
      startDate: "2027-06-01",
      endDate: "2027-11-30",
    }),
  transitionSemester: async () =>
    (await import("@/app/(portal)/admin/academic-periods/actions")).transitionSemester(UUID_RECORD, "activate"),

  // Gate Security (050). The deny rows these generate are the separation
  // the module rests on: gate_security is denied every administrative
  // action, and warden/director are denied the scanner.
  authorizeSecurityPersonnel: async () =>
    (await import("@/app/(portal)/director/security/actions")).authorizeSecurityPersonnel({ profileId: UUID_TARGET }),
  assignSecurityGate: async () =>
    (await import("@/app/(portal)/director/security/actions")).assignGate(UUID_TARGET, UUID_RECORD),
  manageGates: async () =>
    (await import("@/app/(portal)/director/security/actions")).createGate({ code: "MAIN", name: "Main Gate" }),
  sendSecurityInstruction: async () =>
    (await import("@/app/(portal)/director/security/actions")).sendSecurityInstruction({
      title: "T",
      message: "M",
      priority: "normal",
      audience: "all",
    }),
  recordGateMovement: async () =>
    (await import("@/app/(portal)/security/actions")).scanGatePass({
      payload: "ANGP1.11111111-1111-4111-8111-111111111111." + "A".repeat(43),
      gateId: UUID_RECORD,
    }),
  overrideGateMovement: async () =>
    (await import("@/app/(portal)/warden/gatepasses/actions")).recordManualGateMovement({
      passId: UUID_RECORD,
      action: "exit",
      reason: "a reason long enough to pass validation",
    }),
  revokeGateCredential: async () =>
    (await import("@/app/(portal)/warden/gatepasses/actions")).revokeGatePassCredential(UUID_RECORD, "lost phone"),
};

function isForbidden(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "FORBIDDEN";
}

beforeEach(() => {
  currentProfile = null;
});

describe("RBAC policy matrix", () => {
  it("every matrix action is bound to a real Server Action", () => {
    // Guards the failure mode this rewrite exists to prevent: adding a row to
    // ACTION_ALLOWED_ROLES without wiring it to the action it describes would
    // otherwise leave that policy asserted by nothing at all.
    const unbound = Object.keys(ACTION_ALLOWED_ROLES).filter((a) => !ACTION_INVOKERS[a]);
    expect(unbound).toEqual([]);
  });

  it.each(RBAC_MATRIX)("role=$role action=$action → $expected", async ({ role, action, expected }) => {
    currentProfile = { role, college_id: "college-1", status: "active" };

    let thrown: unknown;
    try {
      await ACTION_INVOKERS[action]();
    } catch (err) {
      thrown = err;
    }

    if (expected === "deny") {
      expect(isForbidden(thrown), `${role} should be denied ${action}, but was not rejected as FORBIDDEN`).toBe(true);
    } else {
      expect(isForbidden(thrown), `${role} should be allowed ${action}, but was rejected as FORBIDDEN`).toBe(false);
    }
  });

  it("an inactive account is rejected even for an otherwise-allowed role", async () => {
    currentProfile = { role: "hod", college_id: "college-1", status: "suspended" };
    await expect(ACTION_INVOKERS.actOnLeaveRequest()).rejects.toMatchObject({ code: "INACTIVE" });
  });
});
