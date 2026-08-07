import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetUser = vi.fn();
const mockSingle = vi.fn();
const mockInsert = vi.fn();
const mockUpsert = vi.fn();
const mockUpdate = vi.fn();

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
import { POST as createUser } from "@/app/api/mobile/admin/create-user/route";
import { POST as updateUser } from "@/app/api/mobile/admin/update-user/route";
import { POST as updateUserStatus } from "@/app/api/mobile/admin/user-status/route";
import { POST as createDepartment } from "@/app/api/mobile/admin/create-department/route";
import { POST as assignHod } from "@/app/api/mobile/admin/assign-hod/route";
import { POST as assignWarden } from "@/app/api/mobile/admin/assign-warden/route";
import { POST as createCourse } from "@/app/api/mobile/admin/create-course/route";
import { POST as updateCollege } from "@/app/api/mobile/admin/update-college/route";

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

describe("app/api/mobile/* — HTTP-boundary authorization matrix", () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    mockSingle.mockReset();
    mockInsert.mockReset();
    mockUpsert.mockReset();
    mockUpsert.mockResolvedValue({ error: null });
    mockUpdate.mockReset();
    mockUpdate.mockReturnValue({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) });
  });

  const GATEPASS_BODY = { destination: "Home", reason: "Weekend", exitTime: "2026-09-01T09:00:00Z", returnTime: "2026-09-02T18:00:00Z" };
  const COMPLAINT_BODY = { category: "plumbing", title: "Leaky tap", description: "desc", location: "Room 1", priority: "low" };
  const PUSH_BODY = { token: "ExponentPushToken[abc]", platform: "ios" };
  const ATTENDANCE_BODY = { courseId: "course-1", date: "2026-09-01", entries: [{ studentDbId: "s1", status: "present" }] };
  const GRADES_BODY = { courseId: "course-1", examType: "internal_1", maxMarks: 100, entries: [{ studentDbId: "s1", obtainedMarks: 80 }] };
  const LEAVE_BODY = { leaveType: "casual", startDate: "2026-09-01", endDate: "2026-09-02", reason: "Personal" };
  const LEAVE_ACT_BODY = { requestId: "leave-1", action: "approved" };
  const GATEPASS_ACT_BODY = { passId: "pass-1", action: "approved" };
  const COMPLAINT_STATUS_BODY = { complaintId: "complaint-1", status: "in_progress" };
  const INVOICE_BODY = { studentId: "student-1", type: "Tuition", amount: 5000, dueDate: "2026-09-01" };
  const PAYMENT_BODY = { feeId: "fee-1", amount: 1000, method: "cash" };
  const SCHOLARSHIP_BODY = { studentId: "student-1", name: "Merit Award", type: "merit", amount: 2000 };
  const ANNOUNCEMENT_BODY = { title: "Campus Update", message: "Hello everyone", audience: "all" };
  const PLACEMENT_BODY = { studentId: "student-1", companyName: "Acme Corp", roleTitle: "SWE", packageLpa: 12, placementDate: "2026-09-01" };
  const CREATE_USER_BODY = { email: "new@college.edu", fullName: "New User", role: "student" };
  const UPDATE_USER_BODY = { targetUserId: "u2", fullName: "Updated Name", role: "student" };
  const USER_STATUS_BODY = { targetUserId: "u2", status: "suspended" };
  const CREATE_DEPT_BODY = { name: "Computer Science", code: "CSE", description: "" };
  const ASSIGN_HOD_BODY = { departmentId: "dept-1", hodUserId: null };
  const ASSIGN_WARDEN_BODY = { blockId: "block-1", wardenUserId: null };
  const CREATE_COURSE_BODY = { name: "Data Structures", code: "CS201", departmentId: "dept-1", credits: 4, semester: 3, type: "core" };
  const UPDATE_COLLEGE_BODY = { name: "Example College", code: "EC" };

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
    ["admin/create-user", () => createUser(makeRequest(CREATE_USER_BODY))],
    ["admin/update-user", () => updateUser(makeRequest(UPDATE_USER_BODY))],
    ["admin/user-status", () => updateUserStatus(makeRequest(USER_STATUS_BODY))],
    ["admin/create-department", () => createDepartment(makeRequest(CREATE_DEPT_BODY))],
    ["admin/assign-hod", () => assignHod(makeRequest(ASSIGN_HOD_BODY))],
    ["admin/assign-warden", () => assignWarden(makeRequest(ASSIGN_WARDEN_BODY))],
    ["admin/create-course", () => createCourse(makeRequest(CREATE_COURSE_BODY))],
    ["admin/update-college", () => updateCollege(makeRequest(UPDATE_COLLEGE_BODY))],
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
    ["admin/create-user", () => createUser(makeRequest(CREATE_USER_BODY, "bad-token"))],
    ["admin/update-user", () => updateUser(makeRequest(UPDATE_USER_BODY, "bad-token"))],
    ["admin/user-status", () => updateUserStatus(makeRequest(USER_STATUS_BODY, "bad-token"))],
    ["admin/create-department", () => createDepartment(makeRequest(CREATE_DEPT_BODY, "bad-token"))],
    ["admin/assign-hod", () => assignHod(makeRequest(ASSIGN_HOD_BODY, "bad-token"))],
    ["admin/assign-warden", () => assignWarden(makeRequest(ASSIGN_WARDEN_BODY, "bad-token"))],
    ["admin/create-course", () => createCourse(makeRequest(CREATE_COURSE_BODY, "bad-token"))],
    ["admin/update-college", () => updateCollege(makeRequest(UPDATE_COLLEGE_BODY, "bad-token"))],
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
      .mockResolvedValueOnce({ data: { id: "student-1", college_id: "c1" } });
    mockInsert.mockResolvedValue({ error: null });
    const res = await createInvoice(makeRequest(INVOICE_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ college_id: "c1", student_id: "student-1", type: "Tuition", amount: 5000 })
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
      .mockResolvedValueOnce({ data: { id: "fee-1", college_id: "c1", student_id: "student-1", amount: 500, paid_amount: 0 } });
    const res = await recordPayment(makeRequest(PAYMENT_BODY, "good-token")); // amount 1000 > outstanding 500
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/exceeds the outstanding balance/);
  });

  it("finance/payment — authenticated as finance with a valid amount → succeeds and inserts the payment", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle
      .mockResolvedValueOnce({ data: { role: "finance", college_id: "c1", status: "active" } })
      .mockResolvedValueOnce({ data: { id: "fee-1", college_id: "c1", student_id: "student-1", amount: 5000, paid_amount: 0 } });
    mockInsert.mockResolvedValue({ error: null });
    const res = await recordPayment(makeRequest(PAYMENT_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ college_id: "c1", fee_id: "fee-1", amount: 1000, method: "cash", processed_by: "u1" })
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
      .mockResolvedValueOnce({ data: { id: "student-1", college_id: "c1" } });
    mockInsert.mockResolvedValue({ error: null });
    const res = await createScholarship(makeRequest(SCHOLARSHIP_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ college_id: "c1", student_id: "student-1", name: "Merit Award", type: "merit", amount: 2000 })
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
      .mockResolvedValueOnce({ data: { id: "student-1", college_id: "c1" } });
    mockInsert.mockResolvedValue({ error: null });
    const res = await createPlacement(makeRequest(PLACEMENT_BODY, "good-token"));
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ college_id: "c1", student_id: "student-1", company_name: "Acme Corp", role_title: "SWE" })
    );
  });

  // admin/create-user and admin/create-course are scoped to 401/403 only —
  // createUserCore calls the real (unmocked) createAdminClient() once past
  // the role guard, and createCourseCore's insert chains .select().single()
  // after .insert(), a shape the shared mock doesn't model. Same documented
  // scoping decision as director/announcement (see its dev log).

  it("admin/create-user — authenticated as a non-admin role → 403", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "director", college_id: "c1", status: "active" } });
    const res = await createUser(makeRequest(CREATE_USER_BODY, "good-token"));
    expect(res.status).toBe(403);
  });

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
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockSingle.mockResolvedValue({ data: { role: "admin", college_id: "c1", status: "active" } });
    const res = await updateUserStatus(makeRequest({ targetUserId: "u1", status: "suspended" }, "good-token"));
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
});
