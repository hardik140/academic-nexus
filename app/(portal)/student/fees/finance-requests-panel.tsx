"use client";

import { useState, useEffect } from "react";
import { Button, FormField, StatusBadge } from "@/components/ui/modal";
import { formatCurrency } from "@/lib/utils";
import { requestRefund, listMyRefundRequests, submitDispute, listMyDisputes } from "./actions";

interface EligiblePayment {
  id: string;
  amount: number;
  method: string;
  created_at: string;
}

interface FeeOption {
  id: string;
  type: string;
  due_date: string;
}

export function FinanceRequestsPanel({ payments, fees }: { payments: EligiblePayment[]; fees: FeeOption[] }) {
  const [refunds, setRefunds] = useState<any[]>([]);
  const [disputes, setDisputes] = useState<any[]>([]);

  const [showRefundForm, setShowRefundForm] = useState(false);
  const [refundPaymentId, setRefundPaymentId] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundError, setRefundError] = useState<string | null>(null);
  const [submittingRefund, setSubmittingRefund] = useState(false);

  const [showDisputeForm, setShowDisputeForm] = useState(false);
  const [disputeFeeId, setDisputeFeeId] = useState("");
  const [disputeDescription, setDisputeDescription] = useState("");
  const [disputeError, setDisputeError] = useState<string | null>(null);
  const [submittingDispute, setSubmittingDispute] = useState(false);

  const load = async () => {
    const [r, d] = await Promise.all([listMyRefundRequests(), listMyDisputes()]);
    setRefunds(r);
    setDisputes(d);
  };

  useEffect(() => { load(); }, []);

  const hasPendingRefund = (paymentId: string) => refunds.some((r) => r.payment_id === paymentId && r.status === "pending");

  const handleRefundSubmit = async () => {
    setSubmittingRefund(true);
    setRefundError(null);
    try {
      await requestRefund(refundPaymentId, Number(refundAmount), refundReason);
      setRefundPaymentId("");
      setRefundAmount("");
      setRefundReason("");
      setShowRefundForm(false);
      await load();
    } catch (e) {
      setRefundError(e instanceof Error ? e.message : "Failed to submit refund request.");
    } finally {
      setSubmittingRefund(false);
    }
  };

  const handleDisputeSubmit = async () => {
    setSubmittingDispute(true);
    setDisputeError(null);
    try {
      await submitDispute(disputeFeeId || null, null, disputeDescription);
      setDisputeFeeId("");
      setDisputeDescription("");
      setShowDisputeForm(false);
      await load();
    } catch (e) {
      setDisputeError(e instanceof Error ? e.message : "Failed to submit dispute.");
    } finally {
      setSubmittingDispute(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-md">
      {/* Refunds */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">💸 Refund Requests</h2>
          {payments.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => setShowRefundForm(!showRefundForm)}>
              {showRefundForm ? "Cancel" : "Request Refund"}
            </Button>
          )}
        </div>

        {refundError && (
          <div className="mx-lg mt-md bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{refundError}</div>
        )}

        {showRefundForm && (
          <div className="p-lg space-y-md">
            <FormField
              label="Payment to refund"
              id="refund-payment"
              type="select"
              value={refundPaymentId}
              onChange={setRefundPaymentId}
              required
              options={payments
                .filter((p) => !hasPendingRefund(p.id))
                .map((p) => ({ value: p.id, label: `${formatCurrency(p.amount)} — ${p.method} — ${new Date(p.created_at).toLocaleDateString()}` }))}
            />
            <FormField label="Refund amount" id="refund-amount" type="number" value={refundAmount} onChange={setRefundAmount} required placeholder="0.00" />
            <FormField label="Reason" id="refund-reason" type="textarea" value={refundReason} onChange={setRefundReason} required rows={3} placeholder="Why are you requesting this refund?" />
            <div className="flex justify-end">
              <Button size="sm" onClick={handleRefundSubmit} disabled={submittingRefund || !refundPaymentId || !refundAmount || !refundReason.trim()}>
                {submittingRefund ? "Submitting..." : "Submit Request"}
              </Button>
            </div>
          </div>
        )}

        <div className="divide-y divide-outline-variant">
          {refunds.length > 0 ? refunds.map((r: any) => (
            <div key={r.id} className="flex items-center justify-between px-lg py-md">
              <div>
                <div className="text-sm text-on-surface">{formatCurrency(r.amount)}</div>
                <div className="text-xs text-outline mt-xs">
                  {new Date(r.created_at).toLocaleDateString()}
                  {r.review_notes ? ` — ${r.review_notes}` : ""}
                </div>
              </div>
              <StatusBadge status={r.status} />
            </div>
          )) : (
            <div className="p-lg text-center text-xs text-outline">No refund requests yet.</div>
          )}
        </div>
      </div>

      {/* Disputes */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">⚖️ Disputes</h2>
          <Button size="sm" variant="outline" onClick={() => setShowDisputeForm(!showDisputeForm)}>
            {showDisputeForm ? "Cancel" : "Report a Dispute"}
          </Button>
        </div>

        {disputeError && (
          <div className="mx-lg mt-md bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{disputeError}</div>
        )}

        {showDisputeForm && (
          <div className="p-lg space-y-md">
            <FormField
              label="Related fee (optional)"
              id="dispute-fee"
              type="select"
              value={disputeFeeId}
              onChange={setDisputeFeeId}
              options={fees.map((f) => ({ value: f.id, label: `${f.type} — due ${f.due_date}` }))}
            />
            <FormField
              label="Describe the issue"
              id="dispute-description"
              type="textarea"
              value={disputeDescription}
              onChange={setDisputeDescription}
              required
              rows={3}
              placeholder="e.g. I paid ₹40,000 but the portal shows it as pending"
            />
            <div className="flex justify-end">
              <Button size="sm" onClick={handleDisputeSubmit} disabled={submittingDispute || !disputeDescription.trim()}>
                {submittingDispute ? "Submitting..." : "Submit"}
              </Button>
            </div>
          </div>
        )}

        <div className="divide-y divide-outline-variant">
          {disputes.length > 0 ? disputes.map((d: any) => (
            <div key={d.id} className="flex items-center justify-between px-lg py-md">
              <div>
                <div className="text-sm text-on-surface">{d.description}</div>
                <div className="text-xs text-outline mt-xs">
                  {new Date(d.created_at).toLocaleDateString()}
                  {d.resolution_notes ? ` — ${d.resolution_notes}` : ""}
                </div>
              </div>
              <StatusBadge status={d.status} />
            </div>
          )) : (
            <div className="p-lg text-center text-xs text-outline">No disputes yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
