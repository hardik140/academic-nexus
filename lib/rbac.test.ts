import { describe, it, expect, vi, beforeEach } from "vitest";
import { requireRole, RbacError } from "@/lib/rbac";

const mockGetUser = vi.fn();
const mockSingle = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
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
