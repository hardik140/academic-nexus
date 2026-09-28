"use client";

import { useEffect, useRef, useState } from "react";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { ErrorState } from "@/components/ui/error-state";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { classifyError } from "@/lib/feedback-error";
import { formatCurrency, formatDate } from "@/lib/utils";
import { computeEffectiveFeeStatus } from "@/lib/finance-status";
import { recordPayment, listInvoices, listPayments, getFeeStats } from "./actions";
import type { Database } from "@/types/database";

type PaymentMethod = Database["public"]["Tables"]["payments"]["Row"]["method"];

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "upi", label: "UPI" },
  { value: "netbanking", label: "Net Banking" },
  { value: "cheque", label: "Cheque" },
  { value: "dd", label: "Demand Draft" },
  { value: "scholarship", label: "Scholarship Adjustment" },
  { value: "other", label: "Other" },
];

const INVOICES_PAGE_SIZE = 10;
const PAYMENTS_PAGE_SIZE = 10;

export default function FinanceTransactions() {
  const [fees, setFees] = useState<any[]>([]);
  const [feesLoading, setFeesLoading] = useState(false);
  const [feesError, setFeesError] = useState<unknown>(null);
  const [totalFees, setTotalFees] = useState(0);
  const [feesQuery, setFeesQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });

  const [payments, setPayments] = useState<any[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [paymentsError, setPaymentsError] = useState<unknown>(null);
  const [totalPayments, setTotalPayments] = useState(0);
  const [paymentsQuery, setPaymentsQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });

  const [tab, setTab] = useState<"invoices" | "payments">("invoices");
  const [payFee, setPayFee] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ amount: "", method: "cash" as PaymentMethod, transaction_ref: "", notes: "" });
  const latestFees = useRef(0);
  const latestPayments = useRef(0);
  // One payment per submission: a payment is money, a duplicate is a double charge.
  const recording = useRef(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadFees(feesQuery); }, [feesQuery]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadPayments(paymentsQuery); }, [paymentsQuery]);

  // Cached Server Actions (getCached() needs the server-only Redis token) —
  // stats stays unbounded server-side too (see getFeeStats' comment in
  // actions.ts) but is now at least cached instead of re-summed every load.
  // A failed load is an error, never ₹0 totals (owner decision D5).
  const statsResource = useAsyncResource(() => getFeeStats(), []);
  const stats = statsResource.data;

  // Each table shows the latest query's page; a failed load is an error in
  // the table, never an empty table.
  const loadFees = async (q: DataTableQuery) => {
    const run = ++latestFees.current;
    setFeesLoading(true);
    setFeesError(null);
    try {
      const { data, count } = await listInvoices(q);
      if (run !== latestFees.current) return;
      setFees(data);
      setTotalFees(count);
    } catch (e) {
      if (run === latestFees.current) setFeesError(e);
    } finally {
      if (run === latestFees.current) setFeesLoading(false);
    }
  };

  const loadPayments = async (q: DataTableQuery) => {
    const run = ++latestPayments.current;
    setPaymentsLoading(true);
    setPaymentsError(null);
    try {
      const { data, count } = await listPayments(q);
      if (run !== latestPayments.current) return;
      setPayments(data);
      setTotalPayments(count ?? 0);
    } catch (e) {
      if (run === latestPayments.current) setPaymentsError(e);
    } finally {
      if (run === latestPayments.current) setPaymentsLoading(false);
    }
  };

  const openRecordPayment = (fee: any) => {
    setPayFee(fee);
    setForm({ amount: (fee.amount - fee.paid_amount).toFixed(2), method: "cash", transaction_ref: "", notes: "" });
    setError(null);
  };

  const handleRecordPayment = async () => {
    if (!payFee || recording.current) return;
    recording.current = true;
    setLoading(true);
    setError(null);
    try {
      await recordPayment(payFee.id, Number(form.amount), form.method, form.transaction_ref || undefined, form.notes || undefined, feesQuery, paymentsQuery);
      setNotice(`Payment of ${formatCurrency(Number(form.amount))} recorded for ${payFee.students?.profiles?.full_name || "the student"}.`);
      setPayFee(null);
      // Refreshing the figures is not part of recording: a failure there
      // shows where the figures are, not as a failed payment.
      statsResource.reload();
      void loadFees(feesQuery);
      void loadPayments(paymentsQuery);
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to record payment."));
    } finally {
      recording.current = false;
      setLoading(false);
    }
  };

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Finance Transactions</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Track fee invoices and payment records</p>
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>

      {/* The payment dialog shows its own failure. */}
      <ErrorAlert error={!payFee ? error : null} />

      {/* KPI Row */}
      {statsResource.status === "error" && !stats ? (
        <ErrorState
          {...classifyError(statsResource.error)}
          title="Fee totals couldn't be loaded"
          onRetry={statsResource.reload}
          className="rounded-2xl border border-outline-variant bg-surface-container-lowest"
        />
      ) : (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md" aria-busy={statsResource.status === "loading" || undefined}>
        {[
          { label: "Total Billed", value: stats ? formatCurrency(stats.total) : "—", color: "text-on-surface" },
          { label: "Collected", value: stats ? formatCurrency(stats.collected) : "—", color: "text-success" },
          { label: "Pending", value: stats ? formatCurrency(stats.pending) : "—", color: "text-warning" },
          { label: "Overdue", value: stats ? formatCurrency(stats.overdue) : "—", color: "text-error" },
        ].map(kpi => (
          <div key={kpi.label} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
            <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">{kpi.label}</div>
            <div className={`text-2xl font-extrabold ${kpi.color}`}>{kpi.value}</div>
          </div>
        ))}
      </div>
      )}

      {/* Tabs */}
      <div className="flex gap-xs border-b border-outline-variant">
        {(["invoices", "payments"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-md py-sm text-sm font-semibold capitalize motion-feedback border-b-2 -mb-[1px] ${
              tab === t ? "text-secondary border-secondary" : "text-outline border-transparent hover:text-on-surface-variant"
            }`}>{t}</button>
        ))}
      </div>

      {tab === "invoices" ? (
        <DataTable
          columns={[
            { key: "student", header: "Student", render: (row: any) => <span className="font-medium text-on-surface">{(row.students?.profiles as any)?.full_name || "—"}</span> },
            { key: "enrollment", header: "Enrollment", render: (row: any) => <span className="font-mono text-xs text-on-surface-variant">{row.students?.enrollment_number || "—"}</span> },
            { key: "type", header: "Type", render: (row: any) => <span className="capitalize text-on-surface-variant">{row.type}</span> },
            { key: "amount", header: "Amount", sortable: true, render: (row: any) => <span className="font-semibold">{formatCurrency(row.amount)}</span> },
            { key: "paid_amount", header: "Paid", render: (row: any) => <span className="text-success">{formatCurrency(row.paid_amount)}</span> },
            { key: "due_date", header: "Due Date", sortable: true, render: (row: any) => formatDate(row.due_date) },
            { key: "status", header: "Status", render: (row: any) => <StatusBadge status={computeEffectiveFeeStatus(row)} /> },
          ]}
          data={fees}
          keyExtractor={(row) => row.id}
          searchKey="type"
          searchPlaceholder="Search invoices..."
          serverMode
          totalCount={totalFees}
          loading={feesLoading}
          error={feesError}
          onRetry={() => loadFees(feesQuery)}
          onQueryChange={setFeesQuery}
          pageSize={INVOICES_PAGE_SIZE}
          actions={(row: any) => (
            row.status !== "paid" && row.status !== "waived" && row.status !== "refunded" ? (
              <button onClick={() => openRecordPayment(row)} className="text-xs text-secondary hover:underline font-medium">
                Record Payment
              </button>
            ) : null
          )}
        />
      ) : (
        <DataTable
          columns={[
            { key: "student", header: "Student", render: (row: any) => <span className="font-medium text-on-surface">{(row.students?.profiles as any)?.full_name || "—"}</span> },
            { key: "amount", header: "Amount", sortable: true, render: (row: any) => <span className="font-semibold text-success">{formatCurrency(row.amount)}</span> },
            { key: "method", header: "Method", render: (row: any) => <span className="capitalize text-on-surface-variant">{row.method}</span> },
            { key: "transaction_ref", header: "Ref", render: (row: any) => <span className="font-mono text-xs">{row.transaction_ref || "—"}</span> },
            { key: "receipt_number", header: "Receipt", render: (row: any) => <span className="font-mono text-xs">{row.receipt_number || "—"}</span> },
            { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
            { key: "created_at", header: "Date", sortable: true, render: (row: any) => formatDate(row.created_at) },
          ]}
          data={payments}
          keyExtractor={(row) => row.id}
          searchKey="method"
          searchPlaceholder="Search payments..."
          serverMode
          totalCount={totalPayments}
          loading={paymentsLoading}
          error={paymentsError}
          onRetry={() => loadPayments(paymentsQuery)}
          onQueryChange={setPaymentsQuery}
          pageSize={PAYMENTS_PAGE_SIZE}
        />
      )}

      <Modal
        open={!!payFee}
        onClose={() => setPayFee(null)}
        title={`Record Payment — ${(payFee?.students?.profiles as any)?.full_name || ""}`}
        description={payFee ? `Outstanding balance: ${formatCurrency(payFee.amount - payFee.paid_amount)}` : undefined}
        footer={
          <>
            <Button variant="outline" onClick={() => setPayFee(null)}>Cancel</Button>
            <Button onClick={handleRecordPayment} disabled={loading || !form.amount} aria-busy={loading || undefined}>{loading ? "Recording..." : "Record Payment"}</Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <div className="space-y-md">
          <FormField label="Amount" id="pay_amount" type="number" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} placeholder="0.00" required />
          <FormField label="Method" id="pay_method" type="select" value={form.method} onChange={(v) => setForm({ ...form, method: v as PaymentMethod })} options={PAYMENT_METHODS} required />
          <FormField label="Transaction Reference" id="pay_ref" value={form.transaction_ref} onChange={(v) => setForm({ ...form, transaction_ref: v })} placeholder="Optional" />
          <FormField label="Notes" id="pay_notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} placeholder="Optional" />
        </div>
      </Modal>
    </div>
  );
}
