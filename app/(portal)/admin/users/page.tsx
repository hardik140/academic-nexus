"use client";

import { Suspense, useState, useEffect } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { formatCurrency } from "@/lib/utils";
import {
  inviteUser,
  resendInvitation,
  revokeInvitation,
  updateUserProfile,
  updateUserStatus as updateUserStatusAction,
  listUsers,
  getStudentAcademicSummary,
  updateStudentAcademicStatus,
  type StudentAcademicSummary,
} from "./actions";
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
  const [totalUsers, setTotalUsers] = useState(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });
  const [invitations, setInvitations] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [editUser, setEditUser] = useState<any>(null);
  const [academicSummary, setAcademicSummary] = useState<StudentAcademicSummary | null>(null);
  const [academicStatusDraft, setAcademicStatusDraft] = useState("");
  const [academicLoading, setAcademicLoading] = useState(false);
  const [academicError, setAcademicError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteForm, setInviteForm] = useState<{ email: string; full_name: string; role: UserRole; department_id: string }>({
    email: "",
    full_name: "",
    role: "director",
    department_id: "",
  });

  useEffect(() => { loadInvitations(); loadDepartments(); }, []);

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
    setUsersLoading(true);
    // Server Action, not a direct browser Supabase call — this one goes
    // through getCached() (Redis, college-scoped, 30s TTL), unlike the rest
    // of this page's data (invitations, departments), which is small enough
    // that Phase 3's caching wasn't worth the added indirection there.
    const { data, count } = await listUsers(q);

    setUsers(data);
    setTotalUsers(count);
    setUsersLoading(false);
  };

  const loadInvitations = async () => {
    const { data } = await supabase
      .from("invitations")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    setInvitations(data || []);
  };

  const loadDepartments = async () => {
    const { data } = await supabase.from("departments").select("id, name, code").order("name");
    setDepartments(data || []);
  };

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
      await loadInvitations();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send invitation.");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async (invitationId: string) => {
    setError(null);
    try {
      await resendInvitation(invitationId);
      await loadInvitations();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to resend invitation.");
    }
  };

  const handleRevoke = async (invitationId: string) => {
    setError(null);
    try {
      await revokeInvitation(invitationId);
      await loadInvitations();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke invitation.");
    }
  };

  const handleSaveUser = async () => {
    setLoading(true);
    setError(null);
    try {
      await updateUserProfile(editUser.id, editUser.full_name, editUser.role, editUser.phone || undefined, query);
      setEditUser(null);
      await loadUsers(query);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update user.");
    } finally {
      setLoading(false);
    }
  };

  const openEditUser = async (row: any) => {
    setEditUser(row);
    setAcademicSummary(null);
    setAcademicError(null);
    if (row.role === "student") {
      const summary = await getStudentAcademicSummary(row.id);
      setAcademicSummary(summary);
      if (summary) setAcademicStatusDraft(summary.status);
    }
  };

  const closeEditUser = () => {
    setEditUser(null);
    setAcademicSummary(null);
    setAcademicError(null);
  };

  const handleUpdateAcademicStatus = async () => {
    if (!editUser || !academicStatusDraft) return;
    setAcademicLoading(true);
    setAcademicError(null);
    try {
      await updateStudentAcademicStatus(editUser.id, academicStatusDraft as any, query);
      const summary = await getStudentAcademicSummary(editUser.id);
      setAcademicSummary(summary);
    } catch (e) {
      setAcademicError(e instanceof Error ? e.message : "Failed to update academic status.");
    } finally {
      setAcademicLoading(false);
    }
  };

  const updateUserStatus = async (userId: string, status: string) => {
    setError(null);
    try {
      await updateUserStatusAction(userId, status as UserStatus, query);
      await loadUsers(query);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update status.");
    }
  };

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

      {error && !editUser && !showInvite && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
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
                  <button onClick={() => handleResend(inv.id)} className="text-xs text-secondary hover:underline font-medium">
                    Resend
                  </button>
                  <button onClick={() => handleRevoke(inv.id)} className="text-xs text-error hover:underline font-medium">
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
            {row.status === "active" ? (
              <button
                onClick={(e) => { e.stopPropagation(); updateUserStatus(row.id, "suspended"); }}
                className="text-xs text-error hover:underline font-medium"
              >
                Suspend
              </button>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); updateUserStatus(row.id, "active"); }}
                className="text-xs text-success hover:underline font-medium"
              >
                Activate
              </button>
            )}
          </div>
        )}
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
            <Button onClick={handleInvite} disabled={loading || !inviteForm.email || !inviteForm.full_name}>
              {loading ? "Sending..." : "Send Invitation"}
            </Button>
          </>
        }
      >
        {error && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{error}</div>
        )}
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
            <Button onClick={handleSaveUser} disabled={loading}>
              {loading ? "Saving..." : "Save Changes"}
            </Button>
          </>
        }
      >
        {editUser && (
          <div className="space-y-md">
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
                        <span className="text-[11px] font-semibold px-sm py-[2px] rounded-full bg-warning/10 text-warning">
                          {formatCurrency(academicSummary.outstandingFees)} outstanding
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
                    {academicError && <p className="text-xs text-error font-medium">{academicError}</p>}
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
                      >
                        {academicLoading ? "Updating..." : "Update Status"}
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-outline">Loading academic record...</div>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>
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
