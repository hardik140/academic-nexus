"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { StudentSearchField } from "@/components/student-search-field";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { requireRows } from "@/lib/read-result";
import { formatDate } from "@/lib/utils";
import { formatMoney } from "@/lib/format";
import { computeEffectiveFeeStatus } from "@/lib/finance-status";
import { createInvoice, listInvoices } from "./actions";

const FEES_PAGE_SIZE = 10;

export default function FinanceInvoices() {
  const supabase = createClient();
  const [fees, setFees] = useState<any[]>([]);
  const [feesLoading, setFeesLoading] = useState(false);
  const [feesError, setFeesError] = useState<unknown>(null);
  const [totalFees, setTotalFees] = useState(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latestLoad = useRef(0);
  const [form, setForm] = useState({ student_id: "", type: "", amount: "", due_date: "", academic_year: "" });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadFees(query); }, [query]);

  // The latest query's page; a failed load is an error in the table, never
  // "No invoices raised yet." (owner decision D5).
  const loadFees = async (q: DataTableQuery) => {
    const run = ++latestLoad.current;
    setFeesLoading(true);
    setFeesError(null);
    try {
      const { data, count } = await listInvoices(q);
      if (run !== latestLoad.current) return;
      setFees(data);
      setTotalFees(count);
    } catch (e) {
      if (run === latestLoad.current) setFeesError(e);
    } finally {
      if (run === latestLoad.current) setFeesLoading(false);
    }
  };


  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    try {
      await createInvoice(form.student_id, form.type, Number(form.amount), form.due_date, form.academic_year || undefined);
      setForm({ student_id: "", type: "", amount: "", due_date: "", academic_year: "" });
      setShowCreate(false);
      setNotice("Invoice raised.");
      void loadFees(query);
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to raise invoice."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Invoices</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Fee invoices raised across the institution</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Raise Invoice</Button>
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>

      {/* The create dialog shows its own failure. */}
      <ErrorAlert error={!showCreate ? error : null} />

      <DataTable
        columns={[
          { key: "student", header: "Student", render: (row: any) => <span className="font-medium text-on-surface">{(row.students as any)?.profiles?.full_name || "—"}</span> },
          { key: "type", header: "Type", sortable: true },
          { key: "amount", header: "Amount", sortable: true, render: (row: any) => formatMoney(row.amount) },
          { key: "paid_amount", header: "Paid", render: (row: any) => formatMoney(row.paid_amount) },
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
        error={feesError}
        onRetry={() => loadFees(query)}
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
            <Button onClick={handleCreate} disabled={loading || !form.student_id} aria-busy={loading || undefined}>{loading ? "Creating..." : "Raise Invoice"}</Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <div className="space-y-md">
          <StudentSearchField id="student" value={form.student_id} onChange={(v) => setForm({ ...form, student_id: v })} required />
          <FormField label="Fee Type" id="type" value={form.type} onChange={(v) => setForm({ ...form, type: v })} placeholder="e.g. Tuition, Hostel, Exam" required />
          <FormField label="Amount" id="amount" type="number" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} placeholder="0.00" required />
          <FormField label="Due Date" id="due_date" type="date" value={form.due_date} onChange={(v) => setForm({ ...form, due_date: v })} required />
          <FormField label="Academic Year" id="academic_year" value={form.academic_year} onChange={(v) => setForm({ ...form, academic_year: v })} placeholder="e.g. 2025-26" />
        </div>
      </Modal>
    </div>
  );
}
