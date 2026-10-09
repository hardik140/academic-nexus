import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { formatMoney } from "@/lib/format";
import { getCached } from "@/lib/cache";
import { assertRead } from "@/lib/read-result-server";
import { businessRpc, num } from "@/lib/business-rpc";

export default async function FinanceReports() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: viewerProfile, error: viewerProfileError } = await supabase
    .from("profiles")
    .select("college_id")
    .eq("id", user.id)
    .single();
  assertRead(viewerProfileError);

  // Both breakdowns are computed in PostgreSQL (migration 059,
  // fee_department_breakdown and fee_status_breakdown), over EVERY fee of
  // the college. This page used to select every fee row and sum here; past
  // PostgREST's 1,000-row cap the department totals, status counts and the
  // overdue outstanding were silently low. The effective status is
  // lib/finance-status.ts's rule, in SQL (parity-tested).
  const collegeId = viewerProfile?.college_id ?? "";
  const { summary, deptBreakdown, statusRows } = await getCached(
    `reports:finance:${viewerProfile?.college_id}:mv`,
    60,
    async () => {
      const [summaryRes, deptRows, statusRows] = await Promise.all([
        supabase.from("mv_fee_summary").select("*").maybeSingle(),
        businessRpc<{ department_name: string; department_code: string; billed: number | string; collected: number | string }>(
          supabase,
          "fee_department_breakdown",
          { p_college_id: collegeId }
        ),
        businessRpc<{ effective_status: string; fee_count: number | string; outstanding: number | string }>(
          supabase,
          "fee_status_breakdown",
          { p_college_id: collegeId }
        ),
      ]);
      assertRead(summaryRes.error);
      return {
        summary: summaryRes.data,
        deptBreakdown: deptRows.map((d) => ({ name: d.department_name, code: d.department_code, billed: num(d.billed), collected: num(d.collected) })),
        statusRows: statusRows.map((s) => ({ status: s.effective_status, count: num(s.fee_count), outstanding: num(s.outstanding) })),
      };
    }
  );

  const statusCounts: Record<string, number> = Object.fromEntries(statusRows.map((s) => [s.status, s.count]));
  const totalOutstandingOverdue = statusRows.find((s) => s.status === "overdue")?.outstanding ?? 0;

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Financial Reports</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Collection performance across departments</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Total Billed</div>
          <div className="text-2xl font-extrabold text-on-surface">{formatMoney(summary?.total_billed || 0)}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Total Collected</div>
          <div className="text-2xl font-extrabold text-success">{formatMoney(summary?.total_collected || 0)}</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-sm">Outstanding (Overdue)</div>
          <div className="text-2xl font-extrabold text-error">{formatMoney(totalOutstandingOverdue)}</div>
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
                  <span className="text-sm font-bold text-on-surface">{formatMoney(d.collected)} / {formatMoney(d.billed)}</span>
                </div>
                <div className="h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-secondary" style={{ width: `${Math.min(pct, 100)}%` }} />
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
