"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Modal, Button, FormField } from "@/components/ui/modal";
import { inviteUser, resendInvitation, revokeInvitation, type InviteHodTeamParams } from "./actions";

const ROLE_OPTIONS = [
  { value: "teacher", label: "Teacher" },
  { value: "student", label: "Student" },
];

interface FormState {
  role: "teacher" | "student";
  email: string;
  fullName: string;
  enrollmentNumber: string;
  batchYear: string;
  parentName: string;
  parentEmail: string;
  parentPhone: string;
}

const EMPTY_FORM: FormState = {
  role: "teacher",
  email: "",
  fullName: "",
  enrollmentNumber: "",
  batchYear: String(new Date().getFullYear()),
  parentName: "",
  parentEmail: "",
  parentPhone: "",
};

export default function HodTeamPage() {
  const supabase = createClient();
  const [invitations, setInvitations] = useState<any[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  useEffect(() => { load(); }, []);

  const load = async () => {
    const { data } = await supabase
      .from("invitations")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    setInvitations(data || []);
  };

  const handleInvite = async () => {
    setLoading(true);
    setError(null);
    try {
      const params: InviteHodTeamParams =
        form.role === "student"
          ? {
              role: "student",
              email: form.email,
              fullName: form.fullName,
              enrollmentNumber: form.enrollmentNumber,
              batchYear: Number(form.batchYear),
              parentName: form.parentName || undefined,
              parentEmail: form.parentEmail || undefined,
              parentPhone: form.parentPhone || undefined,
            }
          : { role: "teacher", email: form.email, fullName: form.fullName };
      await inviteUser(params);
      setForm(EMPTY_FORM);
      setShowInvite(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send invitation.");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async (invitationId: string) => {
    setError(null);
    try {
      await resendInvitation(invitationId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to resend invitation.");
    }
  };

  const handleRevoke = async (invitationId: string) => {
    setError(null);
    try {
      await revokeInvitation(invitationId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke invitation.");
    }
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Team</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Invite teachers and students into your department</p>
        </div>
        <Button onClick={() => setShowInvite(true)}>+ Invite</Button>
      </div>

      {error && !showInvite && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Pending Invitations ({invitations.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {invitations.length === 0 && <div className="px-lg py-lg text-sm text-outline">No pending invitations.</div>}
          {invitations.map((inv: any) => (
            <div key={inv.id} className="flex items-center justify-between px-lg py-md">
              <div>
                <div className="text-sm font-medium text-on-surface">{inv.email}</div>
                <div className="text-xs text-outline capitalize">
                  {inv.role} · expires {new Date(inv.expires_at).toLocaleDateString()}
                </div>
              </div>
              <div className="flex gap-md">
                <button onClick={() => handleResend(inv.id)} className="text-xs text-secondary hover:underline font-medium">Resend</button>
                <button onClick={() => handleRevoke(inv.id)} className="text-xs text-error hover:underline font-medium">Revoke</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Modal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        title="Invite to Your Department"
        description="Sends an email invitation — the account stays pending until they accept and set a password."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowInvite(false)}>Cancel</Button>
            <Button
              onClick={handleInvite}
              disabled={
                loading ||
                !form.email ||
                !form.fullName ||
                (form.role === "student" && !form.enrollmentNumber)
              }
            >
              {loading ? "Sending..." : "Send Invitation"}
            </Button>
          </>
        }
      >
        {error && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{error}</div>
        )}
        <div className="space-y-md">
          <FormField label="Role" id="invite_role" type="select" value={form.role} onChange={(v) => setForm({ ...form, role: v as "teacher" | "student" })} options={ROLE_OPTIONS} required />
          <FormField label="Full Name" id="invite_name" value={form.fullName} onChange={(v) => setForm({ ...form, fullName: v })} placeholder="e.g. Jane Doe" required />
          <FormField label="Email" id="invite_email" type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} placeholder="jane@college.edu" required />

          {form.role === "student" && (
            <>
              <FormField label="Enrollment Number" id="invite_enrollment" value={form.enrollmentNumber} onChange={(v) => setForm({ ...form, enrollmentNumber: v })} placeholder="e.g. 2026CSE001" required />
              <FormField label="Batch Year" id="invite_batch" type="number" value={form.batchYear} onChange={(v) => setForm({ ...form, batchYear: v })} required />
              <FormField label="Parent Name" id="invite_parent_name" value={form.parentName} onChange={(v) => setForm({ ...form, parentName: v })} />
              <FormField label="Parent Email" id="invite_parent_email" type="email" value={form.parentEmail} onChange={(v) => setForm({ ...form, parentEmail: v })} />
              <FormField label="Parent Phone" id="invite_parent_phone" value={form.parentPhone} onChange={(v) => setForm({ ...form, parentPhone: v })} />
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
