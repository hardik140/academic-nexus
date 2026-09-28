"use client";

import { useRef, useState } from "react";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { StatsCard } from "@/components/ui/stats-card";
import { Alert } from "@/components/ui/alert";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import {
  listPlacementCellUsers,
  listPlacementCellCandidates,
  promoteToPlacementCell,
  assignPlacementCell,
  revokePlacementCell,
  reactivatePlacementCell,
  getPlacementOverview,
} from "./actions";

type AssignMode = "invite" | "existing";

export default function DirectorPlacementCell() {
  const [showAssign, setShowAssign] = useState(false);
  const [mode, setMode] = useState<AssignMode>("invite");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [inviteForm, setInviteForm] = useState({ fullName: "", email: "" });
  const [selectedCandidate, setSelectedCandidate] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [revokeError, setRevokeError] = useState<FeedbackError | null>(null);
  const [reactivating, setReactivating] = useState<string | null>(null);

  // Users, candidates and the overview load together. A failed load is an
  // error, never "No Placement Cell user assigned yet." or zeros (D5).
  const cell = useAsyncResource(async () => {
    const [users, candidates, overview] = await Promise.all([
      listPlacementCellUsers(),
      listPlacementCellCandidates(),
      getPlacementOverview(),
    ]);
    return { users: users as any[], candidates: candidates as any[], overview: overview as any };
  }, []);
  const candidates = cell.data?.candidates ?? [];

  const openAssign = () => {
    setMode("invite");
    setInviteForm({ fullName: "", email: "" });
    setSelectedCandidate("");
    setError(null);
    setShowAssign(true);
  };

  const handleAssign = async () => {
    setLoading(true);
    setError(null);
    try {
      if (mode === "invite") {
        await assignPlacementCell({ email: inviteForm.email, fullName: inviteForm.fullName });
      } else {
        if (!selectedCandidate) throw new Error("Select a staff member to promote.");
        await promoteToPlacementCell(selectedCandidate);
      }
      setShowAssign(false);
      setNotice(mode === "invite" ? `Invitation sent to ${inviteForm.email}.` : "Staff member promoted to Placement Cell.");
      cell.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to assign Placement Cell."));
    } finally {
      setLoading(false);
    }
  };

  // Removing someone's access is asked first; a failure stays in the dialog.
  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    setRevokePending(true);
    setRevokeError(null);
    try {
      await revokePlacementCell(revokeTarget.id);
      setNotice(`Placement Cell access revoked for ${revokeTarget.name}.`);
      setRevokeTarget(null);
      cell.reload();
    } catch (e) {
      setRevokeError(await toFeedbackError(e, "Failed to revoke access."));
    } finally {
      setRevokePending(false);
    }
  };

  const handleReactivate = async (user: { id: string; full_name: string }) => {
    if (reactivating) return;
    setReactivating(user.id);
    setError(null);
    try {
      await reactivatePlacementCell(user.id);
      setNotice(`Placement Cell access restored for ${user.full_name}.`);
      cell.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to re-activate access."));
    } finally {
      setReactivating(null);
    }
  };

  const candidateOptions = candidates.map((c: any) => ({
    value: c.id,
    label: `${c.full_name} (${c.role})`,
  }));

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Placement Cell</h1>
          <p className="text-sm text-on-surface-variant mt-xs">
            Assign and oversee who runs the placement process for your college
          </p>
        </div>
        <Button onClick={openAssign}>+ Assign Placement Cell</Button>
      </div>

      <div ref={noticeRef}>
        <Alert tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      </div>

      {/* The assign dialog shows its own failure. */}
      <ErrorAlert error={!showAssign ? error : null} />

      <StateView state={cell} isEmpty={() => false} loadingLabel="Loading the Placement Cell…" empty={{ title: "No Placement Cell user assigned yet" }}>
        {({ users, overview }) => (
          <>
      {/* Placement Overview — oversight, not operational control */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-md">
        <StatsCard label="Students Placed" value={overview?.totalPlaced ?? 0} icon="🎓" color="success" />
        <StatsCard label="Companies" value={overview?.totalCompanies ?? 0} icon="🏢" />
        <StatsCard label="Active Drives" value={overview?.activeDrives ?? 0} icon="🎯" color="info" />
        <StatsCard label="Applications" value={overview?.totalApplications ?? 0} icon="📋" />
      </div>

      {/* Placement Cell status */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between">
          <h2 className="text-sm font-bold text-on-surface">
            Placement Cell Status: {users.some((u) => u.status === "active") ? (
              <span className="text-success">Active</span>
            ) : (
              <span className="text-outline">Not Assigned</span>
            )}
          </h2>
        </div>
        <div className="divide-y divide-outline-variant">
          {users.length === 0 ? (
            <div className="p-xl text-center text-sm text-outline">
              No Placement Cell user assigned yet.
            </div>
          ) : (
            users.map((u: any) => (
              <div key={u.id} className="flex items-center justify-between px-lg py-md">
                <div>
                  <div className="text-sm font-semibold text-on-surface">{u.full_name}</div>
                  <div className="text-xs text-outline">
                    {u.email} · assigned {new Date(u.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex items-center gap-md">
                  <StatusBadge status={u.status} />
                  {u.status === "active" ? (
                    <button
                      type="button"
                      onClick={() => {
                        setRevokeError(null);
                        setRevokeTarget({ id: u.id, name: u.full_name });
                      }}
                      className="text-xs text-error hover:underline font-medium"
                    >
                      Revoke Access
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleReactivate(u)}
                      disabled={reactivating !== null}
                      aria-busy={reactivating === u.id || undefined}
                      className="text-xs text-success hover:underline font-medium disabled:opacity-50"
                    >
                      {reactivating === u.id ? "Re-activating…" : "Re-activate"}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
          </>
        )}
      </StateView>

      <Modal
        open={showAssign}
        onClose={() => setShowAssign(false)}
        title="Assign Placement Cell"
        description="Invite a new user or promote an existing staff member into the Placement Cell role."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowAssign(false)}>Cancel</Button>
            <Button
              onClick={handleAssign}
              disabled={
                loading ||
                (mode === "invite" ? !inviteForm.email || !inviteForm.fullName : !selectedCandidate)
              }
              aria-busy={loading || undefined}
            >
              {loading ? "Saving..." : mode === "invite" ? "Send Invitation" : "Promote to Placement Cell"}
            </Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />

        <div className="flex gap-xs mb-md bg-surface-container-low rounded-xl p-xs">
          <button
            onClick={() => setMode("invite")}
            className={`flex-1 text-xs font-semibold py-sm rounded-lg transition-colors ${
              mode === "invite" ? "bg-secondary text-on-secondary" : "text-on-surface-variant"
            }`}
          >
            Invite New User
          </button>
          <button
            onClick={() => setMode("existing")}
            className={`flex-1 text-xs font-semibold py-sm rounded-lg transition-colors ${
              mode === "existing" ? "bg-secondary text-on-secondary" : "text-on-surface-variant"
            }`}
          >
            Select Existing User
          </button>
        </div>

        {mode === "invite" ? (
          <div className="space-y-md">
            <FormField
              label="Name"
              id="pc_name"
              value={inviteForm.fullName}
              onChange={(v) => setInviteForm({ ...inviteForm, fullName: v })}
              placeholder="e.g. Priya Sharma"
              required
            />
            <FormField
              label="Email"
              id="pc_email"
              type="email"
              value={inviteForm.email}
              onChange={(v) => setInviteForm({ ...inviteForm, email: v })}
              placeholder="priya@college.edu"
              required
            />
          </div>
        ) : (
          <FormField
            label="Staff Member"
            id="pc_existing"
            type="select"
            value={selectedCandidate}
            onChange={setSelectedCandidate}
            options={candidateOptions}
            required
          />
        )}
      </Modal>

      <ConfirmationDialog
        open={!!revokeTarget}
        title="Revoke Placement Cell access?"
        description={
          revokeTarget
            ? `${revokeTarget.name} will lose access to the Placement Cell portal at once. You can re-activate them later.`
            : undefined
        }
        confirmLabel="Revoke access"
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
