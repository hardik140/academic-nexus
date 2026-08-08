import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetUser = vi.fn();
const mockSingle = vi.fn();
const mockInsert = vi.fn();
const mockUpsert = vi.fn();
const mockUpdate = vi.fn();
// inviteUserCore (lib/invitations.ts) and createCollegeCore's invite step
// call the real Supabase Auth Admin API — mocked here (unlike the plain
// service-role client in Phase 0's admin/create-user, which was scoped to
// 401/403-only coverage) because inviteUserCore is now shared across four
// role tiers and its canInvite() enforcement is exactly what's worth
// proving end-to-end through the HTTP boundary, not just in isolation.
const mockGenerateLink = vi.fn();
const mockDeleteUser = vi.fn();
// lib/email.ts's nodemailer transport isn't configured in tests (no real
// SMTP) — mocked so inviteUserCore's send step is a no-op here rather than
// throwing "SMTP is not configured." vi.hoisted() (rather than a plain
// const) because the naming-convention auto-hoist vitest normally does for
// "mock"-prefixed variables was, for reasons not fully clear, not reliably
// hoisting this one ahead of the vi.mock("@/lib/email", ...) factory below.
const mockSendInvitationEmail = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/mobile", () => ({
  createMobileClient: () => ({
    auth: { getUser: mockGetUser },
    from: () => ({
      select: () => ({
        eq: () => ({ single: mockSingle }),
      }),
      insert: mockInsert,
      upsert: mockUpsert,
      update: mockUpdate,
    }),
  }),
  bearerTokenFrom: (request: Request) => {
    const header = request.headers.get("authorization");
    return header?.startsWith("Bearer ") ? header.slice(7) : null;
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        generateLink: mockGenerateLink,
        deleteUser: mockDeleteUser,
      },
    },
  }),
}));

vi.mock("@/lib/email", () => ({
  sendInvitationEmail: mockSendInvitationEmail,
  sendPasswordResetEmail: vi.fn(),
}));

// requireRole()/createClient() aren't exercised by these mobile-only routes,
// but student/gatepass/actions.ts and student/complaints/actions.ts import
// them at module load — stub them out so the import doesn't need real cookies.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({}),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { POST as applyGatePass } from "@/app/api/mobile/gatepass/apply/route";
import { POST as submitComplaint } from "@/app/api/mobile/complaints/submit/route";
import { POST as registerPushToken } from "@/app/api/mobile/push-token/route";
import { POST as saveAttendance } from "@/app/api/mobile/attendance/save/route";
import { POST as saveGrades } from "@/app/api/mobile/grading/save/route";
import { POST as applyForLeave } from "@/app/api/mobile/leave/apply/route";
import { POST as actOnLeave } from "@/app/api/mobile/leave/act/route";
import { POST as actOnGatePass } from "@/app/api/mobile/gatepass/act/route";
import { POST as updateComplaintStatus } from "@/app/api/mobile/complaints/status/route";
import { POST as createInvoice } from "@/app/api/mobile/finance/invoice/route";
import { POST as recordPayment } from "@/app/api/mobile/finance/payment/route";
import { POST as createScholarship } from "@/app/api/mobile/finance/scholarship/route";
import { POST as sendAnnouncement } from "@/app/api/mobile/director/announcement/route";
import { POST as createPlacement } from "@/app/api/mobile/director/placement/route";
import { POST as updateUser } from "@/app/api/mobile/admin/update-user/route";
import { POST as updateUserStatus } from "@/app/api/mobile/admin/user-status/route";
import { POST as createDepartment } from "@/app/api/mobile/admin/create-department/route";
import { POST as assignHod } from "@/app/api/mobile/admin/assign-hod/route";
import { POST as assignWarden } from "@/app/api/mobile/admin/assign-warden/route";
import { POST as createCourse } from "@/app/api/mobile/admin/create-course/route";
import { POST as updateCollege } from "@/app/api/mobile/admin/update-college/route";
import { POST as adminInviteUser } from "@/app/api/mobile/admin/invite-user/route";
import { POST as adminResendInvitation } from "@/app/api/mobile/admin/invitations/resend/route";
import { POST as adminRevokeInvitation } from "@/app/api/mobile/admin/invitations/revoke/route";
import { POST as directorInviteUser } from "@/app/api/mobile/director/invite-user/route";
import { POST as directorResendInvitation } from "@/app/api/mobile/director/invitations/resend/route";
import { POST as directorRevokeInvitation } from "@/app/api/mobile/director/invitations/revoke/route";
import { POST as hodInviteUser } from "@/app/api/mobile/hod/invite-user/route";
import { POST as hodResendInvitation } from "@/app/api/mobile/hod/invitations/resend/route";
import { POST as hodRevokeInvitation } from "@/app/api/mobile/hod/invitations/revoke/route";
import { POST as superAdminCreateCollege } from "@/app/api/mobile/super-admin/create-college/route";
import { POST as superAdminInviteUser } from "@/app/api/mobile/super-admin/invite-user/route";

