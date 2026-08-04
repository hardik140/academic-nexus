"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { DataTable } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { formatCurrency, formatDate } from "@/lib/utils";

const SCHOLARSHIP_TYPES = [
  { value: "merit", label: "Merit" },
  { value: "need", label: "Need-based" },
  { value: "sports", label: "Sports" },
  { value: "government", label: "Government" },
  { value: "corporate", label: "Corporate" },
  { value: "other", label: "Other" },
];

export default function FinanceScholarships() {
  const supabase = createClient();
  const [scholarships, setScholarships] = useState<any[]>([]);
  const [students, setStudents] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ student_id: "", name: "", amount: "", type: "merit", academic_year: "" });

  useEffect(() => { loadScholarships(); loadStudents(); }, []);

  const loadScholarships = async () => {
    const { data } = await supabase
      .from("scholarships")
      .select("*, students:student_id(enrollment_number, profiles:user_id(full_name))")
      .order("awarded_date", { ascending: false });
    setScholarships(data || []);
  };

  const loadStudents = async () => {
    const { data } = await supabase
      .from("students")
      .select("id, enrollment_number, profiles:user_id(full_name)")
      .order("enrollment_number");
    setStudents(data || []);
  };

  const createScholarship = async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: profile } = await supabase.from("profiles").select("college_id").eq("id", user.id).single();
    if (!profile) return;

    await supabase.from("scholarships").insert({
      college_id: profile.college_id,
      student_id: form.student_id,
      name: form.name,
      amount: Number(form.amount),
      type: form.type,
      academic_year: form.academic_year,
      awarded_date: new Date().toISOString().slice(0, 10),
    });

    setForm({ student_id: "", name: "", amount: "", type: "merit", academic_year: "" });
    setShowCreate(false);
    setLoading(false);
    loadScholarships();
  };

  const studentOptions = students.map((s) => ({
    value: s.id,
    label: `${s.enrollment_number} — ${(s.profiles as any)?.full_name || ""}`,
  }));

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Scholarships</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Manage student scholarships and awards</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Award Scholarship</Button>
      </div>

      <DataTable
        columns={[
          { key: "student", header: "Student", render: (row: any) => <span className="font-medium text-on-surface">{(row.students as any)?.profiles?.full_name || "—"}</span> },
          { key: "name", header: "Scholarship", sortable: true },
          { key: "type", header: "Type", render: (row: any) => <span className="capitalize">{row.type}</span> },
          { key: "amount", header: "Amount", sortable: true, render: (row: any) => formatCurrency(row.amount) },
          { key: "awarded_date", header: "Awarded", render: (row: any) => row.awarded_date ? formatDate(row.awarded_date) : "—" },
          { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
        ]}
        data={scholarships}
        keyExtractor={(row) => row.id}
        searchPlaceholder="Search scholarships..."
        emptyMessage="No scholarships awarded yet."
      />

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Award Scholarship"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={createScholarship} disabled={loading || !form.student_id}>{loading ? "Saving..." : "Award Scholarship"}</Button>
          </>
        }
      >
        <div className="space-y-md">
          <FormField label="Student" id="student" type="select" value={form.student_id} onChange={(v) => setForm({ ...form, student_id: v })} options={studentOptions} required />
          <FormField label="Scholarship Name" id="name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="e.g. Dean's Merit Award" required />
          <FormField label="Type" id="type" type="select" value={form.type} onChange={(v) => setForm({ ...form, type: v })} options={SCHOLARSHIP_TYPES} required />
          <FormField label="Amount" id="amount" type="number" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} placeholder="0.00" required />
          <FormField label="Academic Year" id="academic_year" value={form.academic_year} onChange={(v) => setForm({ ...form, academic_year: v })} placeholder="e.g. 2025-26" />
        </div>
      </Modal>
    </div>
  );
}
