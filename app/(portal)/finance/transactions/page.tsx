"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { DataTable } from "@/components/ui/data-table";
import { StatusBadge, Button } from "@/components/ui/modal";
import { formatCurrency, formatDate } from "@/lib/utils";

export default function FinanceTransactions() {
  const supabase = createClient();
  const [fees, setFees] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [tab, setTab] = useState<"invoices" | "payments">("invoices");
  const [stats, setStats] = useState({ total: 0, collected: 0, pending: 0, overdue: 0 });

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    const [feesRes, paymentsRes] = await Promise.all([
      supabase.from("fees").select("*, students(enrollment_number, profiles:user_id(full_name))").order("due_date", { ascending: false }),
      supabase.from("payments").select("*, students(enrollment_number, profiles:user_id(full_name))").order("created_at", { ascending: false }),
    ]);
    const f = feesRes.data || [];
    setFees(f);
    setPayments(paymentsRes.data || []);
    setStats({
      total: f.reduce((s, i) => s + (i.amount || 0), 0),
      collected: f.reduce((s, i) => s + (i.paid_amount || 0), 0),
      pending: f.filter(i => i.status === "pending").reduce((s, i) => s + (i.amount - i.paid_amount), 0),
      overdue: f.filter(i => i.status === "overdue").reduce((s, i) => s + (i.amount - i.paid_amount), 0),
    });
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Finance Transactions</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Track fee invoices and payment records</p>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        {[
          { label: "Total Billed", value: formatCurrency(stats.total), color: "text-on-surface" },
          { label: "Collected", value: formatCurrency(stats.collected), color: "text-success" },
          { label: "Pending", value: formatCurrency(stats.pending), color: "text-warning" },
          { label: "Overdue", value: formatCurrency(stats.overdue), color: "text-error" },
        ].map(kpi => (
          <div key={kpi.label} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
            <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">{kpi.label}</div>
            <div className={`text-2xl font-extrabold ${kpi.color}`}>{kpi.value}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-xs border-b border-outline-variant">
        {(["invoices", "payments"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-md py-sm text-sm font-semibold capitalize transition-all border-b-2 -mb-[1px] ${
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
            { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
          ]}
          data={fees}
          keyExtractor={(row) => row.id}
          searchKey="type"
          searchPlaceholder="Search invoices..."
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
        />
      )}
    </div>
  );
}
