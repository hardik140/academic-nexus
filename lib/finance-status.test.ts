import { describe, it, expect } from "vitest";
import { computeEffectiveFeeStatus, detectDuplicatePaymentRisk, type FeeForStatus, type PaymentForDuplicateCheck } from "@/lib/finance-status";

const baseFee: FeeForStatus = {
  status: "pending",
  due_date: "2026-03-10",
  amount: 1000,
  paid_amount: 0,
};

describe("computeEffectiveFeeStatus", () => {
  it("returns overdue when due_date is in the past and outstanding > 0", () => {
    const today = new Date("2026-03-11T00:00:00Z");
    expect(computeEffectiveFeeStatus(baseFee, today)).toBe("overdue");
  });

  it("does not flip to overdue on the due date itself", () => {
    const today = new Date("2026-03-10T00:00:00Z");
    expect(computeEffectiveFeeStatus(baseFee, today)).toBe("pending");
  });

  it("does not flip to overdue the day before due", () => {
    const today = new Date("2026-03-09T00:00:00Z");
    expect(computeEffectiveFeeStatus(baseFee, today)).toBe("pending");
  });

  it("keeps partial status live-overdue the same way pending does", () => {
    const partial: FeeForStatus = { ...baseFee, status: "partial", paid_amount: 400 };
    const today = new Date("2026-03-15T00:00:00Z");
    expect(computeEffectiveFeeStatus(partial, today)).toBe("overdue");
  });

  it("never overrides paid, even when due_date is long past", () => {
    const paid: FeeForStatus = { ...baseFee, status: "paid", paid_amount: 1000 };
    const today = new Date("2026-06-01T00:00:00Z");
    expect(computeEffectiveFeeStatus(paid, today)).toBe("paid");
  });

  it("never overrides waived", () => {
    const waived: FeeForStatus = { ...baseFee, status: "waived" };
    const today = new Date("2026-06-01T00:00:00Z");
    expect(computeEffectiveFeeStatus(waived, today)).toBe("waived");
  });

  it("never overrides refunded", () => {
    const refunded: FeeForStatus = { ...baseFee, status: "refunded", paid_amount: 0 };
    const today = new Date("2026-06-01T00:00:00Z");
    expect(computeEffectiveFeeStatus(refunded, today)).toBe("refunded");
  });

  it("does not flag overdue when outstanding is zero despite a stale status", () => {
    const fullyPaidButStillPending: FeeForStatus = { ...baseFee, status: "pending", paid_amount: 1000 };
    const today = new Date("2026-06-01T00:00:00Z");
    expect(computeEffectiveFeeStatus(fullyPaidButStillPending, today)).toBe("pending");
  });
});

function payment(overrides: Partial<PaymentForDuplicateCheck>): PaymentForDuplicateCheck {
  return {
    id: "p1",
    student_id: "s1",
    fee_id: "f1",
    amount: 500,
    status: "cleared",
    created_at: "2026-03-10T10:00:00Z",
    ...overrides,
  };
}

describe("detectDuplicatePaymentRisk", () => {
  it("flags two same-day, same-amount, same-fee payments as a duplicate group", () => {
    const payments = [
      payment({ id: "p1", created_at: "2026-03-10T09:00:00Z" }),
      payment({ id: "p2", created_at: "2026-03-10T15:00:00Z" }),
    ];
    const groups = detectDuplicatePaymentRisk(payments);
    expect(groups).toHaveLength(1);
    expect(groups[0].paymentIds.sort()).toEqual(["p1", "p2"]);
  });

  it("does not flag payments made on different days", () => {
    const payments = [
      payment({ id: "p1", created_at: "2026-03-10T09:00:00Z" }),
      payment({ id: "p2", created_at: "2026-03-11T09:00:00Z" }),
    ];
    expect(detectDuplicatePaymentRisk(payments)).toHaveLength(0);
  });

  it("does not flag payments with different amounts", () => {
    const payments = [
      payment({ id: "p1", amount: 500 }),
      payment({ id: "p2", amount: 600 }),
    ];
    expect(detectDuplicatePaymentRisk(payments)).toHaveLength(0);
  });

  it("does not flag a single payment", () => {
    expect(detectDuplicatePaymentRisk([payment({})])).toHaveLength(0);
  });

  it("ignores non-cleared payments", () => {
    const payments = [
      payment({ id: "p1", status: "cleared" }),
      payment({ id: "p2", status: "refunded" }),
    ];
    expect(detectDuplicatePaymentRisk(payments)).toHaveLength(0);
  });

  it("groups a 3-way duplicate into one group with all three ids", () => {
    const payments = [
      payment({ id: "p1" }),
      payment({ id: "p2" }),
      payment({ id: "p3" }),
    ];
    const groups = detectDuplicatePaymentRisk(payments);
    expect(groups).toHaveLength(1);
    expect(groups[0].paymentIds.sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("does not cross-contaminate different students or fees", () => {
    const payments = [
      payment({ id: "p1", student_id: "s1" }),
      payment({ id: "p2", student_id: "s2" }),
      payment({ id: "p3", fee_id: "f2" }),
    ];
    expect(detectDuplicatePaymentRisk(payments)).toHaveLength(0);
  });
});
