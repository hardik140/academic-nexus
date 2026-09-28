"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, FormField, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { SessionExpiredError } from "@/lib/feedback-error";
import { requireRows } from "@/lib/read-result";
import { submitComplaint } from "./actions";
import type { Database } from "@/types/database";

type ComplaintCategory = Database["public"]["Tables"]["complaints"]["Row"]["category"];
type ComplaintPriority = Database["public"]["Tables"]["complaints"]["Row"]["priority"];

const VALID_CATEGORIES = [
  "plumbing", "electrical", "ac_hvac", "carpentry", "cleaning",
  "internet", "safety", "academic", "hostel", "mess", "other",
];

export default function StudentComplaints() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const prefillCategory = searchParams.get("category");
  const [showForm, setShowForm] = useState(!!prefillCategory);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [form, setForm] = useState({
    category: prefillCategory && VALID_CATEGORIES.includes(prefillCategory) ? prefillCategory : "",
    title: "",
    description: "",
    location: "",
    priority: "medium",
  });

  // A failed load is an error, never "no complaints" (owner decision D5).
  const complaintsResource = useAsyncResource(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new SessionExpiredError();
    return requireRows(
      await supabase
        .from("complaints")
        .select("*")
        .eq("submitted_by", user.id)
        .order("created_at", { ascending: false })
    );
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await submitComplaint({
        category: form.category as ComplaintCategory,
        title: form.title,
        description: form.description,
        location: form.location,
        priority: form.priority as ComplaintPriority,
      });
      setForm({ category: "", title: "", description: "", location: "", priority: "medium" });
      setShowForm(false);
      // Stays until dismissed: the record of a complaint the student just made.
      setSuccess("Complaint submitted. You will be updated as it is handled.");
      // A failure to refresh the list shows on the list, not as a failed complaint.
      complaintsResource.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to submit complaint."));
    } finally {
      setLoading(false);
    }
  };

  const categories = [
    { value: "plumbing", label: "Plumbing" },
    { value: "electrical", label: "Electrical" },
    { value: "ac_hvac", label: "AC / HVAC" },
    { value: "carpentry", label: "Carpentry" },
    { value: "cleaning", label: "Cleaning" },
    { value: "internet", label: "Internet / WiFi" },
    { value: "safety", label: "Safety" },
    { value: "academic", label: "Academic" },
    { value: "hostel", label: "Hostel" },
    { value: "mess", label: "Mess / Food" },
    { value: "other", label: "Other" },
  ];

  const priorities = [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "critical", label: "Critical" },
  ];

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Complaints</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Submit maintenance requests and complaints</p>
        </div>
        <Button onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "+ New Complaint"}
        </Button>
      </div>

      <Alert tone="success" focusOnShow onDismiss={() => setSuccess(null)}>
        {success}
      </Alert>

      <ErrorAlert error={error} />

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-xl shadow-sm space-y-md">
          <h2 className="text-sm font-bold text-on-surface">📝 New Complaint</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
            <FormField label="Category" id="category" type="select" value={form.category} onChange={(v) => setForm({ ...form, category: v })} options={categories} required />
            <FormField label="Priority" id="priority" type="select" value={form.priority} onChange={(v) => setForm({ ...form, priority: v })} options={priorities} />
            <div className="md:col-span-2">
              <FormField label="Title" id="title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} placeholder="Brief summary of the issue" required />
            </div>
            <FormField label="Location" id="location" value={form.location} onChange={(v) => setForm({ ...form, location: v })} placeholder="e.g. Room 204, Block A" />
            <div className="md:col-span-2">
              <FormField label="Description" id="description" type="textarea" value={form.description} onChange={(v) => setForm({ ...form, description: v })} placeholder="Detailed description of the issue..." required rows={4} />
            </div>
          </div>
          <div className="flex justify-end gap-sm">
            <Button variant="outline" type="button" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button type="submit" disabled={loading} aria-busy={loading || undefined}>{loading ? "Submitting..." : "Submit Complaint"}</Button>
          </div>
        </form>
      )}

      {/* Complaints List */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🛠️ My Complaints</h2>
        </div>
        <StateView
          state={complaintsResource}
          isEmpty={() => false}
          loadingLabel="Loading your complaints…"
          empty={{ title: "No complaints submitted" }}
        >
          {(complaints) => (
        <div className="divide-y divide-outline-variant">
          {complaints.length > 0 ? complaints.map((c: any) => (
            <div key={c.id} className="px-lg py-md hover:bg-surface-container-low transition-colors">
              <div className="flex items-center justify-between mb-xs">
                <div className="flex items-center gap-sm">
                  <span className="text-xs font-semibold px-sm py-xs rounded-full bg-surface-container-high text-on-surface-variant capitalize">{c.category?.replace(/_/g, " ")}</span>
                  <span className={`text-xs font-semibold px-sm py-xs rounded-full ${
                    c.priority === "critical" ? "bg-error-container text-on-error-container" :
                    c.priority === "high" ? "bg-warning-container text-on-warning-container" :
                    c.priority === "low" ? "bg-info-container text-on-info-container" : "bg-surface-container-high text-on-surface-variant"
                  }`}>{c.priority}</span>
                </div>
                <StatusBadge status={c.status} />
              </div>
              <div className="text-sm font-semibold text-on-surface">{c.title}</div>
              <div className="text-xs text-outline mt-xs line-clamp-2">{c.description}</div>
              {c.location && <div className="text-xs text-outline mt-xs">📍 {c.location}</div>}
              <div className="text-[10px] text-outline-variant mt-sm">{new Date(c.created_at).toLocaleString()}</div>
            </div>
          )) : (
            <div className="p-xl text-center text-sm text-outline">No complaints submitted.</div>
          )}
        </div>
          )}
        </StateView>
      </div>
    </div>
  );
}
