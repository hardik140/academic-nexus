"use client";

import { useState, useEffect } from "react";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { StatsCard } from "@/components/ui/stats-card";
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
  const [users, setUsers] = useState<any[]>([]);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [overview, setOverview] = useState<any>(null);
  const [showAssign, setShowAssign] = useState(false);
  const [mode, setMode] = useState<AssignMode>("invite");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteForm, setInviteForm] = useState({ fullName: "", email: "" });
  const [selectedCandidate, setSelectedCandidate] = useState("");

  const load = async () => {
    const [usersData, candidatesData, overviewData] = await Promise.all([
      listPlacementCellUsers(),
      listPlacementCellCandidates(),
      getPlacementOverview(),
    ]);
    setUsers(usersData);
    setCandidates(candidatesData);
    setOverview(overviewData);
  };

  useEffect(() => {
    load();
  }, []);

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
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to assign Placement Cell.");
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async (userId: string) => {
    setError(null);
    try {
      await revokePlacementCell(userId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke access.");
    }
  };

  const handleReactivate = async (userId: string) => {
    setError(null);
    try {
      await reactivatePlacementCell(userId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to re-activate access.");
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

      {error && !showAssign && (
        <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>
      )}

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
                      onClick={() => handleRevoke(u.id)}
                      className="text-xs text-error hover:underline font-medium"
                    >
                      Revoke Access
                    </button>
                  ) : (
                    <button
                      onClick={() => handleReactivate(u.id)}
                      className="text-xs text-success hover:underline font-medium"
                    >
                      Re-activate
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

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
            >
              {loading ? "Saving..." : mode === "invite" ? "Send Invitation" : "Promote to Placement Cell"}
            </Button>
          </>
        }
      >
        {error && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{error}</div>
        )}

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
    </div>
  );
}
