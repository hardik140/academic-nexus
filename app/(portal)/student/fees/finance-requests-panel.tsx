"use client";

import { useState } from "react";
import { Button, FormField, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { classifyError } from "@/lib/feedback-error";
import { formatMoney } from "@/lib/format";
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
  // The student's refund requests and disputes. A failed load is an error,
  // never "No refund requests yet." (owner decision D5).
  const requests = useAsyncResource(async () => {
    const [refunds, disputes] = await Promise.all([listMyRefundRequests(), listMyDisputes()]);
    return { refunds: refunds as any[], disputes: disputes as any[] };
  }, []);
  const refunds = requests.data?.refunds ?? [];
  const disputes = requests.data?.disputes ?? [];
  const loadedOnce = requests.data !== undefined;

  const [showRefundForm, setShowRefundForm] = useState(false);
  const [refundPaymentId, setRefundPaymentId] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundError, setRefundError] = useState<FeedbackError | null>(null);
  const [refundSuccess, setRefundSuccess] = useState<string | null>(null);
  const [submittingRefund, setSubmittingRefund] = useState(false);

  const [showDisputeForm, setShowDisputeForm] = useState(false);
  const [disputeFeeId, setDisputeFeeId] = useState("");
  const [disputeDescription, setDisputeDescription] = useState("");
  const [disputeError, setDisputeError] = useState<FeedbackError | null>(null);
  const [disputeSuccess, setDisputeSuccess] = useState<string | null>(null);
  const [submittingDispute, setSubmittingDispute] = useState(false);

  const hasPendingRefund = (paymentId: string) => refunds.some((r) => r.payment_id === paymentId && r.status === "pending");

  const handleRefundSubmit = async () => {
    if (submittingRefund) return;
    setSubmittingRefund(true);
    setRefundError(null);
    setRefundSuccess(null);
    try {
      await requestRefund(refundPaymentId, Number(refundAmount), refundReason);
      setRefundPaymentId("");
      setRefundAmount("");
      setRefundReason("");
      setShowRefundForm(false);
      setRefundSuccess(`Refund request for ${formatMoney(Number(refundAmount))} submitted. Finance will review it.`);
      requests.reload();
    } catch (e) {
      setRefundError(await toFeedbackError(e, "Failed to submit refund request."));
    } finally {
      setSubmittingRefund(false);
    }
  };

  const handleDisputeSubmit = async () => {
    if (submittingDispute) return;
    setSubmittingDispute(true);
    setDisputeError(null);
    setDisputeSuccess(null);
    try {
      await submitDispute(disputeFeeId || null, null, disputeDescription);
      setDisputeFeeId("");
      setDisputeDescription("");
      setShowDisputeForm(false);
      setDisputeSuccess("Dispute reported. Finance will investigate and reply here.");
      requests.reload();
    } catch (e) {
      setDisputeError(await toFeedbackError(e, "Failed to submit dispute."));
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
            // Needs the loaded requests: they decide which payments may be refunded.
            <Button size="sm" variant="outline" disabled={!loadedOnce} onClick={() => setShowRefundForm(!showRefundForm)}>
              {showRefundForm ? "Cancel" : "Request Refund"}
            </Button>
          )}
        </div>

        <Alert tone="success" focusOnShow className="mx-lg mt-md" onDismiss={() => setRefundSuccess(null)}>
          {refundSuccess}
        </Alert>
        <ErrorAlert error={refundError} className="mx-lg mt-md" />

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
                .map((p) => ({ value: p.id, label: `${formatMoney(p.amount)} — ${p.method} — ${new Date(p.created_at).toLocaleDateString()}` }))}
            />
            <FormField label="Refund amount" id="refund-amount" type="number" value={refundAmount} onChange={setRefundAmount} required placeholder="0.00" />
            <FormField label="Reason" id="refund-reason" type="textarea" value={refundReason} onChange={setRefundReason} required rows={3} placeholder="Why are you requesting this refund?" />
            <div className="flex justify-end">
              <Button size="sm" onClick={handleRefundSubmit} disabled={submittingRefund || !refundPaymentId || !refundAmount || !refundReason.trim()} aria-busy={submittingRefund || undefined}>
                {submittingRefund ? "Submitting..." : "Submit Request"}
              </Button>
            </div>
          </div>
        )}

        {!loadedOnce ? (
          requests.status === "error" ? (
            <ErrorState {...classifyError(requests.error)} title="Your refund requests couldn't be loaded" onRetry={requests.reload} />
          ) : (
            <LoadingState label="Loading refund requests…" />
          )
        ) : (
        <div className="divide-y divide-outline-variant">
          {refunds.length > 0 ? refunds.map((r: any) => (
            <div key={r.id} className="flex items-center justify-between px-lg py-md">
              <div>
                <div className="text-sm text-on-surface">{formatMoney(r.amount)}</div>
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
        )}
      </div>

      {/* Disputes */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">⚖️ Disputes</h2>
          <Button size="sm" variant="outline" onClick={() => setShowDisputeForm(!showDisputeForm)}>
            {showDisputeForm ? "Cancel" : "Report a Dispute"}
          </Button>
        </div>

        <Alert tone="success" focusOnShow className="mx-lg mt-md" onDismiss={() => setDisputeSuccess(null)}>
          {disputeSuccess}
        </Alert>
        <ErrorAlert error={disputeError} className="mx-lg mt-md" />

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
              <Button size="sm" onClick={handleDisputeSubmit} disabled={submittingDispute || !disputeDescription.trim()} aria-busy={submittingDispute || undefined}>
                {submittingDispute ? "Submitting..." : "Submit"}
              </Button>
            </div>
          </div>
        )}

        {!loadedOnce ? (
          requests.status === "error" ? (
            <ErrorState {...classifyError(requests.error)} title="Your disputes couldn't be loaded" onRetry={requests.reload} />
          ) : (
            <LoadingState label="Loading disputes…" />
          )
        ) : (
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
        )}
      </div>
    </div>
  );
}
