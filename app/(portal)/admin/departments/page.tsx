"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { DataTable } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";

export default function AdminDepartments() {
  const supabase = createClient();
  const [departments, setDepartments] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ name: "", code: "", description: "" });

  useEffect(() => { loadDepartments(); }, []);

  const loadDepartments = async () => {
    const { data } = await supabase
      .from("departments")
      .select("*, profiles:hod_id(full_name)")
      .order("name");
    setDepartments(data || []);
  };

  const createDepartment = async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: profile } = await supabase.from("profiles").select("college_id").eq("id", user.id).single();
    if (!profile) return;

    await supabase.from("departments").insert({
      college_id: profile.college_id,
      name: form.name,
      code: form.code,
      description: form.description,
    });

    setForm({ name: "", code: "", description: "" });
    setShowCreate(false);
    setLoading(false);
    loadDepartments();
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Departments</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Manage academic departments</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Add Department</Button>
      </div>

      <DataTable
        columns={[
          { key: "name", header: "Department", sortable: true, render: (row: any) => <span className="font-medium text-on-surface">{row.name}</span> },
          { key: "code", header: "Code", sortable: true, render: (row: any) => <span className="font-mono text-secondary font-semibold">{row.code}</span> },
          { key: "hod", header: "HOD", render: (row: any) => <span className="text-on-surface-variant">{(row.profiles as any)?.full_name || "—"}</span> },
          { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
        ]}
        data={departments}
        keyExtractor={(row) => row.id}
        searchKey="name"
        searchPlaceholder="Search departments..."
        emptyMessage="No departments found."
      />

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Add Department"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={createDepartment} disabled={loading}>{loading ? "Creating..." : "Create Department"}</Button>
          </>
        }
      >
        <div className="space-y-md">
          <FormField label="Department Name" id="dept_name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="e.g. Computer Science & Engineering" required />
          <FormField label="Code" id="dept_code" value={form.code} onChange={(v) => setForm({ ...form, code: v })} placeholder="e.g. CSE" required />
          <FormField label="Description" id="dept_desc" type="textarea" value={form.description} onChange={(v) => setForm({ ...form, description: v })} placeholder="Brief description..." />
        </div>
      </Modal>
    </div>
  );
}
