"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button, FormField, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { SessionExpiredError } from "@/lib/feedback-error";
import { requireRows } from "@/lib/read-result";
import { applyForLeave } from "./actions";
import type { Database } from "@/types/database";

type LeaveType = Database["public"]["Tables"]["leave_requests"]["Row"]["leave_type"];

export default function TeacherLeave() {
  const supabase = createClient();
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [form, setForm] = useState({
    leave_type: "casual",
    start_date: "",
    end_date: "",
    reason: "",
  });

  // A failed load is an error, never "no requests" (owner decision D5).
  const requestsResource = useAsyncResource(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new SessionExpiredError();
    return requireRows(
      await supabase
        .from("leave_requests")
        .select("*")
        .eq("requested_by", user.id)
        .order("created_at", { ascending: false })
    );
  }, []);
  const requests = requestsResource.data ?? [];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await applyForLeave({
        leaveType: form.leave_type as LeaveType,
        startDate: form.start_date,
        endDate: form.end_date,
        reason: form.reason,
      });
      setForm({ leave_type: "casual", start_date: "", end_date: "", reason: "" });
      setShowForm(false);
      // Stays until dismissed: the record of a request the user just made.
      setSuccess("Leave request submitted. It is awaiting HOD approval.");
      // A failure to refresh the list shows on the list, not as a failed submission.
      requestsResource.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to submit leave request."));
    } finally {
      setLoading(false);
    }
  };

  const leaveTypes = [
    { value: "casual", label: "Casual Leave" },
    { value: "sick", label: "Sick Leave" },
    { value: "earned", label: "Earned Leave" },
    { value: "maternity", label: "Maternity Leave" },
    { value: "paternity", label: "Paternity Leave" },
    { value: "study", label: "Study Leave" },
    { value: "sabbatical", label: "Sabbatical" },
    { value: "other", label: "Other" },
  ];

  // Leave summary
  const approved = requests.filter(r => r.status === "approved").length;
  const pending = requests.filter(r => r.status === "pending").length;
  const rejected = requests.filter(r => r.status === "rejected").length;

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Leave Management</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Apply and track your leave requests</p>
        </div>
        <Button onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "+ Apply Leave"}
        </Button>
      </div>

      <Alert tone="success" focusOnShow onDismiss={() => setSuccess(null)}>
        {success}
      </Alert>

      <ErrorAlert error={error} />

      {/* Summary */}
      <div className="grid grid-cols-3 gap-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm text-center">
          <div className="text-2xl font-extrabold text-success">✅ {approved}</div>
          <div className="text-xs text-outline uppercase tracking-wider mt-xs">Approved</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm text-center">
          <div className="text-2xl font-extrabold text-warning">🕐 {pending}</div>
          <div className="text-xs text-outline uppercase tracking-wider mt-xs">Pending</div>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm text-center">
          <div className="text-2xl font-extrabold text-error">❌ {rejected}</div>
          <div className="text-xs text-outline uppercase tracking-wider mt-xs">Rejected</div>
        </div>
      </div>

      {/* Form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-xl shadow-sm space-y-md">
          <h2 className="text-sm font-bold text-on-surface">📝 New Leave Application</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
            <FormField label="Leave Type" id="leave_type" type="select" value={form.leave_type} onChange={(v) => setForm({ ...form, leave_type: v })} options={leaveTypes} required />
            <div></div>
            <FormField label="Start Date" id="start_date" type="date" value={form.start_date} onChange={(v) => setForm({ ...form, start_date: v })} required />
            <FormField label="End Date" id="end_date" type="date" value={form.end_date} onChange={(v) => setForm({ ...form, end_date: v })} required />
            <div className="md:col-span-2">
              <FormField label="Reason" id="reason" type="textarea" value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} placeholder="Explain the reason for your leave..." required rows={3} />
            </div>
          </div>
          <div className="flex justify-end gap-sm">
            <Button variant="outline" type="button" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button type="submit" disabled={loading} aria-busy={loading || undefined}>{loading ? "Submitting..." : "Submit Request"}</Button>
          </div>
        </form>
      )}

      {/* Request History */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🗓️ Leave History</h2>
        </div>
        <StateView
          state={requestsResource}
          isEmpty={() => false}
          loadingLabel="Loading your leave requests…"
          empty={{ title: "No leave requests submitted" }}
        >
          {(requests) => (
        <div className="divide-y divide-outline-variant">
          {requests.map((req: any) => (
            <div key={req.id} className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
              <div>
                <div className="text-sm font-medium text-on-surface capitalize">{req.leave_type.replace(/_/g, " ")} Leave</div>
                <div className="text-xs text-outline">
                  🕐 {new Date(req.start_date).toLocaleDateString()} → {new Date(req.end_date).toLocaleDateString()}
                </div>
                <div className="text-xs text-outline mt-xs">{req.reason}</div>
              </div>
              <StatusBadge status={req.status} />
            </div>
          ))}
          {requests.length === 0 && (
            <div className="p-xl text-center text-sm text-outline">No leave requests submitted.</div>
          )}
        </div>
          )}
        </StateView>
      </div>
    </div>
  );
}
