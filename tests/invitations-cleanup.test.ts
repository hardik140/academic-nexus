import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Defect 1 (migration 055 contract): an invitation that fails part-way must
 * not leave a half-created pending account behind. createInvitationCore()
 * removes the auth account it created whenever a later step fails, and
 * discardInvitation() undoes a created-but-undelivered invitation.
 */

const h = vi.hoisted(() => ({
  deleteUser: vi.fn(),
  profileUpdateError: null as null | { message: string; code: string },
  inviteInsertError: null as null | { message: string; code: string },
  invitationStatusUpdate: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => {} }));
vi.mock("@/lib/audit", () => ({ logAudit: async () => {} }));
vi.mock("@/lib/email", () => ({ sendInvitationEmail: h.sendEmail }));
vi.mock("@/lib/app-url", () => ({ getPublicAppUrl: () => "https://app.example" }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        generateLink: async () => ({ data: { user: { id: "new-user" }, properties: { hashed_token: "tok" } }, error: null }),
        deleteUser: h.deleteUser,
      },
    },
    from: () => ({
      update: () => ({ eq: async () => ({ error: h.profileUpdateError }) }),
    }),
  }),
}));

import { createInvitationCore, discardInvitation } from "@/lib/invitations";

const actor = { userId: "00000000-0000-4000-8000-0000000000aa", role: "hod" as const, collegeId: "00000000-0000-4000-8000-0000000000cc" };
const supabase = {
  from: (table: string) => {
    if (table === "invitations") {
      return {
        insert: () => ({
          select: () => ({
            single: async () => (h.inviteInsertError ? { data: null, error: h.inviteInsertError } : { data: { id: "inv-1" }, error: null }),
          }),
        }),
        update: (v: unknown) => ({ eq: async () => { h.invitationStatusUpdate(v); return { error: null }; } }),
      };
    }
    return { select: () => ({ eq: () => ({ single: async () => ({ data: { name: "College" } }) }) }) };
  },
} as never;
const params = { email: "s@x.edu", fullName: "S", role: "student" as const, departmentId: "00000000-0000-4000-8000-0000000000d1" };

beforeEach(() => {
  h.deleteUser.mockReset().mockResolvedValue({ error: null });
  h.profileUpdateError = null;
  h.inviteInsertError = null;
  h.invitationStatusUpdate.mockReset();
  h.sendEmail.mockReset();
});

describe("createInvitationCore cleanup", () => {
  it("success returns the invitation id and sends no email (delivery is a separate step)", async () => {
    const r = await createInvitationCore(supabase, actor, params);
    expect(r).toMatchObject({ userId: "new-user", invitationId: "inv-1", hashedToken: "tok" });
    expect(h.deleteUser).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("the role cannot be applied: the created account is removed", async () => {
    h.profileUpdateError = { message: "boom", code: "XX000" };
    await expect(createInvitationCore(supabase, actor, params)).rejects.toThrow(/so it was removed/);
    expect(h.deleteUser).toHaveBeenCalledWith("new-user");
  });

  it("the invitation cannot be recorded: the created account is removed", async () => {
    h.inviteInsertError = { message: "permission denied for table invitations", code: "42501" };
    await expect(createInvitationCore(supabase, actor, params)).rejects.toThrow();
    expect(h.deleteUser).toHaveBeenCalledWith("new-user");
  });

  it("discardInvitation removes the account and marks the invitation revoked", async () => {
    await discardInvitation(supabase, { userId: "u9", invitationId: "inv-9", email: "", fullName: "", role: "student", collegeId: actor.collegeId, hashedToken: "" });
    expect(h.deleteUser).toHaveBeenCalledWith("u9");
    expect(h.invitationStatusUpdate).toHaveBeenCalledWith({ status: "revoked" });
  });
});
