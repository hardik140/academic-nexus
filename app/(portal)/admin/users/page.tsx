"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { DataTable } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";

export default function AdminUsers() {
  const supabase = createClient();
  const [users, setUsers] = useState<any[]>([]);
  const [editUser, setEditUser] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [newUser, setNewUser] = useState({ full_name: "", email: "", role: "student", phone: "" });

  useEffect(() => { loadUsers(); }, []);

  const loadUsers = async () => {
    const { data } = await supabase
      .from("profiles")
      .select("*, departments:department_id(name)")
      .order("created_at", { ascending: false });
    setUsers(data || []);
  };

  const updateUserRole = async (userId: string, role: string) => {
    setLoading(true);
    await supabase.from("profiles").update({ role }).eq("id", userId);
    setLoading(false);
    setEditUser(null);
    loadUsers();
  };

  const updateUserStatus = async (userId: string, status: string) => {
    await supabase.from("profiles").update({ status }).eq("id", userId);
    loadUsers();
  };

  const roles = [
    { value: "student", label: "Student" },
    { value: "teacher", label: "Teacher" },
    { value: "hod", label: "HOD" },
    { value: "finance", label: "Finance" },
    { value: "director", label: "Director" },
    { value: "admin", label: "Admin" },
    { value: "warden", label: "Warden" },
    { value: "parent", label: "Parent" },
  ];

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">User Management</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Manage all user accounts, roles, and permissions</p>
        </div>
      </div>

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
            <Button onClick={() => updateUserRole(editUser?.id, editUser?.role)} disabled={loading}>
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
