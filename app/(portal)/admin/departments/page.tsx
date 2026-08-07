"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DataTable } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { createDepartment, assignHod } from "./actions";

function AdminDepartmentsInner() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const [departments, setDepartments] = useState<any[]>([]);
  const [staff, setStaff] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editDept, setEditDept] = useState<any>(null);
  const [selectedHod, setSelectedHod] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", code: "", description: "" });

  useEffect(() => { loadDepartments(); loadStaff(); }, []);

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

  const loadStaff = async () => {
    const { data } = await supabase
      .from("profiles")
      .select("id, full_name, role")
      .in("role", ["hod", "teacher"])
      .order("full_name");
    setStaff(data || []);
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

  const openEdit = (dept: any) => {
    setEditDept(dept);
    setSelectedHod(dept.hod_id || "");
    setError(null);
  };

  const handleAssignHod = async () => {
    if (!editDept) return;
    setLoading(true);
    setError(null);
    try {
      await assignHod(editDept.id, selectedHod || null);
      setEditDept(null);
      await loadDepartments();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to assign HOD.");
    } finally {
      setLoading(false);
    }
  };

  const hodOptions = [
    { value: "", label: "— No HOD assigned —" },
    ...staff.map((s) => ({ value: s.id, label: `${s.full_name} (${s.role})` })),
  ];

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Departments</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Manage academic departments</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Add Department</Button>
      </div>

      {error && !editDept && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

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
        onRowClick={(row) => openEdit(row)}
        actions={(row: any) => (
          <button
            onClick={(e) => { e.stopPropagation(); openEdit(row); }}
            className="text-xs text-secondary hover:underline font-medium"
          >
            Assign HOD
          </button>
        )}
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

      <Modal
        open={!!editDept}
        onClose={() => setEditDept(null)}
        title={`Assign HOD — ${editDept?.name || ""}`}
        description="Only staff with the HOD or Teacher role are eligible."
        footer={
          <>
            <Button variant="outline" onClick={() => setEditDept(null)}>Cancel</Button>
            <Button onClick={handleAssignHod} disabled={loading}>{loading ? "Saving..." : "Save"}</Button>
          </>
        }
      >
        {error && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{error}</div>
        )}
        <FormField
          label="Head of Department"
          id="edit_hod"
          type="select"
          value={selectedHod}
          onChange={setSelectedHod}
          options={hodOptions}
        />
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
