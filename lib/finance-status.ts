/**
 * Pure, deterministic finance-status helpers — no AI, no DB access.
 *
 * `fees.status = 'overdue'` is a dead value: nothing in this app (no cron,
 * no trigger) ever sets it — the only status-setting code is
 * update_fee_on_payment() (migration 003, sets 'paid'/'partial') and the
 * 'pending' insert default. Every KPI/report that filtered on
 * `status === 'overdue'` was therefore always reading zero. This computes
 * the effective status live from due_date instead, same "computed, not
 * stored" precedent as Late Return / Pending Exit Verification (warden
 * increment) and Faculty Workload (hod increment).
 */

export interface FeeForStatus {
  status: "pending" | "paid" | "overdue" | "partial" | "waived" | "refunded";
  due_date: string;
  amount: number;
  paid_amount: number;
}

export type EffectiveFeeStatus = FeeForStatus["status"];

export function computeEffectiveFeeStatus(fee: FeeForStatus, today: Date = new Date()): EffectiveFeeStatus {
  // Terminal/authoritative states finance has explicitly set — never
  // overridden by the live due-date check below.
  if (fee.status === "paid" || fee.status === "waived" || fee.status === "refunded") {
    return fee.status;
  }

  const outstanding = fee.amount - fee.paid_amount;
  const todayStr = today.toISOString().slice(0, 10);
  if (outstanding > 0 && fee.due_date < todayStr) {
    return "overdue";
  }

  return fee.status;
}

export interface PaymentForDuplicateCheck {
  id: string;
  student_id: string;
  fee_id: string;
  amount: number;
  status: "cleared" | "pending" | "failed" | "refunded";
  created_at: string;
}

export interface DuplicatePaymentGroup {
  studentId: string;
  feeId: string;
  amount: number;
  date: string;
  paymentIds: string[];
}

/**
 * Deterministic possible-duplicate-payment rule (spec section 20: same
 * student + same fee + same amount + same date -> flag), no AI. Only
 * considers `cleared` payments — a failed/pending/refunded row isn't a live
 * double-charge risk.
 */
export function detectDuplicatePaymentRisk(payments: PaymentForDuplicateCheck[]): DuplicatePaymentGroup[] {
  const groups = new Map<string, DuplicatePaymentGroup>();

  for (const p of payments) {
    if (p.status !== "cleared") continue;
    const date = p.created_at.slice(0, 10);
    const key = `${p.student_id}:${p.fee_id}:${p.amount}:${date}`;
    const existing = groups.get(key);
    if (existing) {
      existing.paymentIds.push(p.id);
    } else {
      groups.set(key, { studentId: p.student_id, feeId: p.fee_id, amount: p.amount, date, paymentIds: [p.id] });
    }
  }

  return Array.from(groups.values()).filter((g) => g.paymentIds.length > 1);
}
