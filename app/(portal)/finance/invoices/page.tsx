"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { formatCurrency, formatDate } from "@/lib/utils";
import { computeEffectiveFeeStatus } from "@/lib/finance-status";
import { createInvoice, listInvoices } from "./actions";

const FEES_PAGE_SIZE = 10;

export default function FinanceInvoices() {
  const supabase = createClient();
  const [fees, setFees] = useState<any[]>([]);
  const [feesLoading, setFeesLoading] = useState(false);
  const [totalFees, setTotalFees] = useState(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });
  const [students, setStudents] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ student_id: "", type: "", amount: "", due_date: "", academic_year: "" });

  useEffect(() => { loadStudents(); }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadFees(query); }, [query]);

  const loadFees = async (q: DataTableQuery) => {
    setFeesLoading(true);
    const { data, count } = await listInvoices(q);
    setFees(data);
    setTotalFees(count);
    setFeesLoading(false);
  };

  const loadStudents = async () => {
    const { data } = await supabase
      .from("students")
      .select("id, enrollment_number, profiles:user_id(full_name)")
      .order("enrollment_number");
    setStudents(data || []);
  };

  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    try {
      await createInvoice(form.student_id, form.type, Number(form.amount), form.due_date, form.academic_year || undefined, query);
      setForm({ student_id: "", type: "", amount: "", due_date: "", academic_year: "" });
      setShowCreate(false);
      await loadFees(query);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to raise invoice.");
    } finally {
      setLoading(false);
    }
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

      {error && !showCreate && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      <DataTable
        columns={[
          { key: "student", header: "Student", render: (row: any) => <span className="font-medium text-on-surface">{(row.students as any)?.profiles?.full_name || "—"}</span> },
          { key: "type", header: "Type", sortable: true },
          { key: "amount", header: "Amount", sortable: true, render: (row: any) => formatCurrency(row.amount) },
          { key: "paid_amount", header: "Paid", render: (row: any) => formatCurrency(row.paid_amount) },
          { key: "due_date", header: "Due Date", sortable: true, render: (row: any) => formatDate(row.due_date) },
          { key: "status", header: "Status", render: (row: any) => <StatusBadge status={computeEffectiveFeeStatus(row)} /> },
        ]}
        data={fees}
        keyExtractor={(row) => row.id}
        searchKey="type"
        searchPlaceholder="Search by fee type..."
        emptyMessage="No invoices raised yet."
        serverMode
        totalCount={totalFees}
        loading={feesLoading}
        onQueryChange={setQuery}
        pageSize={FEES_PAGE_SIZE}
      />

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Raise Invoice"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={loading || !form.student_id}>{loading ? "Creating..." : "Raise Invoice"}</Button>
          </>
        }
      >
        {error && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{error}</div>
        )}
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
