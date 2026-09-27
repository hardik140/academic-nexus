import { formatCurrency } from "@/lib/utils";
import { getFinanceExceptions, type ExceptionEntry } from "./actions";

function ExceptionSection({
  icon,
  title,
  severity,
  items,
  emptyMessage,
  showAmount = true,
}: {
  icon: string;
  title: string;
  severity: "high" | "medium";
  items: ExceptionEntry[];
  emptyMessage: string;
  showAmount?: boolean;
}) {
  return (
    <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
      <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
        <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">
          {icon} {title}
        </h2>
        <span className={`text-xs font-semibold px-sm py-xs rounded-full ${severity === "high" ? "bg-error/10 text-error" : "bg-warning/10 text-warning"}`}>
          {items.length}
        </span>
      </div>
      <div className="divide-y divide-outline-variant">
        {items.length > 0 ? items.map((item) => (
          <div key={item.id} className="flex items-center justify-between px-lg py-md">
            <div>
              <div className="text-sm font-medium text-on-surface">{item.studentName} <span className="text-xs text-outline">— {item.enrollmentNumber}</span></div>
              <div className="text-xs text-outline mt-xs">{item.detail}</div>
            </div>
            {showAmount && <div className="text-sm font-bold text-on-surface font-mono">{formatCurrency(item.amount)}</div>}
          </div>
        )) : (
          <div className="p-xl text-center text-sm text-outline">{emptyMessage}</div>
        )}
      </div>
    </div>
  );
}

export default async function FinanceExceptions() {
  const exceptions = await getFinanceExceptions();
  const totalCount =
    exceptions.overdueFees.length +
    exceptions.duplicatePayments.length +
    exceptions.overpayments.length +
    exceptions.refundsAwaitingApproval.length +
    exceptions.disputesNeedingAttention.length;

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Finance Exception Center</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          {totalCount > 0 ? `${totalCount} item${totalCount !== 1 ? "s" : ""} requiring review` : "Nothing requires review right now"}
        </p>
      </div>

      <ExceptionSection
        icon="🔴"
        title="Refunds Awaiting Approval"
        severity="high"
        items={exceptions.refundsAwaitingApproval}
        emptyMessage="No refund requests pending."
      />
      <ExceptionSection
        icon="🔴"
        title="Disputes Needing Attention"
        severity="high"
        items={exceptions.disputesNeedingAttention}
        showAmount={false}
        emptyMessage="No open financial disputes."
      />
      <ExceptionSection
        icon="🟠"
        title="Overdue Fees"
        severity="medium"
        items={exceptions.overdueFees}
        emptyMessage="No overdue fees."
      />
      <ExceptionSection
        icon="🟠"
        title="Possible Duplicate Payments"
        severity="medium"
        items={exceptions.duplicatePayments}
        emptyMessage="No duplicate-payment risk detected."
      />
      <ExceptionSection
        icon="🟠"
        title="Overpayments"
        severity="medium"
        items={exceptions.overpayments}
        emptyMessage="No overpayments detected."
      />
    </div>
  );
}
