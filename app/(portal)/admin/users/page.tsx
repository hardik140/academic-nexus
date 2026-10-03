"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { ErrorAlert } from "@/components/ui/error-alert";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { useToast } from "@/components/ui/toast";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { classifyError } from "@/lib/feedback-error";
import { requireRows } from "@/lib/read-result";
import { formatMoney } from "@/lib/format";
import {
  inviteUser,
  resendInvitation,
  revokeInvitation,
  updateUserProfile,
  updateUserStatus as updateUserStatusAction,
  listUsers,
  getStudentAcademicSummary,
  updateStudentAcademicStatus,
  listUserSessions,
  revokeUserSession,
  type StudentAcademicSummary,
} from "./actions";
import { SessionsDialog } from "@/components/portal/sessions-dialog";
import type { UserRole, UserStatus } from "@/types/database";

const ACADEMIC_STATUSES = [
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "graduated", label: "Graduated" },
  { value: "dropped", label: "Dropped" },
  { value: "on_leave", label: "On Leave" },
];

const roles: { value: UserRole; label: string }[] = [
  { value: "student", label: "Student" },
  { value: "teacher", label: "Teacher" },
  { value: "hod", label: "HOD" },
  { value: "finance", label: "Finance" },
  { value: "director", label: "Director" },
  { value: "admin", label: "Admin" },
  { value: "warden", label: "Warden" },
];

const USERS_PAGE_SIZE = 10;