function makeRequest(body: unknown, token?: string) {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

// Zod's .uuid() rejects anything that doesn't look like a real UUID, so
// every fixture ID below is UUID-shaped rather than a placeholder like
// "student-1" — these are what changed when Phase 0 added request
// validation at every mutation boundary.
const UUID_COURSE = "10000000-0000-4000-8000-000000000001";
const UUID_STUDENT_ROW = "10000000-0000-4000-8000-000000000002";
const UUID_STUDENT = "10000000-0000-4000-8000-000000000003";
const UUID_FEE = "10000000-0000-4000-8000-000000000004";
const UUID_LEAVE_REQUEST = "10000000-0000-4000-8000-000000000005";
const UUID_GATEPASS = "10000000-0000-4000-8000-000000000006";
const UUID_COMPLAINT = "10000000-0000-4000-8000-000000000007";
const UUID_TARGET_USER = "10000000-0000-4000-8000-000000000008";
const UUID_DEPARTMENT = "10000000-0000-4000-8000-000000000009";
const UUID_BLOCK = "10000000-0000-4000-8000-00000000000a";
const UUID_SELF = "10000000-0000-4000-8000-00000000000b";
const UUID_INVITATION = "10000000-0000-4000-8000-00000000000c";
const UUID_NEW_COLLEGE = "10000000-0000-4000-8000-00000000000d";

describe("app/api/mobile/* — HTTP-boundary authorization matrix", () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    mockSingle.mockReset();
    mockInsert.mockReset();
    mockUpsert.mockReset();
    mockUpsert.mockResolvedValue({ error: null });
    mockUpdate.mockReset();
    mockUpdate.mockReturnValue({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) });
    mockGenerateLink.mockReset();
    mockGenerateLink.mockResolvedValue({
      data: { user: { id: "invited-user-1" }, properties: { action_link: "https://example.com/invite" } },
      error: null,
    });
    mockDeleteUser.mockReset();
    mockDeleteUser.mockResolvedValue({ error: null });
    mockSendInvitationEmail.mockReset();
    mockSendInvitationEmail.mockResolvedValue(undefined);
  });

  const GATEPASS_BODY = { destination: "Home", reason: "Weekend", exitTime: "2026-09-01T09:00:00Z", returnTime: "2026-09-02T18:00:00Z" };
  const COMPLAINT_BODY = { category: "plumbing", title: "Leaky tap", description: "desc", location: "Room 1", priority: "low" };
  const PUSH_BODY = { token: "ExponentPushToken[abc]", platform: "ios" };
  const ATTENDANCE_BODY = { courseId: UUID_COURSE, date: "2026-09-01", entries: [{ studentDbId: UUID_STUDENT_ROW, status: "present" }] };
  const GRADES_BODY = { courseId: UUID_COURSE, examType: "internal_1", maxMarks: 100, entries: [{ studentDbId: UUID_STUDENT_ROW, obtainedMarks: 80 }] };
  const LEAVE_BODY = { leaveType: "casual", startDate: "2026-09-01", endDate: "2026-09-02", reason: "Personal" };
  const LEAVE_ACT_BODY = { requestId: UUID_LEAVE_REQUEST, action: "approved" };
  const GATEPASS_ACT_BODY = { passId: UUID_GATEPASS, action: "approved" };
  const COMPLAINT_STATUS_BODY = { complaintId: UUID_COMPLAINT, status: "in_progress" };
  const INVOICE_BODY = { studentId: UUID_STUDENT, type: "Tuition", amount: 5000, dueDate: "2026-09-01" };
  const PAYMENT_BODY = { feeId: UUID_FEE, amount: 1000, method: "cash" };
  const SCHOLARSHIP_BODY = { studentId: UUID_STUDENT, name: "Merit Award", type: "merit", amount: 2000 };
  const ANNOUNCEMENT_BODY = { title: "Campus Update", message: "Hello everyone", audience: "all" };
  const PLACEMENT_BODY = { studentId: UUID_STUDENT, companyName: "Acme Corp", roleTitle: "SWE", packageLpa: 12, placementDate: "2026-09-01" };
  const UPDATE_USER_BODY = { targetUserId: UUID_TARGET_USER, fullName: "Updated Name", role: "student" };
  const USER_STATUS_BODY = { targetUserId: UUID_TARGET_USER, status: "suspended" };
  const CREATE_DEPT_BODY = { name: "Computer Science", code: "CSE", description: "" };
  const ASSIGN_HOD_BODY = { departmentId: UUID_DEPARTMENT, hodUserId: null };
  const ASSIGN_WARDEN_BODY = { blockId: UUID_BLOCK, wardenUserId: null };
  const CREATE_COURSE_BODY = { name: "Data Structures", code: "CS201", departmentId: UUID_DEPARTMENT, credits: 4, semester: 3, type: "core" };
  const UPDATE_COLLEGE_BODY = { name: "Example College", code: "EC" };
  const INVITE_DIRECTOR_BODY = { email: "director@college.edu", fullName: "New Director", role: "director" };
  const INVITE_FINANCE_BODY = { email: "finance@college.edu", fullName: "New Finance", role: "finance" };
  const INVITE_TEACHER_BODY = { email: "teacher@college.edu", fullName: "New Teacher", role: "teacher" };
  const INVITE_ADMIN_BY_SUPER_ADMIN_BODY = { email: "admin2@college.edu", fullName: "New Admin", role: "admin", collegeId: UUID_NEW_COLLEGE };
  const RESEND_INVITATION_BODY = { invitationId: UUID_INVITATION };
  const REVOKE_INVITATION_BODY = { invitationId: UUID_INVITATION };
  const CREATE_COLLEGE_BODY = { name: "New College", code: "NC" };

  it.each([
    ["gatepass/apply", () => applyGatePass(makeRequest(GATEPASS_BODY))],
    ["complaints/submit", () => submitComplaint(makeRequest(COMPLAINT_BODY))],
    ["push-token", () => registerPushToken(makeRequest(PUSH_BODY))],
    ["attendance/save", () => saveAttendance(makeRequest(ATTENDANCE_BODY))],
    ["grading/save", () => saveGrades(makeRequest(GRADES_BODY))],
    ["leave/apply", () => applyForLeave(makeRequest(LEAVE_BODY))],
    ["leave/act", () => actOnLeave(makeRequest(LEAVE_ACT_BODY))],
    ["gatepass/act", () => actOnGatePass(makeRequest(GATEPASS_ACT_BODY))],
    ["complaints/status", () => updateComplaintStatus(makeRequest(COMPLAINT_STATUS_BODY))],
    ["finance/invoice", () => createInvoice(makeRequest(INVOICE_BODY))],
    ["finance/payment", () => recordPayment(makeRequest(PAYMENT_BODY))],
    ["finance/scholarship", () => createScholarship(makeRequest(SCHOLARSHIP_BODY))],
    ["director/announcement", () => sendAnnouncement(makeRequest(ANNOUNCEMENT_BODY))],
    ["director/placement", () => createPlacement(makeRequest(PLACEMENT_BODY))],
    ["admin/update-user", () => updateUser(makeRequest(UPDATE_USER_BODY))],
    ["admin/user-status", () => updateUserStatus(makeRequest(USER_STATUS_BODY))],
    ["admin/create-department", () => createDepartment(makeRequest(CREATE_DEPT_BODY))],
    ["admin/assign-hod", () => assignHod(makeRequest(ASSIGN_HOD_BODY))],
    ["admin/assign-warden", () => assignWarden(makeRequest(ASSIGN_WARDEN_BODY))],
    ["admin/create-course", () => createCourse(makeRequest(CREATE_COURSE_BODY))],
    ["admin/update-college", () => updateCollege(makeRequest(UPDATE_COLLEGE_BODY))],
    ["admin/invite-user", () => adminInviteUser(makeRequest(INVITE_DIRECTOR_BODY))],
    ["admin/invitations/resend", () => adminResendInvitation(makeRequest(RESEND_INVITATION_BODY))],
    ["admin/invitations/revoke", () => adminRevokeInvitation(makeRequest(REVOKE_INVITATION_BODY))],
    ["director/invite-user", () => directorInviteUser(makeRequest(INVITE_FINANCE_BODY))],
    ["director/invitations/resend", () => directorResendInvitation(makeRequest(RESEND_INVITATION_BODY))],
    ["director/invitations/revoke", () => directorRevokeInvitation(makeRequest(REVOKE_INVITATION_BODY))],
    ["hod/invite-user", () => hodInviteUser(makeRequest(INVITE_TEACHER_BODY))],
    ["hod/invitations/resend", () => hodResendInvitation(makeRequest(RESEND_INVITATION_BODY))],
    ["hod/invitations/revoke", () => hodRevokeInvitation(makeRequest(REVOKE_INVITATION_BODY))],
    ["super-admin/create-college", () => superAdminCreateCollege(makeRequest(CREATE_COLLEGE_BODY))],
    ["super-admin/invite-user", () => superAdminInviteUser(makeRequest(INVITE_ADMIN_BY_SUPER_ADMIN_BODY))],
  ])("%s — no Authorization header → 401", async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(401);
  });

  it.each([
    ["gatepass/apply", () => applyGatePass(makeRequest(GATEPASS_BODY, "bad-token"))],
    ["complaints/submit", () => submitComplaint(makeRequest(COMPLAINT_BODY, "bad-token"))],
    ["push-token", () => registerPushToken(makeRequest(PUSH_BODY, "bad-token"))],
    ["attendance/save", () => saveAttendance(makeRequest(ATTENDANCE_BODY, "bad-token"))],
    ["grading/save", () => saveGrades(makeRequest(GRADES_BODY, "bad-token"))],
    ["leave/apply", () => applyForLeave(makeRequest(LEAVE_BODY, "bad-token"))],
    ["leave/act", () => actOnLeave(makeRequest(LEAVE_ACT_BODY, "bad-token"))],
    ["gatepass/act", () => actOnGatePass(makeRequest(GATEPASS_ACT_BODY, "bad-token"))],
    ["complaints/status", () => updateComplaintStatus(makeRequest(COMPLAINT_STATUS_BODY, "bad-token"))],
    ["finance/invoice", () => createInvoice(makeRequest(INVOICE_BODY, "bad-token"))],
    ["finance/payment", () => recordPayment(makeRequest(PAYMENT_BODY, "bad-token"))],
    ["finance/scholarship", () => createScholarship(makeRequest(SCHOLARSHIP_BODY, "bad-token"))],
    ["director/announcement", () => sendAnnouncement(makeRequest(ANNOUNCEMENT_BODY, "bad-token"))],
    ["director/placement", () => createPlacement(makeRequest(PLACEMENT_BODY, "bad-token"))],
    ["admin/update-user", () => updateUser(makeRequest(UPDATE_USER_BODY, "bad-token"))],
    ["admin/user-status", () => updateUserStatus(makeRequest(USER_STATUS_BODY, "bad-token"))],
    ["admin/create-department", () => createDepartment(makeRequest(CREATE_DEPT_BODY, "bad-token"))],
    ["admin/assign-hod", () => assignHod(makeRequest(ASSIGN_HOD_BODY, "bad-token"))],
    ["admin/assign-warden", () => assignWarden(makeRequest(ASSIGN_WARDEN_BODY, "bad-token"))],
    ["admin/create-course", () => createCourse(makeRequest(CREATE_COURSE_BODY, "bad-token"))],
    ["admin/update-college", () => updateCollege(makeRequest(UPDATE_COLLEGE_BODY, "bad-token"))],
    ["admin/invite-user", () => adminInviteUser(makeRequest(INVITE_DIRECTOR_BODY, "bad-token"))],
    ["admin/invitations/resend", () => adminResendInvitation(makeRequest(RESEND_INVITATION_BODY, "bad-token"))],
    ["admin/invitations/revoke", () => adminRevokeInvitation(makeRequest(REVOKE_INVITATION_BODY, "bad-token"))],
    ["director/invite-user", () => directorInviteUser(makeRequest(INVITE_FINANCE_BODY, "bad-token"))],
    ["director/invitations/resend", () => directorResendInvitation(makeRequest(RESEND_INVITATION_BODY, "bad-token"))],
    ["director/invitations/revoke", () => directorRevokeInvitation(makeRequest(REVOKE_INVITATION_BODY, "bad-token"))],
    ["hod/invite-user", () => hodInviteUser(makeRequest(INVITE_TEACHER_BODY, "bad-token"))],
    ["hod/invitations/resend", () => hodResendInvitation(makeRequest(RESEND_INVITATION_BODY, "bad-token"))],
    ["hod/invitations/revoke", () => hodRevokeInvitation(makeRequest(REVOKE_INVITATION_BODY, "bad-token"))],
    ["super-admin/create-college", () => superAdminCreateCollege(makeRequest(CREATE_COLLEGE_BODY, "bad-token"))],
    ["super-admin/invite-user", () => superAdminInviteUser(makeRequest(INVITE_ADMIN_BY_SUPER_ADMIN_BODY, "bad-token"))],
  ])("%s — invalid/expired token → 401", async (_name, call) => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const res = await call();
    expect(res.status).toBe(401);
  });

  it("gatepass/apply — authenticated as a non-student role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "teacher", college_id: "c1", status: "active" } });
    const res = await applyGatePass(makeRequest(GATEPASS_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("complaints/submit — authenticated as a non-student role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "warden", college_id: "c1", status: "active" } });
    const res = await submitComplaint(makeRequest(COMPLAINT_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("gatepass/apply — suspended student account → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "student", college_id: "c1", status: "suspended" } });
    const res = await applyGatePass(makeRequest(GATEPASS_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("attendance/save — authenticated as a non-teacher/admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "student", college_id: "c1", status: "active" } });
    const res = await saveAttendance(makeRequest(ATTENDANCE_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("attendance/save — suspended teacher account → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "teacher", college_id: "c1", status: "suspended" } });
    const res = await saveAttendance(makeRequest(ATTENDANCE_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("grading/save — authenticated as a non-teacher/admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "student", college_id: "c1", status: "active" } });
    const res = await saveGrades(makeRequest(GRADES_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("leave/apply — authenticated as a non-teacher/admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "warden", college_id: "c1", status: "active" } });
    const res = await applyForLeave(makeRequest(LEAVE_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("leave/apply — authenticated as teacher → succeeds and inserts the leave request", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "teacher", college_id: "c1", status: "active" } });
    mockInsert.mockResolvedValue({ error: null });
    const res = await applyForLeave(makeRequest(LEAVE_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ requested_by: "u1", college_id: "c1", leave_type: "casual" })
    );
  });

  it("leave/act — authenticated as a non-hod/admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "teacher", college_id: "c1", status: "active" } });
    const res = await actOnLeave(makeRequest(LEAVE_ACT_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("leave/act — authenticated as admin (bypasses the department-ownership check) → succeeds and updates the request", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "admin", college_id: "c1", status: "active" } });
    const res = await actOnLeave(makeRequest(LEAVE_ACT_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved", approved_by: "u1" })
    );
  });

  it("gatepass/act — authenticated as a non-warden/admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "student", college_id: "c1", status: "active" } });
    const res = await actOnGatePass(makeRequest(GATEPASS_ACT_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("gatepass/act — authenticated as warden → succeeds and updates the gate pass", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "warden", college_id: "c1", status: "active" } });
    const res = await actOnGatePass(makeRequest(GATEPASS_ACT_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved", approved_by: "u1" })
    );
  });

  it("complaints/status — authenticated as a non-warden/admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "finance", college_id: "c1", status: "active" } });
    const res = await updateComplaintStatus(makeRequest(COMPLAINT_STATUS_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("complaints/status — authenticated as warden → succeeds and updates the complaint", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "warden", college_id: "c1", status: "active" } });
    const res = await updateComplaintStatus(makeRequest(COMPLAINT_STATUS_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "in_progress", resolved_at: null })
    );
  });

  it("finance/invoice — authenticated as a non-finance/admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "teacher", college_id: "c1", status: "active" } });
    const res = await createInvoice(makeRequest(INVOICE_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("finance/invoice — authenticated as finance → succeeds and inserts the fee", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle
      .mockResolvedValueOnce({ data: { role: "finance", college_id: "c1", status: "active" } })
      .mockResolvedValueOnce({ data: { id: UUID_STUDENT, college_id: "c1" } });
    mockInsert.mockResolvedValue({ error: null });
    const res = await createInvoice(makeRequest(INVOICE_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ college_id: "c1", student_id: UUID_STUDENT, type: "Tuition", amount: 5000 })
    );
  });

  it("finance/payment — authenticated as a non-finance/admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "student", college_id: "c1", status: "active" } });
    const res = await recordPayment(makeRequest(PAYMENT_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("finance/payment — rejects a payment amount exceeding the outstanding balance", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle
      .mockResolvedValueOnce({ data: { role: "finance", college_id: "c1", status: "active" } })
      .mockResolvedValueOnce({ data: { id: UUID_FEE, college_id: "c1", student_id: UUID_STUDENT, amount: 500, paid_amount: 0 } });
    const res = await recordPayment(makeRequest(PAYMENT_BODY, "good-token")); // amount 1000 > outstanding 500
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/exceeds the outstanding balance/);
  });

  it("finance/payment — authenticated as finance with a valid amount → succeeds and inserts the payment", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle
      .mockResolvedValueOnce({ data: { role: "finance", college_id: "c1", status: "active" } })
      .mockResolvedValueOnce({ data: { id: UUID_FEE, college_id: "c1", student_id: UUID_STUDENT, amount: 5000, paid_amount: 0 } });
    mockInsert.mockResolvedValue({ error: null });
    const res = await recordPayment(makeRequest(PAYMENT_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ college_id: "c1", fee_id: UUID_FEE, amount: 1000, method: "cash", processed_by: "u1" })
    );
  });

  it("finance/scholarship — authenticated as a non-finance/admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "warden", college_id: "c1", status: "active" } });
    const res = await createScholarship(makeRequest(SCHOLARSHIP_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("finance/scholarship — authenticated as finance → succeeds and inserts the scholarship", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle
      .mockResolvedValueOnce({ data: { role: "finance", college_id: "c1", status: "active" } })
      .mockResolvedValueOnce({ data: { id: UUID_STUDENT, college_id: "c1" } });
    mockInsert.mockResolvedValue({ error: null });
    const res = await createScholarship(makeRequest(SCHOLARSHIP_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ college_id: "c1", student_id: UUID_STUDENT, name: "Merit Award", type: "merit", amount: 2000 })
    );
  });

  it("director/announcement — authenticated as a non-director/admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "finance", college_id: "c1", status: "active" } });
    const res = await sendAnnouncement(makeRequest(ANNOUNCEMENT_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("director/placement — authenticated as a non-director/admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "warden", college_id: "c1", status: "active" } });
    const res = await createPlacement(makeRequest(PLACEMENT_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("director/placement — authenticated as director → succeeds and inserts the placement", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle
      .mockResolvedValueOnce({ data: { role: "director", college_id: "c1", status: "active" } })
      .mockResolvedValueOnce({ data: { id: UUID_STUDENT, college_id: "c1" } });
    mockInsert.mockResolvedValue({ error: null });
    const res = await createPlacement(makeRequest(PLACEMENT_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ college_id: "c1", student_id: UUID_STUDENT, company_name: "Acme Corp", role_title: "SWE" })
    );
  });

  // admin/create-course is scoped to 401/403 only — its insert chains
  // .select().single() after .insert(), a shape the shared mock doesn't
  // model. Same documented scoping decision as director/announcement (see
  // its dev log). inviteUserCore's own createAdminClient() call IS mocked
  // (see the top of this file) since it's now shared across four tiers.

  it("admin/update-user — authenticated as a non-admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "hod", college_id: "c1", status: "active" } });
    const res = await updateUser(makeRequest(UPDATE_USER_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("admin/update-user — authenticated as admin → succeeds and updates the profile", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "admin", college_id: "c1", status: "active" } });
    mockInsert.mockResolvedValue({ error: null });
    const res = await updateUser(makeRequest(UPDATE_USER_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ full_name: "Updated Name", role: "student" })
    );
  });

  it("admin/user-status — authenticated as a non-admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "finance", college_id: "c1", status: "active" } });
    const res = await updateUserStatus(makeRequest(USER_STATUS_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("admin/user-status — an admin can't suspend their own account", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: UUID_SELF } } });
    mockSingle.mockResolvedValue({ data: { role: "admin", college_id: "c1", status: "active" } });
    const res = await updateUserStatus(makeRequest({ targetUserId: UUID_SELF, status: "suspended" }, "good-token"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/can't suspend your own account/);
  });

  it("admin/user-status — authenticated as admin → succeeds and updates another user's status", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "admin", college_id: "c1", status: "active" } });
    mockInsert.mockResolvedValue({ error: null });
    const res = await updateUserStatus(makeRequest(USER_STATUS_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: "suspended" }));
  });

  it("admin/create-department — authenticated as a non-admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "hod", college_id: "c1", status: "active" } });
    const res = await createDepartment(makeRequest(CREATE_DEPT_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("admin/create-department — authenticated as admin → succeeds and inserts the department", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "admin", college_id: "c1", status: "active" } });
    mockInsert.mockResolvedValue({ error: null });
    const res = await createDepartment(makeRequest(CREATE_DEPT_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ college_id: "c1", name: "Computer Science", code: "CSE" })
    );
  });

  it("admin/assign-hod — authenticated as a non-admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "director", college_id: "c1", status: "active" } });
    const res = await assignHod(makeRequest(ASSIGN_HOD_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("admin/assign-hod — authenticated as admin, clearing the HOD → succeeds", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "admin", college_id: "c1", status: "active" } });
    const res = await assignHod(makeRequest(ASSIGN_HOD_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ hod_id: null }));
  });

  it("admin/assign-warden — authenticated as a non-admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "warden", college_id: "c1", status: "active" } });
    const res = await assignWarden(makeRequest(ASSIGN_WARDEN_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("admin/assign-warden — authenticated as admin, clearing the warden → succeeds", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "admin", college_id: "c1", status: "active" } });
    const res = await assignWarden(makeRequest(ASSIGN_WARDEN_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ warden_id: null }));
  });

  it("admin/create-course — authenticated as a non-admin/hod/director role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "teacher", college_id: "c1", status: "active" } });
    const res = await createCourse(makeRequest(CREATE_COURSE_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("admin/update-college — authenticated as a non-admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "director", college_id: "c1", status: "active" } });
    const res = await updateCollege(makeRequest(UPDATE_COLLEGE_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("admin/update-college — authenticated as admin → succeeds and updates the college", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "admin", college_id: "c1", status: "active" } });
    mockInsert.mockResolvedValue({ error: null });
    const res = await updateCollege(makeRequest(UPDATE_COLLEGE_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Example College", code: "EC" })
    );
  });

  // super-admin/create-college is scoped to 401/403 only — createCollegeCore's
  // insert chains .select("id").single() after .insert(), the same shape
  // admin/create-course is already scoped out for above.

  it("admin/invite-user — authenticated as a non-admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "director", college_id: "c1", status: "active" } });
    const res = await adminInviteUser(makeRequest(INVITE_DIRECTOR_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("admin/invite-user — authenticated as admin, inviting a director → succeeds", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "admin", college_id: "c1", status: "active" } });
    mockInsert.mockResolvedValue({ error: null });
    const res = await adminInviteUser(makeRequest(INVITE_DIRECTOR_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockGenerateLink).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invite",
        email: "director@college.edu",
        options: expect.objectContaining({ data: expect.objectContaining({ role: "director", college_id: "c1", status: "pending" }) }),
      })
    );
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ email: "director@college.edu", role: "director", college_id: "c1" })
    );
  });

  it("admin/invite-user — admin can't invite a teacher (tier enforcement) → 400", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "admin", college_id: "c1", status: "active" } });
    const res = await adminInviteUser(makeRequest(INVITE_TEACHER_BODY, "good-token"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/can't invite/);
  });

  it("director/invite-user — authenticated as a non-director role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "hod", college_id: "c1", status: "active" } });
    const res = await directorInviteUser(makeRequest(INVITE_FINANCE_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("director/invite-user — authenticated as director, inviting finance → succeeds", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "director", college_id: "c1", status: "active" } });
    mockInsert.mockResolvedValue({ error: null });
    const res = await directorInviteUser(makeRequest(INVITE_FINANCE_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockGenerateLink).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invite",
        email: "finance@college.edu",
        options: expect.objectContaining({ data: expect.objectContaining({ role: "finance" }) }),
      })
    );
  });

  it("hod/invite-user — authenticated as a non-hod role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "teacher", college_id: "c1", status: "active" } });
    const res = await hodInviteUser(makeRequest(INVITE_TEACHER_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("hod/invite-user — authenticated as hod, inviting a teacher → succeeds", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle
      .mockResolvedValueOnce({ data: { role: "hod", college_id: "c1", status: "active" } })
      .mockResolvedValueOnce({ data: { id: UUID_DEPARTMENT } })
      .mockResolvedValueOnce({ data: { name: "Test College" } }); // getCollegeName lookup
    mockInsert.mockResolvedValue({ error: null });
    const res = await hodInviteUser(makeRequest(INVITE_TEACHER_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockGenerateLink).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invite",
        email: "teacher@college.edu",
        options: expect.objectContaining({ data: expect.objectContaining({ role: "teacher" }) }),
      })
    );
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ department_id: UUID_DEPARTMENT }));
  });

  it("hod/invite-user — hod not assigned to any department → 400", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle
      .mockResolvedValueOnce({ data: { role: "hod", college_id: "c1", status: "active" } })
      .mockResolvedValueOnce({ data: null });
    const res = await hodInviteUser(makeRequest(INVITE_TEACHER_BODY, "good-token"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/assigned as a department's HOD/);
  });

  it("super-admin/invite-user — authenticated as a non-super_admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "admin", college_id: "c1", status: "active" } });
    const res = await superAdminInviteUser(makeRequest(INVITE_ADMIN_BY_SUPER_ADMIN_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

  it("super-admin/invite-user — authenticated as super_admin, inviting an Admin into a specific college → succeeds", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "super_admin", college_id: "00000000-0000-0000-0000-000000000000", status: "active" } });
    mockInsert.mockResolvedValue({ error: null });
    const res = await superAdminInviteUser(makeRequest(INVITE_ADMIN_BY_SUPER_ADMIN_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ role: "admin", college_id: UUID_NEW_COLLEGE })
    );
  });

  it("super-admin/invite-user — collegeId required when actor is super_admin → 400", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "super_admin", college_id: "00000000-0000-0000-0000-000000000000", status: "active" } });
    const res = await superAdminInviteUser(
      makeRequest({ email: "admin2@college.edu", fullName: "New Admin", role: "admin" }, "good-token")
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/college must be selected/);
  });

  it("push-token — any authenticated role (e.g. finance) is allowed", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "finance", college_id: "c1", status: "active" } });
    const res = await registerPushToken(makeRequest(PUSH_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "u1", college_id: "c1", expo_push_token: PUSH_BODY.token, platform: "ios" }),
      expect.objectContaining({ onConflict: "expo_push_token" })
    );
  });

  // ─── Request validation (Zod) ──────────────────────────────────────
  // Phase 0 of the production-readiness roadmap added a schema at every
  // mutation boundary. These prove malformed bodies are actually rejected
  // with 400 — not just that the schemas compile — for a representative
  // sample spanning numeric range, enum membership, UUID format, and
  // required-string/email checks. All pass RBAC first (good-token, correct
  // role) so the request actually reaches Zod instead of stopping at 401/403.

  it("finance/payment — negative amount → 400", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "finance", college_id: "c1", status: "active" } });
    const res = await recordPayment(makeRequest({ ...PAYMENT_BODY, amount: -50 }, "good-token"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/greater than zero/);
  });

  it("finance/payment — invalid payment method → 400", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "finance", college_id: "c1", status: "active" } });
    const res = await recordPayment(makeRequest({ ...PAYMENT_BODY, method: "bitcoin" }, "good-token"));
    expect(res.status).toBe(400);
  });

  it("grading/save — non-positive maxMarks → 400", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "teacher", college_id: "c1", status: "active" } });
    const res = await saveGrades(makeRequest({ ...GRADES_BODY, maxMarks: 0 }, "good-token"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/greater than zero/);
  });

  it("attendance/save — non-UUID courseId → 400", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "teacher", college_id: "c1", status: "active" } });
    const res = await saveAttendance(makeRequest({ ...ATTENDANCE_BODY, courseId: "course-1" }, "good-token"));
    expect(res.status).toBe(400);
  });

  it("complaints/submit — invalid category value → 400", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "student", college_id: "c1", status: "active" } });
    const res = await submitComplaint(makeRequest({ ...COMPLAINT_BODY, category: "not-a-category" }, "good-token"));
    expect(res.status).toBe(400);
  });

  it("gatepass/act — invalid action value → 400", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "warden", college_id: "c1", status: "active" } });
    const res = await actOnGatePass(makeRequest({ ...GATEPASS_ACT_BODY, action: "hacked" }, "good-token"));
    expect(res.status).toBe(400);
  });

  it("admin/invite-user — invalid email format → 400", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "admin", college_id: "c1", status: "active" } });
    const res = await adminInviteUser(makeRequest({ ...INVITE_DIRECTOR_BODY, email: "not-an-email" }, "good-token"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid email/);
  });

  it("admin/invite-user — missing full name → 400", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "admin", college_id: "c1", status: "active" } });
    const res = await adminInviteUser(makeRequest({ ...INVITE_DIRECTOR_BODY, fullName: "" }, "good-token"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Full name is required/);
  });

  it("director/placement — missing company name → 400", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "director", college_id: "c1", status: "active" } });
    const res = await createPlacement(makeRequest({ ...PLACEMENT_BODY, companyName: "" }, "good-token"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Company name is required/);
  });

  it("admin/assign-hod — non-UUID departmentId → 400", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "admin", college_id: "c1", status: "active" } });
    const res = await assignHod(makeRequest({ departmentId: "dept-1", hodUserId: null }, "good-token"));
    expect(res.status).toBe(400);
  });
});
