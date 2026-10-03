import { describe, it, expect, vi, beforeEach } from "vitest";
import { requireRole, RbacError } from "@/lib/rbac";

const mockGetUser = vi.fn();
const mockSingle = vi.fn();
// register_current_session (migration 054). Default: the session is admitted.
const mockRpc = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
    from: () => ({
      select: () => ({
        eq: () => ({
          single: mockSingle,
        }),
      }),
    }),
  }),
}));

function mockUser(id = "user-1") {
  mockGetUser.mockResolvedValue({ data: { user: { id } } });
}

function mockProfile(overrides: Partial<{ role: string; college_id: string; status: string }> = {}) {
  mockSingle.mockResolvedValue({
    data: {
      role: "student",
      college_id: "college-1",
      status: "active",
      ...overrides,
    },
  });
}

describe("requireRole", () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    mockSingle.mockReset();
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ data: { state: "active" }, error: null });
  });

  it("throws UNAUTHENTICATED when there is no session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    await expect(requireRole(["admin"])).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    } satisfies Partial<RbacError>);
  });

  it("throws UNAUTHENTICATED when there is no profile row", async () => {
    mockUser();
    mockSingle.mockResolvedValue({ data: null });

    await expect(requireRole(["admin"])).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("throws INACTIVE when the account isn't active", async () => {
    mockUser();
    mockProfile({ status: "suspended", role: "admin" });

    await expect(requireRole(["admin"])).rejects.toMatchObject({
      code: "INACTIVE",
    });
  });

  it("throws FORBIDDEN when the role isn't allowed", async () => {
    mockUser();
    mockProfile({ role: "student" });

    await expect(requireRole(["admin", "hod"])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("resolves with the actor when the role is allowed", async () => {
    mockUser("user-42");
    mockProfile({ role: "admin", college_id: "college-9" });

    await expect(requireRole(["admin"])).resolves.toEqual({
      userId: "user-42",
      role: "admin",
      collegeId: "college-9",
    });
  });

  it("resolves super_admin against its own requireRole([\"super_admin\"]) check", async () => {
    mockUser("user-1");
    mockProfile({ role: "super_admin", college_id: "00000000-0000-0000-0000-000000000000" });

    await expect(requireRole(["super_admin"])).resolves.toMatchObject({ role: "super_admin" });
  });

  it("super_admin is NOT implicitly admin — requireRole([\"admin\"]) rejects it", async () => {
    mockUser("user-1");
    mockProfile({ role: "super_admin", college_id: "00000000-0000-0000-0000-000000000000" });

    await expect(requireRole(["admin"])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("requireRole — college lifecycle and session admission (migrations 053/054)", () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    mockSingle.mockReset();
    mockRpc.mockReset();
    mockUser();
    mockProfile({ role: "teacher" });
  });

  it.each([
    [{ state: "college_unavailable", college_state: "MAINTENANCE" }, "COLLEGE_UNAVAILABLE"],
    [{ state: "college_unavailable", college_state: "SUSPENDED" }, "COLLEGE_UNAVAILABLE"],
    [{ state: "rejected", active_sessions: 2, max_sessions: 2 }, "SESSION_LIMIT"],
    [{ state: "revoked", reason: "revoked_by_admin" }, "SESSION_REVOKED"],
    [{ state: "no_session_claim", enforcement: "enforce" }, "SESSION_REVOKED"],
    [{ state: "inactive" }, "INACTIVE"],
  ])("refuses %o with %s", async (admission, code) => {
    mockRpc.mockResolvedValue({ data: admission, error: null });
    await expect(requireRole(["teacher"])).rejects.toMatchObject({ code });
  });

  it("admits an active session, and a token with no session claim only while enforcement is 'register'", async () => {
    mockRpc.mockResolvedValue({ data: { state: "active" }, error: null });
    await expect(requireRole(["teacher"])).resolves.toMatchObject({ role: "teacher" });
    mockRpc.mockResolvedValue({ data: { state: "no_session_claim", enforcement: "register" }, error: null });
    await expect(requireRole(["teacher"])).resolves.toMatchObject({ role: "teacher" });
  });

  it("fails CLOSED when the check cannot run", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "08006", message: "connection failure" } });
    await expect(requireRole(["teacher"])).rejects.toMatchObject({ code: "ACCESS_CHECK_FAILED" });
    mockRpc.mockRejectedValue(new Error("network down"));
    await expect(requireRole(["teacher"])).rejects.toMatchObject({ code: "ACCESS_CHECK_FAILED" });
  });

  it("proceeds when the database predates migration 054 (the function does not exist)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    await expect(requireRole(["teacher"])).resolves.toMatchObject({ role: "teacher" });
  });

  it("checks admission only after the role check: a forbidden role never reaches it", async () => {
    await expect(requireRole(["admin"])).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
