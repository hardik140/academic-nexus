import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getCached } from "@/lib/cache";
import { computeEffectiveFeeStatus } from "@/lib/finance-status";
import { getFinanceExceptions } from "../exceptions/actions";

export default async function FinanceDashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: viewerProfile } = await supabase
    .from("profiles")
    .select("college_id")
    .eq("id", user.id)
    .single();

  // Fee stats — pulls every fee row to aggregate client-side (a known,
  // already-flagged cost; see Implementation Status.md), so caching this
  // college-scoped result matters more here than almost anywhere else.
  const { totalBilled, totalCollected, totalOverdue, collectionRate } = await getCached(
    `dashboard:finance:${viewerProfile?.college_id}:fee-stats`,
    60,
    async () => {
      const { data: allFees } = await supabase.from("fees").select("amount, paid_amount, status, due_date");
      const totalBilled = allFees?.reduce((s, f) => s + f.amount, 0) || 0;
      const totalCollected = allFees?.reduce((s, f) => s + f.paid_amount, 0) || 0;
      // Computed live — nothing ever sets fees.status = 'overdue' (see
      // lib/finance-status.ts), so a raw status === "overdue" filter here
      // always read zero.
      const totalOverdue = allFees?.filter(f => computeEffectiveFeeStatus(f) === "overdue").reduce((s, f) => s + (f.amount - f.paid_amount), 0) || 0;
      const collectionRate = totalBilled > 0 ? (totalCollected / totalBilled) * 100 : 0;
      return { totalBilled, totalCollected, totalOverdue, collectionRate };
    }
  );

  const exceptions = await getFinanceExceptions();

  // Recent payments
  const { data: recentPayments } = await supabase
    .from("payments")
    .select("*, profiles:student_id(full_name)")
    .order("created_at", { ascending: false })
    .limit(10);

  const formatCurr = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

  const actionItems = [
    { label: "refund request", count: exceptions.refundsAwaitingApproval.length, href: "/finance/refunds", severity: "high" as const },
    { label: "dispute needing attention", count: exceptions.disputesNeedingAttention.length, href: "/finance/disputes", severity: "high" as const },
    { label: "overdue fee", count: exceptions.overdueFees.length, href: "/finance/exceptions", severity: "medium" as const },
    { label: "possible duplicate payment", count: exceptions.duplicatePayments.length, href: "/finance/exceptions", severity: "medium" as const },
    { label: "overpayment", count: exceptions.overpayments.length, href: "/finance/exceptions", severity: "medium" as const },
  ].filter((i) => i.count > 0);

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Finance Dashboard</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Revenue, collections, and transaction management</p>
      </div>

      {/* Action Required — real counts from getFinanceExceptions(), not
          decorative; every item links to the real underlying workflow. */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface">Action Required</h2>
          <span className="text-xs font-semibold text-outline">{actionItems.length} item{actionItems.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="divide-y divide-outline-variant">
          {actionItems.length === 0 ? (
            <div className="p-xl text-center text-sm text-outline">🎉 Nothing needs your attention right now.</div>
          ) : (
            actionItems.map((item, i) => (
              <a
                key={i}
                href={item.href}
                className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors"
              >
                <span className="text-sm text-on-surface">
                  <span className={`font-bold ${item.severity === "high" ? "text-error" : "text-warning"}`}>{item.count}</span>{" "}
                  {item.label}{item.count !== 1 ? "s" : ""}
                </span>
                <span className="text-xs font-semibold text-secondary">View →</span>
              </a>
            ))
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-md">
        <a href="/finance/invoices" className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:border-secondary transition-colors flex items-center gap-md">
          <span className="text-2xl">🧾</span>
          <div>
            <div className="text-sm font-bold text-on-surface">Generate Invoice</div>
            <div className="text-xs text-on-surface-variant">Raise a new fee invoice</div>
          </div>
        </a>
        <a href="/finance/transactions" className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:border-secondary transition-colors flex items-center gap-md">
          <span className="text-2xl">💳</span>
          <div>
            <div className="text-sm font-bold text-on-surface">Record Payment</div>
            <div className="text-xs text-on-surface-variant">Manual receipt entry</div>
          </div>
        </a>
        <a href="/finance/scholarships" className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:border-secondary transition-colors flex items-center gap-md">
          <span className="text-2xl">🎓</span>
          <div>
            <div className="text-sm font-bold text-on-surface">Manage Scholarships</div>
            <div className="text-xs text-on-surface-variant">Review disbursements</div>
          </div>
        </a>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Total Billed</div>
          <div className="text-2xl font-extrabold text-on-surface">{formatCurr(totalBilled)}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Collected</div>
          <div className="text-2xl font-extrabold text-success">{formatCurr(totalCollected)}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Overdue</div>
          <div className="text-2xl font-extrabold text-error">{formatCurr(totalOverdue)}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Collection Rate</div>
          <div className="text-2xl font-extrabold text-secondary">{collectionRate.toFixed(1)}%</div>
          <div className="mt-sm h-1.5 bg-surface-container-high rounded-full overflow-hidden">
            <div className="h-full bg-secondary rounded-full" style={{ width: `${Math.min(collectionRate, 100)}%` }} />
          </div>
        </div>
      </div>

      {/* Recent Payments */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface">Recent Transactions</h2>
          <a href="/finance/transactions" className="text-xs font-medium text-secondary hover:underline">View All →</a>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-low text-on-surface-variant">
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Ref</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Student</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Amount</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Method</th>
                <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {recentPayments && recentPayments.length > 0 ? recentPayments.map((p: any) => (
                <tr key={p.id} className="hover:bg-surface-container-low transition-colors">
                  <td className="px-lg py-md font-mono text-xs text-on-surface-variant">{p.transaction_ref?.slice(0, 12)}...</td>
                  <td className="px-lg py-md font-medium text-on-surface">{(p.profiles as any)?.full_name || "—"}</td>
                  <td className="px-lg py-md text-on-surface">{formatCurr(p.amount)}</td>
                  <td className="px-lg py-md text-on-surface-variant capitalize">{p.method}</td>
                  <td className="px-lg py-md">
                    <span className={`text-xs font-semibold px-sm py-xs rounded-full ${
                      p.status === "cleared" ? "bg-success/10 text-success" :
                      p.status === "pending" ? "bg-warning/10 text-warning" :
                      "bg-error/10 text-error"
                    }`}>{p.status}</span>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={5} className="px-lg py-xl text-center text-outline">No transactions recorded yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
