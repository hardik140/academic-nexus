"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { Modal, Button, FormField } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { ErrorAlert } from "@/components/ui/error-alert";
import { ErrorState } from "@/components/ui/error-state";
import { useToast } from "@/components/ui/toast";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { classifyError } from "@/lib/feedback-error";
import { requireRows } from "@/lib/read-result";
import { LifecycleBadge, LifecycleDialog, LifecycleHistoryDialog, type LifecycleChange, type LifecycleHistoryEntry } from "@/components/portal/college-lifecycle";
import { SessionsDialog } from "@/components/portal/sessions-dialog";
import type { CollegeLifecycleState } from "@/types/database";
import {
  createCollege,
  listColleges,
  inviteUser,
  resendInvitation,
  revokeInvitation,
  setCollegeLifecycle,
  listCollegeLifecycleHistory,
  listCollegeAdminSessions,
  revokeAdminSession,
} from "./actions";

const COLLEGES_PAGE_SIZE = 10;

/** The fields of a college row the lifecycle dialogs use (migration 053). */
interface LifecycleCollege {
  id: string;
  name: string;
  lifecycle_state: CollegeLifecycleState;
  lifecycle_message: string | null;
}

export default function SuperAdminCollegesPage() {
  const supabase = createClient();
  const [colleges, setColleges] = useState<any[]>([]);
  const [collegesLoading, setCollegesLoading] = useState(false);
  const [collegesError, setCollegesError] = useState<unknown>(null);
  const [totalColleges, setTotalColleges] = useState(0);
  const [query, setQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });
  const [showCreate, setShowCreate] = useState(false);
  const [inviteFor, setInviteFor] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; email: string } | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [revokeError, setRevokeError] = useState<FeedbackError | null>(null);
  const latestLoad = useRef(0);
  const toast = useToast();
  const [createForm, setCreateForm] = useState({ name: "", code: "", city: "", state: "", country: "India" });
  const [inviteForm, setInviteForm] = useState({ email: "", fullName: "" });
  // College lifecycle (053) and Admin sessions (054).
  const [lifecycleFor, setLifecycleFor] = useState<LifecycleCollege | null>(null);
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<FeedbackError | null>(null);
  const [historyFor, setHistoryFor] = useState<LifecycleCollege | null>(null);
  const [history, setHistory] = useState<LifecycleHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<FeedbackError | null>(null);
  const [sessionsFor, setSessionsFor] = useState<LifecycleCollege | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(query); }, [query]);

  // The latest query's page: an earlier, slower one must not replace it. A
  // failed load is an error in the table, never "no colleges yet" (D5).
  const load = async (q: DataTableQuery) => {
    const run = ++latestLoad.current;
    setCollegesLoading(true);
    setCollegesError(null);
    try {
      const { data, count } = await listColleges(q);
      if (run !== latestLoad.current) return;
      setColleges(data);
      setTotalColleges(count);
    } catch (e) {
      if (run === latestLoad.current) setCollegesError(e);
    } finally {
      if (run === latestLoad.current) setCollegesLoading(false);
    }
  };

  const invitationsResource = useAsyncResource(
    async () =>
      requireRows(
        await supabase
          .from("invitations")
          .select("*, colleges:college_id(name)")
          .eq("status", "pending")
          .order("created_at", { ascending: false })
      ),
    []
  );
  const invitations: any[] = invitationsResource.data ?? [];

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

  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    try {
      await createCollege(createForm, query);
      setCreateForm({ name: "", code: "", city: "", state: "", country: "India" });
      setShowCreate(false);
      setNotice(`College ${createForm.name} created. Invite its first Admin next.`);
      void load(query);
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to create college."));
    } finally {
      setLoading(false);
    }
  };

  // A consequential change: the dialog stays open on failure; on success a
  // persistent page Alert says what happened (M6 decisions).
  const handleLifecycle = async (change: LifecycleChange) => {
    if (!lifecycleFor) return;
    setLifecyclePending(true);
    setLifecycleError(null);
    try {
      await setCollegeLifecycle({ collegeId: lifecycleFor.id, ...change }, query);
      const what = change.state === "ACTIVE" ? "reactivated" : change.state === "MAINTENANCE" ? "put under maintenance" : "suspended";
      setNotice(`${lifecycleFor.name} ${what}.${change.state === "ACTIVE" ? "" : " Its users have been signed out."}`);
      setLifecycleFor(null);
      void load(query);
    } catch (e) {
      setLifecycleError(await toFeedbackError(e, "The college's status couldn't be changed."));
    } finally {
      setLifecyclePending(false);
    }
  };

  const openHistory = async (college: LifecycleCollege) => {
    setHistoryFor(college);
    setHistory(null);
    setHistoryError(null);
    try {
      setHistory(await listCollegeLifecycleHistory(college.id));
    } catch (e) {
      setHistoryError(await toFeedbackError(e, "The history couldn't be loaded."));
    }
  };

  const handleInviteAdmin = async () => {
    if (!inviteFor) return;
    setLoading(true);
    setError(null);
    try {
      await inviteUser({
        email: inviteForm.email,
        fullName: inviteForm.fullName,
        role: "admin",
        collegeId: inviteFor.id,
      });
      setInviteForm({ email: "", fullName: "" });
      setInviteFor(null);
      setNotice(`Invitation sent to ${inviteForm.email}.`);
      invitationsResource.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to send invitation."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Colleges</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Every tenant on the platform</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Create College</Button>
      </div>

      <div ref={noticeRef}>
        <Alert tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      </div>

      {/* A dialog's own failure is shown inside it. */}
      <ErrorAlert error={!showCreate && !inviteFor ? error : null} />

      {invitationsResource.status === "error" && (
        <ErrorState
          {...classifyError(invitationsResource.error)}
          title="Pending invitations couldn't be loaded"
          onRetry={invitationsResource.reload}
          className="rounded-2xl border border-outline-variant bg-surface-container-lowest"
        />
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
                    {inv.role} · {(inv.colleges as any)?.name ?? "—"} · expires {new Date(inv.expires_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex gap-md">
                  <button type="button" onClick={() => handleResend(inv)} className="text-xs text-secondary hover:underline font-medium">
                    Resend
                  </button>
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

      <DataTable
        title="All Colleges"
        columns={[
          { key: "name", header: "Name", sortable: true },
          { key: "code", header: "Code", sortable: true },
          {
            key: "city",
            header: "Location",
            render: (row: any) => <span className="text-on-surface-variant">{[row.city, row.state].filter(Boolean).join(", ") || "—"}</span>,
          },
          {
            key: "lifecycle_state",
            header: "Status",
            render: (row: LifecycleCollege) => <LifecycleBadge state={row.lifecycle_state ?? "ACTIVE"} />,
          },
          {
            key: "created_at",
            header: "Created",
            render: (row: any) => <span className="text-on-surface-variant">{new Date(row.created_at).toLocaleDateString()}</span>,
          },
        ]}
        data={colleges}
        keyExtractor={(row) => row.id}
        searchKey="name"
        searchPlaceholder="Search colleges..."
        emptyMessage="No colleges yet — create the first one."
        serverMode
        totalCount={totalColleges}
        loading={collegesLoading}
        error={collegesError}
        onRetry={() => load(query)}
        onQueryChange={setQuery}
        pageSize={COLLEGES_PAGE_SIZE}
        actions={(row: any) => (
          <div className="flex flex-wrap gap-md">
            <button
              onClick={(e) => { e.stopPropagation(); setInviteFor(row); }}
              className="text-xs text-secondary hover:underline font-medium"
            >
              Invite Admin
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setLifecycleError(null); setLifecycleFor(row); }}
              className="text-xs text-secondary hover:underline font-medium"
              aria-label={`Change status of ${row.name}`}
            >
              Change status
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); void openHistory(row); }}
              className="text-xs text-secondary hover:underline font-medium"
              aria-label={`Status history of ${row.name}`}
            >
              History
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setSessionsFor(row); }}
              className="text-xs text-secondary hover:underline font-medium"
              aria-label={`Admin sessions of ${row.name}`}
            >
              Admin sessions
            </button>
          </div>
        )}
      />

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Create College"
        description="Sets up a new tenant. Invite its first Admin afterward."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={loading || !createForm.name || !createForm.code} aria-busy={loading || undefined}>
              {loading ? "Creating..." : "Create College"}
            </Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <div className="space-y-md">
          <FormField label="College Name" id="college_name" value={createForm.name} onChange={(v) => setCreateForm({ ...createForm, name: v })} placeholder="e.g. Springfield Institute of Technology" required />
          <FormField label="College Code" id="college_code" value={createForm.code} onChange={(v) => setCreateForm({ ...createForm, code: v })} placeholder="e.g. SIT" required />
          <FormField label="City" id="college_city" value={createForm.city} onChange={(v) => setCreateForm({ ...createForm, city: v })} />
          <FormField label="State" id="college_state" value={createForm.state} onChange={(v) => setCreateForm({ ...createForm, state: v })} />
        </div>
      </Modal>

      <Modal
        open={!!inviteFor}
        onClose={() => setInviteFor(null)}
        title={`Invite Admin — ${inviteFor?.name ?? ""}`}
        description="Sends an email invitation for this college's first Admin."
        footer={
          <>
            <Button variant="outline" onClick={() => setInviteFor(null)}>Cancel</Button>
            <Button onClick={handleInviteAdmin} disabled={loading || !inviteForm.email || !inviteForm.fullName} aria-busy={loading || undefined}>
              {loading ? "Sending..." : "Send Invitation"}
            </Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <div className="space-y-md">
          <FormField label="Full Name" id="admin_name" value={inviteForm.fullName} onChange={(v) => setInviteForm({ ...inviteForm, fullName: v })} placeholder="e.g. Jane Doe" required />
          <FormField label="Email" id="admin_email" type="email" value={inviteForm.email} onChange={(v) => setInviteForm({ ...inviteForm, email: v })} placeholder="jane@college.edu" required />
        </div>
      </Modal>

      <LifecycleDialog
        open={!!lifecycleFor}
        onClose={() => setLifecycleFor(null)}
        college={lifecycleFor}
        onSubmit={handleLifecycle}
        pending={lifecyclePending}
        error={lifecycleError}
      />

      <LifecycleHistoryDialog
        open={!!historyFor}
        onClose={() => setHistoryFor(null)}
        collegeName={historyFor?.name ?? ""}
        entries={history}
        error={historyError}
      />

      <SessionsDialog
        open={!!sessionsFor}
        onClose={() => setSessionsFor(null)}
        title={`Admin sessions — ${sessionsFor?.name ?? ""}`}
        description="Where this college's Admin accounts are signed in. Signing one out ends that session immediately."
        load={() => listCollegeAdminSessions(sessionsFor!.id)}
        revoke={revokeAdminSession}
        emptyText="No Admin of this college is signed in."
      />

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
