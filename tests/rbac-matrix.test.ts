import { describe, it, expect, vi, beforeEach } from "vitest";
import { requireRole } from "@/lib/rbac";
import { RBAC_MATRIX, ACTION_ALLOWED_ROLES } from "./rbac-matrix";

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

describe("RBAC policy matrix", () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    mockSingle.mockReset();
  });

  it.each(RBAC_MATRIX)(
    "role=$role action=$action → $expected",
    async ({ role, action, expected }) => {
      mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
      mockSingle.mockResolvedValue({
        data: { role, college_id: "college-1", status: "active" },
      });

      const allowedRoles = ACTION_ALLOWED_ROLES[action];

      if (expected === "allow") {
        await expect(requireRole(allowedRoles)).resolves.toMatchObject({ role });
      } else {
        await expect(requireRole(allowedRoles)).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
    }
  );
});
