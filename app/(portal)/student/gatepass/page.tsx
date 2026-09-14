"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button, FormField, Modal, StatusBadge } from "@/components/ui/modal";
import { applyForGatePass, getGatePassCredential, type CredentialView } from "./actions";

export default function StudentGatePass() {
  const supabase = createClient();
  const [passes, setPasses] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => { loadPasses(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await applyForGatePass({
        destination: form.destination,
        reason: form.reason,
        exitTime: form.exit_time,
        returnTime: form.return_time,
      });
      setForm({ destination: "", reason: "", exit_time: "", return_time: "" });
      setShowForm(false);
      setSubmitted(true);
      await loadPasses();
      setTimeout(() => setSubmitted(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit gate pass request.");
    } finally {
      setLoading(false);
    }
  };

  // The QR is fetched on demand, never with the list. It is rendered on the
  // server and arrives as an <svg> — the credential string itself never
  // reaches this component, so there is nothing here to copy out of the
  // page source.
  const [qrFor, setQrFor] = useState<any | null>(null);
  const [credential, setCredential] = useState<CredentialView | null>(null);
  const [qrLoading, setQrLoading] = useState(false);

  const openQr = async (pass: any) => {
    setQrFor(pass);
    setCredential(null);
    setQrLoading(true);
    try {
      setCredential(await getGatePassCredential(pass.id));
    } catch (e) {
      setCredential({ state: "none", reason: e instanceof Error ? e.message : "The pass could not be loaded." });
    } finally {
      setQrLoading(false);
    }
  };

  const MOVEMENT_LABEL: Record<string, string> = {
    NOT_EXITED: "Not exited",
    OUTSIDE: "Outside campus",
    RETURNED: "Returned",
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

      {error && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      {/* Application Form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-xl shadow-sm space-y-md">
          <h2 className="text-sm font-bold text-on-surface">📝 New Gate Pass Application</h2>
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
          <h2 className="text-sm font-bold text-on-surface flex items-center gap-sm">🚪 My Gate Passes</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {passes.length > 0 ? passes.map((pass: any) => (
            <div key={pass.id} className="flex items-center justify-between px-lg py-md hover:bg-surface-container-low transition-colors">
              <div className="flex items-start gap-sm">
                <span className="text-lg mt-[2px]">📍</span>
                <div>
                  <div className="text-sm font-medium text-on-surface">{pass.destination}</div>
                  <div className="text-xs text-outline">
                    🕐 {new Date(pass.exit_time).toLocaleString()} → {new Date(pass.return_time).toLocaleString()}
                  </div>
                  {pass.reason && <div className="text-xs text-outline mt-xs">{pass.reason}</div>}
                </div>
              </div>
              <div className="flex items-center gap-sm shrink-0">
                {["approved", "active", "returned"].includes(pass.status) && (
                  <Button size="sm" variant="outline" onClick={() => openQr(pass)}>
                    Show QR
                  </Button>
                )}
                <StatusBadge status={pass.status} />
              </div>
            </div>
          )) : (
            <div className="p-xl text-center text-sm text-outline">No gate pass requests found.</div>
          )}
        </div>
      </div>

      <Modal
        open={!!qrFor}
        onClose={() => setQrFor(null)}
        title="Gate Pass"
        description={qrFor ? `${qrFor.destination} · ${new Date(qrFor.exit_time).toLocaleString()}` : undefined}
      >
        {qrLoading && <div className="py-xl text-center text-sm text-outline">Loading...</div>}

        {!qrLoading && credential && (
          <div className="space-y-md">
            {credential.state === "issued" && credential.svg ? (
              <div className="flex justify-center">
                <div
                  className="bg-white p-md rounded-xl border border-outline-variant [&>svg]:w-full [&>svg]:h-auto w-[16rem]"
                  // Generated on this server by lib/gate-security/qr.ts from a
                  // payload this server built. Not user content.
                  dangerouslySetInnerHTML={{ __html: credential.svg }}
                />
              </div>
            ) : (
              <div className="bg-warning/10 border border-warning/20 text-warning rounded-xl p-md text-sm font-medium text-center">
                {credential.reason}
              </div>
            )}

            {credential.state === "issued" && (
              <dl className="grid grid-cols-2 gap-sm text-sm">
                <div>
                  <dt className="text-xs text-on-surface-variant">Pass</dt>
                  <dd className="font-semibold text-on-surface">
                    GP-{String(qrFor?.id ?? "").replace(/-/g, "").slice(0, 8).toUpperCase()}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-on-surface-variant">Movement</dt>
                  <dd className="font-semibold text-on-surface">{MOVEMENT_LABEL[credential.movementState]}</dd>
                </div>
                <div>
                  <dt className="text-xs text-on-surface-variant">Valid from</dt>
                  <dd className="font-semibold text-on-surface">{new Date(credential.validFrom).toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-xs text-on-surface-variant">Valid until</dt>
                  <dd className="font-semibold text-on-surface">{new Date(credential.expiresAt).toLocaleString()}</dd>
                </div>
              </dl>
            )}

            {credential.state === "issued" && credential.usable && (
              <p className="text-xs text-outline text-center">{credential.reason}</p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
