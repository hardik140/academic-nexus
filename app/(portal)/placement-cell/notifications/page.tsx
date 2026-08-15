"use client";

import { useState, useEffect } from "react";
import { Button, FormField } from "@/components/ui/modal";
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
  const [sent, setSent] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [drives, setDrives] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [form, setForm] = useState<{
    title: string;
    message: string;
    targetType: TargetType;
    departmentId: string;
    batchYear: string;
    driveId: string;
  }>({ title: "", message: "", targetType: "college", departmentId: "", batchYear: "", driveId: "" });

  const load = async () => {
    const [notifs, depts, activeDrives] = await Promise.all([
      listSentPlacementNotifications(),
      listDepartmentsForSelect(),
      listActiveDrivesForSelect(),
    ]);
    setSent(notifs);
    setDepartments(depts);
    setDrives(activeDrives);
  };

  useEffect(() => {
    load();
  }, []);

  const handleSend = async () => {
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
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send notification.");
    } finally {
      setLoading(false);
    }
  };

  const departmentOptions = departments.map((d: any) => ({ value: d.id, label: `${d.code} — ${d.name}` }));
  const driveOptions = drives.map((d: any) => ({ value: d.id, label: `${d.job_role} — ${d.companies?.name || ""}` }));

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Notifications</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Notify students about companies and placement drives</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-lg">
        {/* Create notification */}
        <div className="lg:col-span-1 bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-lg space-y-md">
          <h2 className="text-sm font-bold text-on-surface">Create Notification</h2>

          {error && (
            <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
          )}
          {success && (
            <div className="bg-success/10 border border-success/20 text-success rounded-xl p-md text-sm font-medium">{success}</div>
          )}

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
            disabled={
              loading ||
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
        </div>
      </div>
    </div>
  );
}
