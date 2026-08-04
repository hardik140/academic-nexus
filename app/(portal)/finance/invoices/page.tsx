"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { DataTable } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { formatCurrency, formatDate } from "@/lib/utils";

export default function FinanceInvoices() {
  const supabase = createClient();
  const [fees, setFees] = useState<any[]>([]);
  const [students, setStudents] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ student_id: "", type: "", amount: "", due_date: "", academic_year: "" });

  useEffect(() => { loadFees(); loadStudents(); }, []);

  const loadFees = async () => {
    const { data } = await supabase
      .from("fees")
      .select("*, students:student_id(enrollment_number, profiles:user_id(full_name))")
      .order("due_date", { ascending: false });
    setFees(data || []);
  };

  const loadStudents = async () => {
    const { data } = await supabase
      .from("students")
      .select("id, enrollment_number, profiles:user_id(full_name)")
      .order("enrollment_number");
    setStudents(data || []);
  };

  const createInvoice = async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: profile } = await supabase.from("profiles").select("college_id").eq("id", user.id).single();
    if (!profile) return;

    await supabase.from("fees").insert({
      college_id: profile.college_id,
      student_id: form.student_id,
      type: form.type,
      amount: Number(form.amount),
      due_date: form.due_date,
      academic_year: form.academic_year,
    });

    setForm({ student_id: "", type: "", amount: "", due_date: "", academic_year: "" });
    setShowCreate(false);
    setLoading(false);
    loadFees();
  };

  const studentOptions = students.map((s) => ({
    value: s.id,
    label: `${s.enrollment_number} — ${(s.profiles as any)?.full_name || ""}`,
  }));

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Invoices</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Fee invoices raised across the institution</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Raise Invoice</Button>
      </div>

      <DataTable
        columns={[
          { key: "student", header: "Student", render: (row: any) => <span className="font-medium text-on-surface">{(row.students as any)?.profiles?.full_name || "—"}</span> },
          { key: "type", header: "Type", sortable: true },
          { key: "amount", header: "Amount", sortable: true, render: (row: any) => formatCurrency(row.amount) },
          { key: "paid_amount", header: "Paid", render: (row: any) => formatCurrency(row.paid_amount) },
          { key: "due_date", header: "Due Date", sortable: true, render: (row: any) => formatDate(row.due_date) },
          { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
        ]}
        data={fees}
        keyExtractor={(row) => row.id}
        searchPlaceholder="Search invoices..."
        emptyMessage="No invoices raised yet."
      />

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Raise Invoice"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={createInvoice} disabled={loading || !form.student_id}>{loading ? "Creating..." : "Raise Invoice"}</Button>
          </>
        }
      >
        <div className="space-y-md">
          <FormField label="Student" id="student" type="select" value={form.student_id} onChange={(v) => setForm({ ...form, student_id: v })} options={studentOptions} required />
          <FormField label="Fee Type" id="type" value={form.type} onChange={(v) => setForm({ ...form, type: v })} placeholder="e.g. Tuition, Hostel, Exam" required />
          <FormField label="Amount" id="amount" type="number" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} placeholder="0.00" required />
          <FormField label="Due Date" id="due_date" type="date" value={form.due_date} onChange={(v) => setForm({ ...form, due_date: v })} required />
          <FormField label="Academic Year" id="academic_year" value={form.academic_year} onChange={(v) => setForm({ ...form, academic_year: v })} placeholder="e.g. 2025-26" />
        </div>
      </Modal>
    </div>
  );
}
