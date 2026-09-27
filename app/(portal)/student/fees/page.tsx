import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { formatCurrency, formatDate } from "@/lib/utils";
import { StatusBadge } from "@/components/ui/modal";
import { computeEffectiveFeeStatus } from "@/lib/finance-status";
import { FinanceRequestsPanel } from "./finance-requests-panel";

export default async function StudentFees() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: student } = await supabase.from("students").select("id").eq("user_id", user.id).single();

  const { data: fees } = await supabase
    .from("fees")
    .select("*")
    .eq("student_id", student?.id || "")
    .order("due_date", { ascending: false });

  const { data: payments } = await supabase
    .from("payments")
    .select("*")
    .eq("student_id", student?.id || "")
    .order("created_at", { ascending: false });

  const totalBilled = (fees || []).reduce((s, f) => s + f.amount, 0);
  const totalPaid = (fees || []).reduce((s, f) => s + f.paid_amount, 0);
  const totalDue = totalBilled - totalPaid;
  // Computed live — nothing ever sets fees.status = 'overdue' (see
  // lib/finance-status.ts), so a raw status === "overdue" filter here
  // always read zero.
  const overdueFees = (fees || []).filter(f => computeEffectiveFeeStatus(f) === "overdue");

  const eligiblePayments = (payments || []).filter((p) => p.status === "cleared");

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Fee Statement</h1>
        <p className="text-sm text-on-surface-variant mt-xs">View invoices, payments, and outstanding balances</p>
      </div>

      {/* Fee KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Total Billed</div>
          <div className="text-2xl font-extrabold text-on-surface">{formatCurrency(totalBilled)}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Total Paid</div>
          <div className="text-2xl font-extrabold text-success">{formatCurrency(totalPaid)}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Outstanding</div>
          <div className={`text-2xl font-extrabold ${totalDue > 0 ? "text-warning" : "text-success"}`}>
            {formatCurrency(totalDue)}
          </div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Overdue</div>
          <div className="text-2xl font-extrabold text-error">{overdueFees.length} invoices</div>
        </div>
      </div>

      {/* Outstanding balance banner + decorative Pay Now (no payment gateway wired up yet) */}
      {totalDue > 0 && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm flex items-center justify-between gap-md flex-wrap">
          <div>
            <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-xs">Outstanding Balance</div>
            <div className="text-3xl font-extrabold text-error font-mono">{formatCurrency(totalDue)}</div>
          </div>
          <div className="text-right">
            <button
              disabled
              title="Online payments aren't wired up yet — pay through the finance office for now."
              className="px-lg py-md bg-secondary/40 text-on-secondary rounded-xl font-semibold text-sm cursor-not-allowed"
            >
              Pay Now
            </button>
            <div className="text-[11px] text-outline mt-xs">Online payments coming soon</div>
          </div>
        </div>
      )}

      {/* Fee Invoices */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🧾 Fee Invoices</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-low text-on-surface-variant">
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Type</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Amount</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Paid</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Balance</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Due Date</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {(fees || []).map((f: any) => (
                <tr key={f.id} className="hover:bg-surface-container-low transition-colors">
                  <td className="px-lg py-md font-medium text-on-surface">{f.type}</td>
                  <td className="px-lg py-md text-on-surface-variant">{formatCurrency(f.amount)}</td>
                  <td className="px-lg py-md text-success">{formatCurrency(f.paid_amount)}</td>
                  <td className="px-lg py-md font-semibold text-on-surface">{formatCurrency(f.amount - f.paid_amount)}</td>
                  <td className="px-lg py-md text-on-surface-variant">{formatDate(f.due_date)}</td>
                  <td className="px-lg py-md"><StatusBadge status={computeEffectiveFeeStatus(f)} /></td>
                </tr>
              ))}
              {(!fees || fees.length === 0) && (
                <tr><td colSpan={6} className="px-lg py-xl text-center text-outline">No fee records found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Payment History */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">💳 Payment History</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {(payments || []).map((p: any) => (
            <div key={p.id} className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
              <div>
                <div className="text-sm font-medium text-on-surface">{formatCurrency(p.amount)}</div>
                <div className="text-xs text-outline">{p.method} • Ref: {p.transaction_ref || "—"}</div>
              </div>
              <div className="text-right">
                <StatusBadge status={p.status} />
                <div className="text-[10px] text-outline mt-xs">{formatDate(p.created_at)}</div>
              </div>
            </div>
          ))}
          {(!payments || payments.length === 0) && (
            <div className="p-xl text-center text-sm text-outline">No payments recorded yet.</div>
          )}
        </div>
      </div>

      <FinanceRequestsPanel
        payments={eligiblePayments.map((p) => ({ id: p.id, amount: p.amount, method: p.method, created_at: p.created_at }))}
        fees={(fees || []).map((f) => ({ id: f.id, type: f.type, due_date: f.due_date }))}
      />
    </div>
  );
}
