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
import { inviteUser, listInviteSections, resendInvitation, revokeInvitation, type InviteHodTeamParams } from "./actions";

const ROLE_OPTIONS = [
  { value: "teacher", label: "Teacher" },
  { value: "student", label: "Student" },
];

interface FormState {
  role: "teacher" | "student";
  email: string;
  fullName: string;
  enrollmentNumber: string;
  sectionId: string;
  programmeSemester: string;
  parentName: string;
  parentEmail: string;
  parentPhone: string;
}

const EMPTY_FORM: FormState = {
  role: "teacher",
  email: "",
  fullName: "",
  enrollmentNumber: "",
  sectionId: "",
  programmeSemester: "",
  parentName: "",
  parentEmail: "",
  parentPhone: "",
};

export default function HodTeamPage() {
  const supabase = createClient();
  const [showInvite, setShowInvite] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; email: string } | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [revokeError, setRevokeError] = useState<FeedbackError | null>(null);
  const toast = useToast();

  // A failed load is an error, never "No pending invitations." (owner decision D5).
  const invitationsResource = useAsyncResource(
    async () =>
      requireRows(
        await supabase
          .from("invitations")
          .select("*")
          .eq("status", "pending")
          .order("created_at", { ascending: false })
      ),
    []
  );
  const invitations: any[] = invitationsResource.data ?? [];

  // A student joins a SECTION (migration 055): its department, programme and
  // intake year are resolved by the database, so they are not form fields.
  const sectionsResource = useAsyncResource(() => listInviteSections(), []);
  const inviteSections = sectionsResource.data ?? [];
  const pickedSection = inviteSections.find((s) => s.id === form.sectionId);

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
              sectionId: form.sectionId,
              enrollmentNumber: form.enrollmentNumber,
              programmeSemester: Number(form.programmeSemester),
              parentName: form.parentName || undefined,
              parentEmail: form.parentEmail || undefined,
              parentPhone: form.parentPhone || undefined,
            }
          : { role: "teacher", email: form.email, fullName: form.fullName };
      await inviteUser(params);
      setForm(EMPTY_FORM);
      setShowInvite(false);
      setNotice(`Invitation sent to ${form.email}.`);
      invitationsResource.reload();
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
      invitationsResource.reload();
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
      invitationsResource.reload();
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
          <p className="text-sm text-on-surface-variant mt-xs">Invite teachers and students into your department</p>
        </div>
        <Button onClick={() => setShowInvite(true)}>+ Invite</Button>
      </div>

      <div ref={noticeRef}>
        <Alert tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      </div>

      {/* The invite dialog shows its own failure. */}
      <ErrorAlert error={!showInvite ? error : null} />

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Pending Invitations ({invitations.length})</h2>
        </div>
        <StateView
          state={invitationsResource}
          isEmpty={() => false}
          loadingLabel="Loading pending invitations…"
          empty={{ title: "No pending invitations" }}
        >
          {(invitations) => (
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
          )}
        </StateView>
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
                (form.role === "student" && (!form.enrollmentNumber || !form.sectionId || !form.programmeSemester))
              }
              aria-busy={loading || undefined}
            >
              {loading ? "Sending..." : "Send Invitation"}
            </Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <div className="space-y-md">
          <FormField label="Role" id="invite_role" type="select" value={form.role} onChange={(v) => setForm({ ...form, role: v as "teacher" | "student" })} options={ROLE_OPTIONS} required />
          <FormField label="Full Name" id="invite_name" value={form.fullName} onChange={(v) => setForm({ ...form, fullName: v })} placeholder="e.g. Jane Doe" required />
          <FormField label="Email" id="invite_email" type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} placeholder="jane@college.edu" required />

          {form.role === "student" && (
            <>
              <FormField
                label="Section"
                id="invite_section"
                type="select"
                value={form.sectionId}
                onChange={(v) => setForm({ ...form, sectionId: v, programmeSemester: "" })}
                options={inviteSections.map((s) => ({ value: s.id, label: s.label }))}
                error={sectionsResource.status === "error" ? "Your sections could not be loaded." : undefined}
                required
              />
              <FormField
                label="Programme semester"
                id="invite_semester"
                type="select"
                value={form.programmeSemester}
                onChange={(v) => setForm({ ...form, programmeSemester: v })}
                options={Array.from({ length: pickedSection?.duration ?? 0 }, (_, i) => ({ value: String(i + 1), label: `Semester ${i + 1}` }))}
                disabled={!pickedSection}
                required
              />
              <FormField label="Enrollment Number" id="invite_enrollment" value={form.enrollmentNumber} onChange={(v) => setForm({ ...form, enrollmentNumber: v })} placeholder="e.g. 2026CSE001" required />
              <FormField label="Parent Name" id="invite_parent_name" value={form.parentName} onChange={(v) => setForm({ ...form, parentName: v })} />
              <FormField label="Parent Email" id="invite_parent_email" type="email" value={form.parentEmail} onChange={(v) => setForm({ ...form, parentEmail: v })} />
              <FormField label="Parent Phone" id="invite_parent_phone" value={form.parentPhone} onChange={(v) => setForm({ ...form, parentPhone: v })} />
            </>
          )}
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
