"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { getCached } from "@/lib/cache";
import { PERMISSIONS } from "@/lib/permissions";
import { computeEffectiveFeeStatus, detectDuplicatePaymentRisk } from "@/lib/finance-status";
import { assertRead } from "@/lib/read-result-server";

export interface ExceptionEntry {
  id: string;
  studentName: string;
  enrollmentNumber: string;
  amount: number;
  detail: string;
}

export interface FinanceExceptions {
  overdueFees: ExceptionEntry[];
  duplicatePayments: ExceptionEntry[];
  overpayments: ExceptionEntry[];
  refundsAwaitingApproval: ExceptionEntry[];
  disputesNeedingAttention: ExceptionEntry[];
}

/**
 * Finance Exception Center — computed live from real data only, cached 30s
 * (money being actively managed, same short TTL rationale as
 * transactions/actions.ts's getFeeStats). Deliberately does NOT include a
 * "stuck/unreconciled payment" category: recordPaymentCore hardcodes every
 * insert to status 'cleared', so nothing anywhere ever produces a
 * pending/failed payment row — that check would always read zero, the same
 * dead-code mistake this module fixes for `overdue` (see
 * lib/finance-status.ts).
 */
export async function getFinanceExceptions(): Promise<FinanceExceptions> {
  const actor = await requireRole(PERMISSIONS.finance_exceptions_read);
  const supabase = await createClient();

  return getCached(`finance:exceptions:${actor.collegeId}`, 30, async () => {
    const [feesRes, paymentsRes, refundsRes, disputesRes] = await Promise.all([
      supabase
        .from("fees")
        .select("id, amount, paid_amount, status, due_date, student_id, students:student_id(enrollment_number, profiles:user_id(full_name))")
        .eq("college_id", actor.collegeId),
      supabase
        .from("payments")
        .select("id, fee_id, student_id, amount, status, created_at, students(enrollment_number, profiles:user_id(full_name))")
        .eq("college_id", actor.collegeId),
      supabase
        .from("refund_requests")
        .select("id, amount, reason, student_id, students:student_id(enrollment_number, profiles:user_id(full_name))")
        .eq("college_id", actor.collegeId)
        .eq("status", "pending"),
      supabase
        .from("financial_disputes")
        .select("id, description, student_id, status, students:student_id(enrollment_number, profiles:user_id(full_name))")
        .eq("college_id", actor.collegeId)
        .in("status", ["submitted", "under_investigation"]),
    ]);
    assertRead(feesRes.error);
    assertRead(paymentsRes.error);
    assertRead(refundsRes.error);
    assertRead(disputesRes.error);

    // Cast to any: this hand-maintained types file declares empty
    // Relationships for every table, so embedded joins can't be inferred —
    // same pattern used throughout the rest of the app.
    const fees = (feesRes.data || []) as any[];
    const payments = (paymentsRes.data || []) as any[];
    const refunds = (refundsRes.data || []) as any[];
    const disputes = (disputesRes.data || []) as any[];

    const studentLabel = (row: any) => ({
      name: row.students?.profiles?.full_name || "Unknown",
      enrollment: row.students?.enrollment_number || "—",
    });

    const overdueFees: ExceptionEntry[] = fees
      .filter((f) => computeEffectiveFeeStatus(f) === "overdue")
      .map((f) => {
        const { name, enrollment } = studentLabel(f);
        return {
          id: f.id,
          studentName: name,
          enrollmentNumber: enrollment,
          amount: f.amount - f.paid_amount,
          detail: `Due ${f.due_date}`,
        };
      });

    const feeById = new Map(fees.map((f) => [f.id, f]));
    const paymentById = new Map(payments.map((p) => [p.id, p]));

    const duplicateGroups = detectDuplicatePaymentRisk(payments);
    const duplicatePayments: ExceptionEntry[] = duplicateGroups.map((g, i) => {
      const firstPayment = paymentById.get(g.paymentIds[0]) || {};
      const { name, enrollment } = studentLabel(firstPayment);
      return {
        id: `dup-${i}`,
        studentName: name,
        enrollmentNumber: enrollment,
        amount: g.amount,
        detail: `${g.paymentIds.length} payments of the same amount on ${g.date}`,
      };
    });

    const clearedByFee = new Map<string, number>();
    for (const p of payments) {
      if (p.status !== "cleared") continue;
      clearedByFee.set(p.fee_id, (clearedByFee.get(p.fee_id) || 0) + p.amount);
    }
    const overpayments: ExceptionEntry[] = [];
    for (const [feeId, sum] of clearedByFee.entries()) {
      const fee = feeById.get(feeId);
      if (fee && sum > fee.amount) {
        const { name, enrollment } = studentLabel(fee);
        overpayments.push({
          id: feeId,
          studentName: name,
          enrollmentNumber: enrollment,
          amount: sum - fee.amount,
          detail: `Paid ${sum.toFixed(2)} against a ${fee.amount.toFixed(2)} fee`,
        });
      }
    }

    const refundsAwaitingApproval: ExceptionEntry[] = refunds.map((r) => {
      const { name, enrollment } = studentLabel(r);
      return { id: r.id, studentName: name, enrollmentNumber: enrollment, amount: r.amount, detail: r.reason };
    });

    const disputesNeedingAttention: ExceptionEntry[] = disputes.map((d) => {
      const { name, enrollment } = studentLabel(d);
      return { id: d.id, studentName: name, enrollmentNumber: enrollment, amount: 0, detail: d.description };
    });

    return { overdueFees, duplicatePayments, overpayments, refundsAwaitingApproval, disputesNeedingAttention };
  });
}
