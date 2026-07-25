import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function FinanceDashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();

  // Fee stats
  const { data: allFees } = await supabase.from("fees").select("amount, paid_amount, status");
  const totalBilled = allFees?.reduce((s, f) => s + f.amount, 0) || 0;
  const totalCollected = allFees?.reduce((s, f) => s + f.paid_amount, 0) || 0;
  const totalOverdue = allFees?.filter(f => f.status === "overdue").reduce((s, f) => s + (f.amount - f.paid_amount), 0) || 0;
  const collectionRate = totalBilled > 0 ? (totalCollected / totalBilled) * 100 : 0;

  // Recent payments
  const { data: recentPayments } = await supabase
    .from("payments")
    .select("*, profiles:student_id(full_name)")
    .order("created_at", { ascending: false })
    .limit(10);

  const formatCurr = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Finance Dashboard</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Revenue, collections, and transaction management</p>
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
