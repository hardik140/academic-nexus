import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { formatCurrency } from "@/lib/utils";
import { getCached } from "@/lib/cache";
import { computeEffectiveFeeStatus } from "@/lib/finance-status";

export default async function FinanceReports() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: viewerProfile } = await supabase
    .from("profiles")
    .select("college_id")
    .eq("id", user.id)
    .single();

  // NOTE: `fees` is intentionally unbounded — the department/status breakdowns
  // below sum over the full result set client-side. A naive .limit() would
  // silently understate totals past the cap. Real fix is pushing this
  // aggregation into Postgres (extend mv_fee_summary or add a grouped view);
  // same deferred issue as finance/transactions.tsx. Caching this college-
  // scoped result at least keeps that full-table pull off the hot path.
  const { summary, fees } = await getCached(
    `reports:finance:${viewerProfile?.college_id}:mv`,
    60,
    async () => {
      const [summaryRes, feesRes] = await Promise.all([
        supabase.from("mv_fee_summary").select("*").maybeSingle(),
        supabase.from("fees").select("amount, paid_amount, status, due_date, students(departments(name, code))"),
      ]);
      return { summary: summaryRes.data, fees: feesRes.data || [] };
    }
  );

  // Department-wise breakdown
  const byDept: Record<string, { name: string; code: string; billed: number; collected: number }> = {};
  fees.forEach((f: any) => {
    const dept = f.students?.departments;
    if (!dept) return;
    const key = dept.code;
    if (!byDept[key]) byDept[key] = { name: dept.name, code: dept.code, billed: 0, collected: 0 };
    byDept[key].billed += f.amount;
    byDept[key].collected += f.paid_amount;
  });
  const deptBreakdown = Object.values(byDept);

  // Status breakdown — computed live (computeEffectiveFeeStatus), since
  // mv_fee_summary's total_overdue and the raw stored status both inherit
  // the same dead-'overdue' problem documented in lib/finance-status.ts.
  const statusCounts: Record<string, number> = {};
  let totalOutstandingOverdue = 0;
  fees.forEach((f: any) => {
    const effective = computeEffectiveFeeStatus(f);
    statusCounts[effective] = (statusCounts[effective] || 0) + 1;
    if (effective === "overdue") totalOutstandingOverdue += f.amount - f.paid_amount;
  });

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Financial Reports</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Collection performance across departments</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Total Billed</div>
          <div className="text-2xl font-extrabold text-on-surface">{formatCurrency(summary?.total_billed || 0)}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Total Collected</div>
          <div className="text-2xl font-extrabold text-success">{formatCurrency(summary?.total_collected || 0)}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Outstanding (Overdue)</div>
          <div className="text-2xl font-extrabold text-error">{formatCurrency(totalOutstandingOverdue)}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Collection Rate</div>
          <div className="text-2xl font-extrabold text-secondary">{summary?.collection_pct || 0}%</div>
        </div>
      </div>

      {/* Department Breakdown */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Collection by Department</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {deptBreakdown.length > 0 ? deptBreakdown.map((d) => {
            const pct = d.billed > 0 ? (d.collected / d.billed) * 100 : 0;
            return (
              <div key={d.code} className="px-lg py-md">
                <div className="flex items-center justify-between mb-sm">
                  <div>
                    <span className="text-sm font-semibold text-on-surface">{d.code}</span>
                    <span className="text-xs text-outline ml-sm">{d.name}</span>
                  </div>
                  <span className="text-sm font-bold text-on-surface">{formatCurrency(d.collected)} / {formatCurrency(d.billed)}</span>
                </div>
                <div className="h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-secondary transition-all duration-700" style={{ width: `${Math.min(pct, 100)}%` }} />
                </div>
              </div>
            );
          }) : (
            <div className="p-xl text-center text-sm text-outline">No fee data available yet.</div>
          )}
        </div>
      </div>

      {/* Status Breakdown */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Invoices by Status</h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-md p-lg">
          {Object.entries(statusCounts).map(([status, count]) => (
            <div key={status} className="flex items-center justify-between px-md py-sm bg-surface-container-low rounded-xl">
              <span className="text-xs font-semibold text-on-surface-variant capitalize">{status}</span>
              <span className="text-sm font-bold text-on-surface">{count}</span>
            </div>
          ))}
          {Object.keys(statusCounts).length === 0 && (
            <div className="col-span-full text-center text-sm text-outline py-md">No invoices yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
