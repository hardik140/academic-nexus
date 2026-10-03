import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * lib/student-invitations.ts — the ORDER that keeps a student invitation
 * from ever leaving a half-created account behind (migration 055, defect 1):
 *
 *   preflight (read-only) -> create account + invitation -> placement -> email
 *
 * and, if the placement is refused, the created account is discarded and no
 * email is sent. The database rules themselves (who may place a student in
 * which section) are proven in tests/staging-academic-foundation.
 */

const h = vi.hoisted(() => ({
  calls: [] as string[],
  rpc: vi.fn(),
  create: vi.fn(),
  deliver: vi.fn(),
  discard: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => {} }));
vi.mock("@/lib/academic/rpc", () => ({ academicRpc: h.rpc }));
vi.mock("@/lib/invitations", () => ({
  createInvitationCore: h.create,
  deliverInvitation: h.deliver,
  discardInvitation: h.discard,
}));

import { inviteStudentCore } from "@/lib/student-invitations";

const actor = { userId: "00000000-0000-4000-8000-0000000000aa", role: "teacher" as const, collegeId: "00000000-0000-4000-8000-0000000000cc" };
const SECTION = "00000000-0000-4000-8000-0000000000a1";
const RESOLVED_DEPT = "00000000-0000-4000-8000-0000000000d1";
const created = { userId: "u1", invitationId: "00000000-0000-4000-8000-0000000000e1", email: "a@x.edu", fullName: "A", role: "student", collegeId: actor.collegeId, hashedToken: "t" };
const params = { email: "a@x.edu", fullName: "Asha", sectionId: SECTION, enrollmentNumber: "2024CSE101", programmeSemester: 5 };
const supabase = {} as never;

beforeEach(() => {
  h.calls.length = 0;
  h.rpc.mockReset().mockImplementation(async (_s: unknown, fn: string) => {
    h.calls.push(fn);
    if (fn === "student_invitation_preflight") return { department_id: RESOLVED_DEPT, section_label: "BTECH-CSE A (2024)" };
    return {};
  });
  h.create.mockReset().mockImplementation(async () => { h.calls.push("create"); return created; });
  h.deliver.mockReset().mockImplementation(async () => { h.calls.push("deliver"); });
  h.discard.mockReset().mockImplementation(async () => { h.calls.push("discard"); });
});

describe("inviteStudentCore", () => {
  it("preflights, creates with the RESOLVED department, places, and only then emails", async () => {
    const r = await inviteStudentCore(supabase, actor, params);
    expect(h.calls).toEqual(["student_invitation_preflight", "create", "create_student_invitation_placement", "deliver"]);
    expect(h.create.mock.calls[0][2]).toMatchObject({ role: "student", departmentId: RESOLVED_DEPT });
    expect(h.rpc.mock.calls[1][2]).toMatchObject({ p_invitation_id: created.invitationId, p_section_id: SECTION, p_programme_semester: 5 });
    expect(r.sectionLabel).toBe("BTECH-CSE A (2024)");
  });

  it("a refused placement discards the account and sends no email", async () => {
    h.rpc.mockImplementation(async (_s: unknown, fn: string) => {
      h.calls.push(fn);
      if (fn === "student_invitation_preflight") return { department_id: RESOLVED_DEPT, section_label: "x" };
      throw new Error("You can invite students only into your own section (Class In-Charge).");
    });
    await expect(inviteStudentCore(supabase, actor, params)).rejects.toThrow(/your own section/);
    expect(h.calls).toEqual(["student_invitation_preflight", "create", "create_student_invitation_placement", "discard"]);
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("a refused preflight creates nothing at all", async () => {
    h.rpc.mockImplementation(async (_s: unknown, fn: string) => {
      h.calls.push(fn);
      throw new Error("That enrollment number is already in use.");
    });
    await expect(inviteStudentCore(supabase, actor, params)).rejects.toThrow(/already in use/);
    expect(h.calls).toEqual(["student_invitation_preflight"]);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("the client cannot send a department, and must send a section", async () => {
    await expect(inviteStudentCore(supabase, actor, { ...params, sectionId: "not-a-uuid" })).rejects.toThrow();
    const withDept = { ...params, departmentId: "00000000-0000-4000-8000-0000000000ff" } as typeof params;
    await inviteStudentCore(supabase, actor, withDept);
    expect(h.create.mock.calls[0][2].departmentId).toBe(RESOLVED_DEPT);
  });
});
