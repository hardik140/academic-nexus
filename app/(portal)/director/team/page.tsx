"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Modal, Button, FormField } from "@/components/ui/modal";
import { inviteUser, resendInvitation, revokeInvitation } from "./actions";
import type { UserRole } from "@/types/database";

const INVITABLE_ROLES: { value: Extract<UserRole, "finance" | "hod" | "warden">; label: string }[] = [
  { value: "finance", label: "Finance" },
  { value: "hod", label: "HOD" },
  { value: "warden", label: "Warden" },
];

export default function DirectorTeamPage() {
  const supabase = createClient();
  const [invitations, setInvitations] = useState<any[]>([]);
  const [staff, setStaff] = useState<any[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ email: string; full_name: string; role: "finance" | "hod" | "warden" }>({
    email: "",
    full_name: "",
    role: "finance",
  });

  useEffect(() => { load(); }, []);

  const load = async () => {
    const [{ data: inv }, { data: profiles }] = await Promise.all([
      supabase.from("invitations").select("*").eq("status", "pending").order("created_at", { ascending: false }),
      supabase.from("profiles").select("*").in("role", ["finance", "hod", "warden"]).order("full_name"),
    ]);
    setInvitations(inv || []);
    setStaff(profiles || []);
  };

  const handleInvite = async () => {
    setLoading(true);
    setError(null);
    try {
      await inviteUser({ email: form.email, fullName: form.full_name, role: form.role });
      setForm({ email: "", full_name: "", role: "finance" });
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
          <p className="text-sm text-on-surface-variant mt-xs">Invite Finance, HOD, and Warden staff into your college</p>
        </div>
        <Button onClick={() => setShowInvite(true)}>+ Invite Staff</Button>
      </div>

      {error && !showInvite && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

      {invitations.length > 0 && (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant">
            <h2 className="text-sm font-bold text-on-surface">Pending Invitations ({invitations.length})</h2>
          </div>
          <div className="divide-y divide-outline-variant">
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
      )}

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Staff ({staff.length})</h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {staff.length === 0 && <div className="px-lg py-lg text-sm text-outline">No staff yet.</div>}
          {staff.map((p: any) => (
            <div key={p.id} className="flex items-center justify-between px-lg py-md">
              <div>
                <div className="text-sm font-medium text-on-surface">{p.full_name}</div>
                <div className="text-xs text-outline">{p.email}</div>
              </div>
              <span className="text-xs font-semibold px-sm py-xs rounded-full bg-secondary/10 text-secondary capitalize">{p.role}</span>
            </div>
          ))}
        </div>
      </div>

      <Modal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        title="Invite Staff"
        description="Sends an email invitation — the account stays pending until they accept and set a password."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowInvite(false)}>Cancel</Button>
            <Button onClick={handleInvite} disabled={loading || !form.email || !form.full_name}>
              {loading ? "Sending..." : "Send Invitation"}
            </Button>
          </>
        }
      >
        {error && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{error}</div>
        )}
        <div className="space-y-md">
          <FormField label="Full Name" id="invite_name" value={form.full_name} onChange={(v) => setForm({ ...form, full_name: v })} placeholder="e.g. Jane Doe" required />
          <FormField label="Email" id="invite_email" type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} placeholder="jane@college.edu" required />
          <FormField label="Role" id="invite_role" type="select" value={form.role} onChange={(v) => setForm({ ...form, role: v as "finance" | "hod" | "warden" })} options={INVITABLE_ROLES} required />
        </div>
      </Modal>
    </div>
  );
}
