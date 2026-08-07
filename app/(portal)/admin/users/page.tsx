"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DataTable } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { DEFAULT_QUERY_LIMIT } from "@/lib/constants";
import { createUser, updateUserProfile, updateUserStatus as updateUserStatusAction } from "./actions";
import type { UserRole, UserStatus } from "@/types/database";

const roles: { value: UserRole; label: string }[] = [
  { value: "student", label: "Student" },
  { value: "teacher", label: "Teacher" },
  { value: "hod", label: "HOD" },
  { value: "finance", label: "Finance" },
  { value: "director", label: "Director" },
  { value: "admin", label: "Admin" },
  { value: "warden", label: "Warden" },
];

function AdminUsersInner() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const [users, setUsers] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [editUser, setEditUser] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<{ email: string; full_name: string; role: UserRole; department_id: string }>({
    email: "",
    full_name: "",
    role: "student",
    department_id: "",
  });

  useEffect(() => { loadUsers(); loadDepartments(); }, []);

  useEffect(() => {
    if (searchParams.get("action") === "create") setShowCreate(true);
  }, [searchParams]);

  const loadUsers = async () => {
    const { data } = await supabase
      .from("profiles")
      .select("*, departments:department_id(name)")
      .order("created_at", { ascending: false })
      .limit(DEFAULT_QUERY_LIMIT);
    setUsers(data || []);
  };

  const loadDepartments = async () => {
    const { data } = await supabase.from("departments").select("id, name, code").order("name");
    setDepartments(data || []);
  };

  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    try {
      await createUser(createForm.email, createForm.full_name, createForm.role, createForm.department_id || undefined);
      setCreateForm({ email: "", full_name: "", role: "student", department_id: "" });
      setShowCreate(false);
      await loadUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create user.");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveUser = async () => {
    setLoading(true);
    setError(null);
    try {
      await updateUserProfile(editUser.id, editUser.full_name, editUser.role, editUser.phone || undefined);
      setEditUser(null);
      await loadUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update user.");
    } finally {
      setLoading(false);
    }
  };

  const updateUserStatus = async (userId: string, status: string) => {
    setError(null);
    try {
      await updateUserStatusAction(userId, status as UserStatus);
      await loadUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update status.");
    }
  };

  const departmentOptions = [
    { value: "", label: "— None —" },
    ...departments.map((d: any) => ({ value: d.id, label: `${d.code} — ${d.name}` })),
  ];

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">User Management</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Manage all user accounts, roles, and permissions</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Add User</Button>
      </div>

      {error && !editUser && !showCreate && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
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
                  <img src={row.avatar_url} alt="" className="w-7 h-7 rounded-full object-cover" />
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
        onRowClick={(row) => setEditUser(row)}
        actions={(row: any) => (
          <div className="flex gap-xs">
            <button
              onClick={(e) => { e.stopPropagation(); setEditUser(row); }}
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

      {/* Add User Modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Add User"
        description="Creates a real account — the user can sign in immediately with this email."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={loading || !createForm.email || !createForm.full_name}>
              {loading ? "Creating..." : "Create User"}
            </Button>
          </>
        }
      >
        {error && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{error}</div>
        )}
        <div className="space-y-md">
          <FormField label="Full Name" id="create_name" value={createForm.full_name} onChange={(v) => setCreateForm({ ...createForm, full_name: v })} placeholder="e.g. Jane Doe" required />
          <FormField label="Email" id="create_email" type="email" value={createForm.email} onChange={(v) => setCreateForm({ ...createForm, email: v })} placeholder="jane@college.edu" required />
          <FormField label="Role" id="create_role" type="select" value={createForm.role} onChange={(v) => setCreateForm({ ...createForm, role: v as UserRole })} options={roles} required />
          <FormField label="Department" id="create_dept" type="select" value={createForm.department_id} onChange={(v) => setCreateForm({ ...createForm, department_id: v })} options={departmentOptions} />
        </div>
      </Modal>

      {/* Edit User Modal */}
      <Modal
        open={!!editUser}
        onClose={() => setEditUser(null)}
        title="Edit User"
        description={editUser?.email}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setEditUser(null)}>Cancel</Button>
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
