"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Modal, Button, FormField } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useToast } from "@/components/ui/toast";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { requireRows } from "@/lib/read-result";
import { inviteUser, resendInvitation, revokeInvitation } from "./actions";
import type { UserRole } from "@/types/database";

type InvitableRole = Extract<UserRole, "finance" | "hod" | "warden" | "placement_cell">;

const INVITABLE_ROLES: { value: InvitableRole; label: string }[] = [
  { value: "finance", label: "Finance" },
  { value: "hod", label: "HOD" },
  { value: "warden", label: "Warden" },
  { value: "placement_cell", label: "Placement Cell" },
];

export default function DirectorTeamPage() {
  const supabase = createClient();
  const [showInvite, setShowInvite] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; email: string } | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [revokeError, setRevokeError] = useState<FeedbackError | null>(null);
  const toast = useToast();
  const [form, setForm] = useState<{ email: string; full_name: string; role: InvitableRole }>({
    email: "",
    full_name: "",
    role: "finance",
  });

  // Pending invitations and active staff. A failed load is an error, never
  // "No staff yet." (owner decision D5).
  const team = useAsyncResource(async () => {
    const [inv, profiles] = await Promise.all([
      supabase.from("invitations").select("*").eq("status", "pending").order("created_at", { ascending: false }),
      supabase.from("profiles").select("*").eq("status", "active").in("role", ["finance", "hod", "warden", "placement_cell"]).order("full_name"),
    ]);
    return { invitations: requireRows(inv) as any[], staff: requireRows(profiles) as any[] };
  }, []);

  const handleInvite = async () => {
    setLoading(true);
    setError(null);
    try {
      await inviteUser({ email: form.email, fullName: form.full_name, role: form.role });
      setForm({ email: "", full_name: "", role: "finance" });
      setShowInvite(false);
      setNotice(`Invitation sent to ${form.email}.`);
      team.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to send invitation."));
    } finally {
      setLoading(false);
    }
  };

  // Low stakes, nothing else to show it: a toast.
  const handleResend = async (invitation: { id: string; email: string }) => {
    setError(null);
    try {
      await resendInvitation(invitation.id);
      toast.success(`Invitation resent to ${invitation.email}.`, { id: `resend-${invitation.id}` });
      team.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to resend invitation."));
    }
  };

  // Asked first (ConfirmationDialog); a failure stays in the dialog.
  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    setRevokePending(true);
    setRevokeError(null);
    try {
      await revokeInvitation(revokeTarget.id);
      setNotice(`Invitation for ${revokeTarget.email} revoked.`);
      setRevokeTarget(null);
      team.reload();
    } catch (e) {
      setRevokeError(await toFeedbackError(e, "Failed to revoke invitation."));
    } finally {
      setRevokePending(false);
    }
  };

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Team</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Invite Finance, HOD, Warden, and Placement Cell staff into your college</p>
        </div>
        <Button onClick={() => setShowInvite(true)}>+ Invite Staff</Button>
      </div>

      <div ref={noticeRef}>
        <Alert tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      </div>

      {/* The invite dialog shows its own failure. */}
      <ErrorAlert error={!showInvite ? error : null} />

      <StateView state={team} isEmpty={() => false} loadingLabel="Loading your team…" empty={{ title: "No staff yet" }}>
        {({ invitations, staff }) => (
          <>
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
                    {inv.role.replace(/_/g, " ")} · expires {new Date(inv.expires_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex gap-md">
                  <button type="button" onClick={() => handleResend(inv)} className="text-xs text-secondary hover:underline font-medium">Resend</button>
                  <button
                    type="button"
                    onClick={() => {
                      setRevokeError(null);
                      setRevokeTarget({ id: inv.id, email: inv.email });
                    }}
                    className="text-xs text-error hover:underline font-medium"
                  >
                    Revoke
                  </button>
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
              <span className="text-xs font-semibold px-sm py-xs rounded-full bg-secondary/10 text-secondary capitalize">{p.role.replace(/_/g, " ")}</span>
            </div>
          ))}
        </div>
      </div>
          </>
        )}
      </StateView>

      <Modal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        title="Invite Staff"
        description="Sends an email invitation — the account stays pending until they accept and set a password."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowInvite(false)}>Cancel</Button>
            <Button onClick={handleInvite} disabled={loading || !form.email || !form.full_name} aria-busy={loading || undefined}>
              {loading ? "Sending..." : "Send Invitation"}
            </Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <div className="space-y-md">
          <FormField label="Full Name" id="invite_name" value={form.full_name} onChange={(v) => setForm({ ...form, full_name: v })} placeholder="e.g. Jane Doe" required />
          <FormField label="Email" id="invite_email" type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} placeholder="jane@college.edu" required />
          <FormField label="Role" id="invite_role" type="select" value={form.role} onChange={(v) => setForm({ ...form, role: v as InvitableRole })} options={INVITABLE_ROLES} required />
        </div>
      </Modal>

      <ConfirmationDialog
        open={!!revokeTarget}
        title="Revoke this invitation?"
        description={revokeTarget ? `${revokeTarget.email} will no longer be able to use the invitation link. You can invite them again later.` : undefined}
        confirmLabel="Revoke invitation"
        pendingLabel="Revoking…"
        pending={revokePending}
        error={revokeError}
        onConfirm={confirmRevoke}
        onCancel={() => setRevokeTarget(null)}
        returnFocusTo={() => noticeRef.current?.querySelector<HTMLElement>('[role="status"]') ?? null}
      />
    </div>
  );
}
