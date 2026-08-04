import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { formatCurrency, formatDate } from "@/lib/utils";

export default async function ParentFees() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("email").eq("id", user.id).single();

  const { data: children } = await supabase
    .from("students")
    .select("id, profiles:user_id(full_name)")
    .eq("parent_email", profile?.email || "");

  const child = (children || [])[0];

  const { data: fees } = child
    ? await supabase.from("fees").select("*").eq("student_id", child.id).order("due_date", { ascending: false })
    : { data: [] };

  const totalBilled = (fees || []).reduce((s, f) => s + f.amount, 0);
  const totalPaid = (fees || []).reduce((s, f) => s + f.paid_amount, 0);
  const totalDue = totalBilled - totalPaid;

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Fees</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          {child ? `${(child.profiles as any)?.full_name}'s fee statement` : "Linked child's fee statement"}
        </p>
      </div>

      {child ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-md">
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
              <div className={`text-2xl font-extrabold ${totalDue > 0 ? "text-warning" : "text-success"}`}>{formatCurrency(totalDue)}</div>
            </div>
          </div>

          <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
            <div className="px-lg py-md border-b border-outline-variant">
              <h2 className="text-sm font-bold text-on-surface">Fee Invoices</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-container-low text-on-surface-variant">
                    <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Type</th>
                    <th className="text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider">Amount</th>
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
                      <td className="px-lg py-md font-semibold text-on-surface">{formatCurrency(f.amount - f.paid_amount)}</td>
                      <td className="px-lg py-md text-on-surface-variant">{formatDate(f.due_date)}</td>
                      <td className="px-lg py-md">
                        <span className={`text-xs font-semibold px-sm py-xs rounded-full capitalize ${
                          f.status === "paid" ? "bg-success/10 text-success" :
                          f.status === "overdue" ? "bg-error/10 text-error" :
                          f.status === "partial" ? "bg-warning/10 text-warning" : "bg-info/10 text-info"
                        }`}>{f.status}</span>
                      </td>
                    </tr>
                  ))}
                  {(fees || []).length === 0 && (
                    <tr><td colSpan={5} className="px-lg py-xl text-center text-outline">No fee records found.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-2xl text-center text-sm text-outline">
          No linked child found for this account.
        </div>
      )}
    </div>
  );
}
