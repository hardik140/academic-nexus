"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DataTable } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { createDepartment } from "./actions";

function AdminDepartmentsInner() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const [departments, setDepartments] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", code: "", description: "" });

  useEffect(() => { loadDepartments(); }, []);

  useEffect(() => {
    if (searchParams.get("action") === "create") setShowCreate(true);
  }, [searchParams]);

  const loadDepartments = async () => {
    const { data } = await supabase
      .from("departments")
      .select("*, profiles:hod_id(full_name)")
      .order("name");
    setDepartments(data || []);
  };

  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    try {
      await createDepartment(form);
      setForm({ name: "", code: "", description: "" });
      setShowCreate(false);
      await loadDepartments();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create department.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Departments</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Create and manage academic departments</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Add Department</Button>
      </div>

      {error && !showCreate && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      {/* HOD assignment is a Director-level decision (see director/departments) —
          this view is read-only for that field, department creation only. */}
      <DataTable
        columns={[
          { key: "name", header: "Department", sortable: true, render: (row: any) => <span className="font-medium text-on-surface">{row.name}</span> },
          { key: "code", header: "Code", sortable: true, render: (row: any) => <span className="font-mono text-secondary font-semibold">{row.code}</span> },
          { key: "hod", header: "HOD", render: (row: any) => <span className="text-on-surface-variant">{(row.profiles as any)?.full_name || "— Unassigned —"}</span> },
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
            <Button onClick={handleCreate} disabled={loading}>{loading ? "Creating..." : "Create Department"}</Button>
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

export default function AdminDepartments() {
  return (
    <Suspense>
      <AdminDepartmentsInner />
    </Suspense>
  );
}