function AdminUsersInner() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const [users, setUsers] = useState<any[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<unknown>(null);
  const [totalUsers, setTotalUsers] = useState(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });
  const [editUser, setEditUser] = useState<any>(null);
  const [academicSummary, setAcademicSummary] = useState<StudentAcademicSummary | null>(null);
  const [academicSummaryError, setAcademicSummaryError] = useState<unknown>(null);
  const [academicStatusDraft, setAcademicStatusDraft] = useState("");
  const [academicLoading, setAcademicLoading] = useState(false);
  const [academicError, setAcademicError] = useState<FeedbackError | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; email: string } | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [revokeError, setRevokeError] = useState<FeedbackError | null>(null);
  const [statusTarget, setStatusTarget] = useState<{ id: string; name: string; status: UserStatus } | null>(null);
  const [statusPending, setStatusPending] = useState(false);
  const [statusError, setStatusError] = useState<FeedbackError | null>(null);
  const [sessionsFor, setSessionsFor] = useState<{ id: string; name: string } | null>(null);
  const latestUsersLoad = useRef(0);
  const latestSummary = useRef(0);
  const toast = useToast();
  const [inviteForm, setInviteForm] = useState<{ email: string; full_name: string; role: UserRole; department_id: string }>({
    email: "",
    full_name: "",
    role: "director",
    department_id: "",
  });

  // DataTable reports the initial query on mount and every search/sort/page
  // change thereafter — this is the single fetch path, real pagination via
  // .range() instead of pulling the whole table and slicing client-side.
  // loadUsers is a new function identity every render; only `query` itself
  // changing should re-trigger the fetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadUsers(query); }, [query]);

  useEffect(() => {
    if (searchParams.get("action") === "invite") setShowInvite(true);
  }, [searchParams]);

  const loadUsers = async (q: DataTableQuery) => {
    const run = ++latestUsersLoad.current;
    setUsersLoading(true);
    setUsersError(null);
    try {
      // Server Action, not a direct browser Supabase call — this one goes
      // through getCached() (Redis, college-scoped, 30s TTL), unlike the rest
      // of this page's data (invitations, departments), which is small enough
      // that Phase 3's caching wasn't worth the added indirection there.
      const { data, count } = await listUsers(q);
      if (run !== latestUsersLoad.current) return;
      setUsers(data);
      setTotalUsers(count);
    } catch (e) {
      // A failed load is an error in the table, never "No users found." (D5).
      if (run === latestUsersLoad.current) setUsersError(e);
    } finally {
      if (run === latestUsersLoad.current) setUsersLoading(false);
    }
  };

  const invitationsResource = useAsyncResource(
    async () =>
      requireRows(
        await supabase
          .from("invitations")
          .select("*")
          .eq("status", "pending")
          .order("created_at", { ascending: false })
      ),
    []
  );
  const invitations: any[] = invitationsResource.data ?? [];

  const departmentsResource = useAsyncResource(
    async () => requireRows(await supabase.from("departments").select("id, name, code").order("name")),
    []
  );
  const departments: any[] = departmentsResource.data ?? [];

  const handleInvite = async () => {
    setLoading(true);
    setError(null);
    try {
      await inviteUser({
        email: inviteForm.email,
        fullName: inviteForm.full_name,
        role: inviteForm.role as Exclude<UserRole, "super_admin">,
        departmentId: inviteForm.department_id || undefined,
      });
      setInviteForm({ email: "", full_name: "", role: "director", department_id: "" });
      setShowInvite(false);
      setNotice(`Invitation sent to ${inviteForm.email}.`);
      invitationsResource.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to send invitation."));
    } finally {
      setLoading(false);
    }
  };

  // Low stakes, nothing else to show it: a toast.
  const handleResend = async (invitation: { id: string; email: string }) => {
    setError(null);
    try {
      await resendInvitation(invitation.id);
      toast.success(`Invitation resent to ${invitation.email}.`, { id: `resend-${invitation.id}` });
      invitationsResource.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to resend invitation."));
    }
  };

  // Asked first (ConfirmationDialog); a failure stays in the dialog.
  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    setRevokePending(true);
    setRevokeError(null);
    try {
      await revokeInvitation(revokeTarget.id);
      setNotice(`Invitation for ${revokeTarget.email} revoked.`);
      setRevokeTarget(null);
      invitationsResource.reload();
    } catch (e) {
      setRevokeError(await toFeedbackError(e, "Failed to revoke invitation."));
    } finally {
      setRevokePending(false);
    }
  };

  const handleSaveUser = async () => {
    setLoading(true);
    setError(null);
    try {
      await updateUserProfile(editUser.id, editUser.full_name, editUser.role, editUser.phone || undefined, query);
      setNotice(`${editUser.full_name} updated.`);
      setEditUser(null);
      void loadUsers(query);
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to update user."));
    } finally {
      setLoading(false);
    }
  };

  // A student's academic record, for the Edit dialog. A failed load says so
  // (with Try again) rather than "Loading…" for ever.
  const loadAcademicSummary = async (userId: string) => {
    const run = ++latestSummary.current;
    setAcademicSummary(null);
    setAcademicSummaryError(null);
    try {
      const summary = await getStudentAcademicSummary(userId);
      if (run !== latestSummary.current) return;
      setAcademicSummary(summary);
      if (summary) setAcademicStatusDraft(summary.status);
    } catch (e) {
      if (run === latestSummary.current) setAcademicSummaryError(e);
    }
  };

  const openEditUser = async (row: any) => {
    setEditUser(row);
    setError(null);
    setAcademicError(null);
    setAcademicSummary(null);
    setAcademicSummaryError(null);
    if (row.role === "student") await loadAcademicSummary(row.id);
  };

  const closeEditUser = () => {
    latestSummary.current++;
    setEditUser(null);
    setAcademicSummary(null);
    setAcademicSummaryError(null);
    setAcademicError(null);
  };

  const handleUpdateAcademicStatus = async () => {
    if (!editUser || !academicStatusDraft) return;
    setAcademicLoading(true);
    setAcademicError(null);
    try {
      await updateStudentAcademicStatus(editUser.id, academicStatusDraft as any, query);
    } catch (e) {
      setAcademicError(await toFeedbackError(e, "Failed to update academic status."));
      return;
    } finally {
      setAcademicLoading(false);
    }
    // Refreshing the record is not part of the update: a failure here shows
    // on the record, not as a failed update.
    void loadAcademicSummary(editUser.id);
  };

  // Suspending or reactivating an account is asked first; a failure stays in the dialog.
  const confirmStatusChange = async () => {
    if (!statusTarget) return;
    setStatusPending(true);
    setStatusError(null);
    try {
      await updateUserStatusAction(statusTarget.id, statusTarget.status, query);
      setNotice(`${statusTarget.name} ${statusTarget.status === "suspended" ? "suspended" : "reactivated"}.`);
      setStatusTarget(null);
      void loadUsers(query);
    } catch (e) {
      setStatusError(await toFeedbackError(e, "Failed to update status."));
    } finally {
      setStatusPending(false);
    }
  };

  const noticeRegion = () => noticeRef.current?.querySelector<HTMLElement>('[role="status"]') ?? null;

  const departmentOptions = [
    { value: "", label: "— None —" },
    ...departments.map((d: any) => ({ value: d.id, label: `${d.code} — ${d.name}` })),
  ];

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">User Management</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Manage all user accounts, roles, and invitations</p>
        </div>
        <Button onClick={() => setShowInvite(true)}>+ Invite User</Button>
      </div>

      <div ref={noticeRef}>
        <Alert tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      </div>

      {/* A dialog's own failure is shown inside it. */}
      <ErrorAlert error={!editUser && !showInvite ? error : null} />

      {invitationsResource.status === "error" && (
        <ErrorState
          {...classifyError(invitationsResource.error)}
          title="Pending invitations couldn't be loaded"
          onRetry={invitationsResource.reload}
          className="rounded-2xl border border-outline-variant bg-surface-container-lowest"
        />
      )}

      {invitations.length > 0 && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">Pending Invitations ({invitations.length})</h2>
          </div>
          <div className="divide-y divide-outline-variant">
            {invitations.map((inv: any) => (
              <div key={inv.id} className="flex items-center justify-between px-lg py-md">
                <div>
                  <div className="text-sm font-medium text-on-surface">{inv.email}</div>
                  <div className="text-xs text-outline capitalize">
                    {inv.role} · expires {new Date(inv.expires_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex gap-md">
                  <button type="button" onClick={() => handleResend(inv)} className="text-xs text-secondary hover:underline font-medium">
                    Resend
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRevokeError(null);
                      setRevokeTarget({ id: inv.id, email: inv.email });
                    }}
                    className="text-xs text-error hover:underline font-medium"
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <DataTable
        title="All Users"
        columns={[
          {
            key: "full_name",
            header: "Name",
            sortable: true,
            render: (row: any) => (
              <div className="flex items-center gap-sm">
                {row.avatar_url ? (
                  <Image src={row.avatar_url} alt="" width={28} height={28} className="w-7 h-7 rounded-full object-cover" />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-secondary/10 text-secondary flex items-center justify-center text-[10px] font-bold">
                    {row.full_name?.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
                  </div>
                )}
                <span className="font-medium text-on-surface">{row.full_name}</span>
              </div>
            ),
          },
          { key: "email", header: "Email", sortable: true },
          {
            key: "role",
            header: "Role",
            sortable: true,
            render: (row: any) => (
              <span className="text-xs font-semibold px-sm py-xs rounded-full bg-secondary/10 text-secondary capitalize">{row.role}</span>
            ),
          },
          {
            key: "departments",
            header: "Department",
            render: (row: any) => <span className="text-on-surface-variant">{(row.departments as any)?.name || "—"}</span>,
          },
          {
            key: "status",
            header: "Status",
            render: (row: any) => <StatusBadge status={row.status} />,
          },
        ]}
        data={users}
        keyExtractor={(row) => row.id}
        searchKey="full_name"
        searchPlaceholder="Search users..."
        emptyMessage="No users found."
        onRowClick={openEditUser}
        serverMode
        totalCount={totalUsers}
        loading={usersLoading}
        error={usersError}
        onRetry={() => loadUsers(query)}
        onQueryChange={setQuery}
        pageSize={USERS_PAGE_SIZE}
        actions={(row: any) => (
          <div className="flex gap-xs">
            <button
              onClick={(e) => { e.stopPropagation(); openEditUser(row); }}
              className="text-xs text-secondary hover:underline font-medium"
            >
              Edit
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setSessionsFor({ id: row.id, name: row.full_name }); }}
              className="text-xs text-secondary hover:underline font-medium"
              aria-label={`Sessions of ${row.full_name}`}
            >
              Sessions
            </button>
            {row.status === "active" ? (
              <button
                onClick={(e) => { e.stopPropagation(); setStatusError(null); setStatusTarget({ id: row.id, name: row.full_name, status: "suspended" }); }}
                className="text-xs text-error hover:underline font-medium"
              >
                Suspend
              </button>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); setStatusError(null); setStatusTarget({ id: row.id, name: row.full_name, status: "active" }); }}
                className="text-xs text-success hover:underline font-medium"
              >
                Activate
              </button>
            )}
          </div>
        )}
      />

      <SessionsDialog
        open={!!sessionsFor}
        onClose={() => setSessionsFor(null)}
        title={`Sessions — ${sessionsFor?.name ?? ""}`}
        description="Where this user is signed in. Signing a session out ends it immediately; the user can sign in again."
        load={() => listUserSessions(sessionsFor!.id)}
        revoke={revokeUserSession}
        emptyText="This user is not signed in anywhere."
      />

      {/* Invite User Modal */}
      <Modal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        title="Invite User"
        description="Sends an email invitation — the account is created but stays pending until they accept and set a password."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowInvite(false)}>Cancel</Button>
            <Button onClick={handleInvite} disabled={loading || !inviteForm.email || !inviteForm.full_name} aria-busy={loading || undefined}>
              {loading ? "Sending..." : "Send Invitation"}
            </Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <Alert
          tone="error"
          className="mb-md"
          action={<Button variant="outline" size="sm" onClick={departmentsResource.reload}>Try again</Button>}
        >
          {departmentsResource.status === "error" ? (
            <>
              Departments couldn&apos;t be loaded, so none can be chosen yet.
            </>
          ) : null}
        </Alert>
        <div className="space-y-md">
          <FormField label="Full Name" id="invite_name" value={inviteForm.full_name} onChange={(v) => setInviteForm({ ...inviteForm, full_name: v })} placeholder="e.g. Jane Doe" required />
          <FormField label="Email" id="invite_email" type="email" value={inviteForm.email} onChange={(v) => setInviteForm({ ...inviteForm, email: v })} placeholder="jane@college.edu" required />
          <FormField label="Role" id="invite_role" type="select" value={inviteForm.role} onChange={(v) => setInviteForm({ ...inviteForm, role: v as UserRole })} options={roles} required />
          <FormField label="Department" id="invite_dept" type="select" value={inviteForm.department_id} onChange={(v) => setInviteForm({ ...inviteForm, department_id: v })} options={departmentOptions} />
        </div>
      </Modal>

      {/* Edit User Modal */}
      <Modal
        open={!!editUser}
        onClose={closeEditUser}
        title="Edit User"
        description={editUser?.email}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={closeEditUser}>Cancel</Button>
            <Button onClick={handleSaveUser} disabled={loading} aria-busy={loading || undefined}>
              {loading ? "Saving..." : "Save Changes"}
            </Button>
          </>
        }
      >
        {editUser && (
          <div className="space-y-md">
            <ErrorAlert error={error} />
            <FormField label="Full Name" id="edit_name" value={editUser.full_name} onChange={(v) => setEditUser({ ...editUser, full_name: v })} />
            <FormField label="Role" id="edit_role" type="select" value={editUser.role} onChange={(v) => setEditUser({ ...editUser, role: v })} options={roles} />
            <FormField label="Phone" id="edit_phone" value={editUser.phone || ""} onChange={(v) => setEditUser({ ...editUser, phone: v })} />

            {/* Academic status — a separate concern from identity above (own
                validation, own effect: transitioning to 'graduated' also
                sets profiles.status to 'alumni', see lib/student-lifecycle.ts),
                so it's a second, independent action rather than folded into
                Save Changes. Clearance signals are informational only —
                never a reason this update is blocked. */}
            {editUser.role === "student" && (
              <div className="pt-md mt-md border-t border-outline-variant space-y-sm">
                <div className="text-xs font-bold text-on-surface-variant uppercase tracking-wider">Academic Status</div>
                {academicSummary ? (
                  <>
                    <div className="text-xs text-outline">
                      {academicSummary.enrollmentNumber} · Batch {academicSummary.batchYear} · Semester {academicSummary.semester}
                    </div>
                    <div className="flex flex-wrap gap-xs">
                      {academicSummary.outstandingFees > 0 && (
                        <span className="text-[11px] font-semibold px-sm py-[2px] rounded-full bg-warning-container text-on-warning-container">
                          {formatMoney(academicSummary.outstandingFees)} outstanding
                        </span>
                      )}
                      {academicSummary.hasActiveHostelAllocation && (
                        <span className="text-[11px] font-semibold px-sm py-[2px] rounded-full bg-secondary/10 text-secondary">Active hostel allocation</span>
                      )}
                      {academicSummary.hasOpenGatePass && (
                        <span className="text-[11px] font-semibold px-sm py-[2px] rounded-full bg-secondary/10 text-secondary">Open gate pass</span>
                      )}
                      {academicSummary.outstandingFees <= 0 && !academicSummary.hasActiveHostelAllocation && !academicSummary.hasOpenGatePass && (
                        <span className="text-[11px] text-outline">No clearance flags</span>
                      )}
                    </div>
                    <ErrorAlert error={academicError} />
                    <div className="flex gap-sm items-end">
                      <div className="flex-1">
                        <FormField
                          label="Status"
                          id="academic_status"
                          type="select"
                          value={academicStatusDraft}
                          onChange={setAcademicStatusDraft}
                          options={ACADEMIC_STATUSES}
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleUpdateAcademicStatus}
                        disabled={academicLoading || academicStatusDraft === academicSummary.status}
                        aria-busy={academicLoading || undefined}
                      >
                        {academicLoading ? "Updating..." : "Update Status"}
                      </Button>
                    </div>
                  </>
                ) : academicSummaryError ? (
                  <ErrorState
                    {...classifyError(academicSummaryError)}
                    title="The academic record couldn't be loaded"
                    onRetry={() => loadAcademicSummary(editUser.id)}
                  />
                ) : (
                  <LoadingState variant="inline" label="Loading academic record…" />
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmationDialog
        open={!!revokeTarget}
        title="Revoke this invitation?"
        description={revokeTarget ? `${revokeTarget.email} will no longer be able to use the invitation link. You can invite them again later.` : undefined}
        confirmLabel="Revoke invitation"
        pendingLabel="Revoking…"
        pending={revokePending}
        error={revokeError}
        onConfirm={confirmRevoke}
        onCancel={() => setRevokeTarget(null)}
        returnFocusTo={noticeRegion}
      />

      <ConfirmationDialog
        open={!!statusTarget}
        title={statusTarget?.status === "suspended" ? "Suspend this account?" : "Reactivate this account?"}
        description={
          statusTarget
            ? statusTarget.status === "suspended"
              ? `${statusTarget.name} will be signed out of the portal and unable to sign in until reactivated.`
              : `${statusTarget.name} will be able to sign in again.`
            : undefined
        }
        confirmLabel={statusTarget?.status === "suspended" ? "Suspend account" : "Reactivate account"}
        pendingLabel={statusTarget?.status === "suspended" ? "Suspending…" : "Reactivating…"}
        tone={statusTarget?.status === "suspended" ? "destructive" : "default"}
        pending={statusPending}
        error={statusError}
        onConfirm={confirmStatusChange}
        onCancel={() => setStatusTarget(null)}
        returnFocusTo={noticeRegion}
      />
    </div>
  );
}

export default function AdminUsers() {
  return (
    <Suspense>
      <AdminUsersInner />
    </Suspense>
  );
}
