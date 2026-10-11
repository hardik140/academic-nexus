"use client";

import { useState } from "react";
import { Button, FormField } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { sendPlacementNotification, listSentPlacementNotifications, type SendPlacementNotificationParams } from "./actions";
import { listDepartmentsForSelect, listActiveDrivesForSelect } from "../drives/actions";

type TargetType = SendPlacementNotificationParams["targetType"];

const TARGET_OPTIONS: { value: TargetType; label: string }[] = [
  { value: "college", label: "Entire College" },
  { value: "department", label: "Specific Department" },
  { value: "batch_year", label: "Specific Batch Year" },
  { value: "eligible", label: "Eligible Students (for a drive)" },
];

export default function PlacementCellNotifications() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [form, setForm] = useState<{
    title: string;
    message: string;
    targetType: TargetType;
    departmentId: string;
    batchYear: string;
    driveId: string;
  }>({ title: "", message: "", targetType: "college", departmentId: "", batchYear: "", driveId: "" });

  // What was sent, and the audiences one may target. A failed load is an
  // error, never "No notifications sent yet." (owner decision D5).
  const sentResource = useAsyncResource(() => listSentPlacementNotifications(), []);
  const options = useAsyncResource(async () => {
    const [departments, drives] = await Promise.all([listDepartmentsForSelect(), listActiveDrivesForSelect()]);
    return { departments: departments as any[], drives: drives as any[] };
  }, []);
  const departments = options.data?.departments ?? [];
  const drives = options.data?.drives ?? [];
  // A department or drive target needs its list; the others do not.
  const needsOptions = form.targetType === "department" || form.targetType === "eligible";

  const handleSend = async () => {
    // One send per click: a duplicate reaches every student twice.
    if (loading) return;
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await sendPlacementNotification({
        title: form.title,
        message: form.message,
        targetType: form.targetType,
        departmentId: form.departmentId || undefined,
        batchYear: form.batchYear ? Number(form.batchYear) : undefined,
        driveId: form.driveId || undefined,
      });
      setForm({ title: "", message: "", targetType: "college", departmentId: "", batchYear: "", driveId: "" });
      setSuccess(`Sent to ${result.recipientCount} student${result.recipientCount === 1 ? "" : "s"}.`);
      // Refreshing the history is not part of sending: its failure shows there.
      sentResource.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to send notification."));
    } finally {
      setLoading(false);
    }
  };

  const departmentOptions = departments.map((d: any) => ({ value: d.id, label: `${d.code} — ${d.name}` }));
  const driveOptions = drives.map((d: any) => ({ value: d.id, label: `${d.job_role} — ${d.companies?.name || ""}` }));

  return (
    <div className="space-y-lg">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Notifications</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Notify students about companies and placement drives</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-lg">
        {/* Create notification */}
        <div className="lg:col-span-1 bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg space-y-md">
          <h2 className="text-sm font-bold text-on-surface">Create Notification</h2>

          <ErrorAlert error={error} />
          <Alert tone="success" onDismiss={() => setSuccess(null)}>
            {success}
          </Alert>
          <Alert
            tone="error"
            action={<Button variant="outline" size="sm" onClick={options.reload}>Try again</Button>}
          >
            {needsOptions && options.status === "error" ? (
              <>
                Departments and drives couldn&apos;t be loaded, so this audience can&apos;t be chosen yet.
              </>
            ) : null}
          </Alert>

          <FormField label="Title" id="title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} placeholder="e.g. TCS is hiring" required />
          <FormField label="Message" id="message" type="textarea" value={form.message} onChange={(v) => setForm({ ...form, message: v })} rows={4} required />
          <FormField
            label="Target Audience"
            id="target_type"
            type="select"
            value={form.targetType}
            onChange={(v) => setForm({ ...form, targetType: v as TargetType })}
            options={TARGET_OPTIONS}
            required
          />

          {form.targetType === "department" && (
            <FormField label="Department" id="target_dept" type="select" value={form.departmentId} onChange={(v) => setForm({ ...form, departmentId: v })} options={departmentOptions} required />
          )}
          {form.targetType === "batch_year" && (
            <FormField label="Batch Year" id="target_batch" type="number" value={form.batchYear} onChange={(v) => setForm({ ...form, batchYear: v })} placeholder="e.g. 2026" required />
          )}
          {form.targetType === "eligible" && (
            <FormField label="Placement Drive" id="target_drive" type="select" value={form.driveId} onChange={(v) => setForm({ ...form, driveId: v })} options={driveOptions} required />
          )}

          <Button
            className="w-full justify-center"
            onClick={handleSend}
            aria-busy={loading || undefined}
            disabled={
              loading ||
              (needsOptions && options.status !== "success") ||
              !form.title ||
              !form.message ||
              (form.targetType === "department" && !form.departmentId) ||
              (form.targetType === "batch_year" && !form.batchYear) ||
              (form.targetType === "eligible" && !form.driveId)
            }
          >
            {loading ? "Sending..." : "Send Notification"}
          </Button>
        </div>

        {/* Sent history */}
        <div className="lg:col-span-2 bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">Recently Sent</h2>
          </div>
          <StateView state={sentResource} isEmpty={() => false} loadingLabel="Loading sent notifications…" empty={{ title: "No notifications sent yet" }}>
            {(sent: any[]) => (
          <div className="divide-y divide-outline-variant max-h-[32rem] overflow-y-auto">
            {sent.length === 0 ? (
              <div className="p-xl text-center text-sm text-outline">No notifications sent yet.</div>
            ) : (
              sent.map((n: any) => (
                <div key={n.id} className="px-lg py-md">
                  <div className="text-sm font-semibold text-on-surface">{n.title}</div>
                  <div className="text-xs text-on-surface-variant mt-xs">{n.message}</div>
                  <div className="text-[11px] text-outline mt-xs">{new Date(n.created_at).toLocaleString()}</div>
                </div>
              ))
            )}
          </div>
            )}
          </StateView>
        </div>
      </div>
    </div>
  );
}
