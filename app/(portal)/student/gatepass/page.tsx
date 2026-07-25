"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button, FormField, StatusBadge } from "@/components/ui/modal";

export default function StudentGatePass() {
  const supabase = createClient();
  const [passes, setPasses] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState({
    destination: "",
    reason: "",
    exit_time: "",
    return_time: "",
  });

  // Load gate passes
  const loadPasses = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: student } = await supabase.from("students").select("id").eq("user_id", user.id).single();
    if (!student) return;
    const { data } = await supabase
      .from("gate_passes")
      .select("*")
      .eq("student_id", student.id)
      .order("created_at", { ascending: false });
    setPasses(data || []);
  };

  // Load on mount
  useState(() => { loadPasses(); });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: profile } = await supabase.from("profiles").select("college_id").eq("id", user.id).single();
    const { data: student } = await supabase.from("students").select("id").eq("user_id", user.id).single();

    if (!student || !profile) return;

    await supabase.from("gate_passes").insert({
      college_id: profile.college_id,
      student_id: student.id,
      destination: form.destination,
      reason: form.reason,
      exit_time: form.exit_time,
      return_time: form.return_time,
      status: "pending",
    });

    setForm({ destination: "", reason: "", exit_time: "", return_time: "" });
    setShowForm(false);
    setSubmitted(true);
    setLoading(false);
    loadPasses();
    setTimeout(() => setSubmitted(false), 3000);
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Gate Pass</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Apply for out-of-campus gate passes</p>
        </div>
        <Button onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "+ New Request"}
        </Button>
      </div>

      {submitted && (
        <div className="bg-success/10 border border-success/20 text-success rounded-xl p-md text-sm font-medium">
          ✅ Gate pass request submitted! Awaiting warden approval.
        </div>
      )}

      {/* Application Form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-xl shadow-sm space-y-md">
          <h2 className="text-sm font-bold text-on-surface">New Gate Pass Application</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
            <FormField label="Destination" id="destination" value={form.destination} onChange={(v) => setForm({ ...form, destination: v })} placeholder="e.g. Home, Hospital" required />
            <FormField label="Reason" id="reason" value={form.reason} onChange={(v) => setForm({ ...form, reason: v })} placeholder="Reason for leaving campus" />
            <FormField label="Exit Date & Time" id="exit_time" type="datetime-local" value={form.exit_time} onChange={(v) => setForm({ ...form, exit_time: v })} required />
            <FormField label="Expected Return" id="return_time" type="datetime-local" value={form.return_time} onChange={(v) => setForm({ ...form, return_time: v })} required />
          </div>
          <div className="flex justify-end gap-sm">
            <Button variant="outline" type="button" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button type="submit" disabled={loading}>{loading ? "Submitting..." : "Submit Application"}</Button>
          </div>
        </form>
      )}

      {/* Existing Passes */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">My Gate Passes</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {passes.length > 0 ? passes.map((pass: any) => (
            <div key={pass.id} className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
              <div>
                <div className="text-sm font-medium text-on-surface">{pass.destination}</div>
                <div className="text-xs text-outline">
                  {new Date(pass.exit_time).toLocaleString()} → {new Date(pass.return_time).toLocaleString()}
                </div>
                {pass.reason && <div className="text-xs text-outline mt-xs">{pass.reason}</div>}
              </div>
              <StatusBadge status={pass.status} />
            </div>
          )) : (
            <div className="p-xl text-center text-sm text-outline">No gate pass requests found.</div>
          )}
        </div>
      </div>
    </div>
  );
}
