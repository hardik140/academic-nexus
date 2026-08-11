"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { DataTable } from "@/components/ui/data-table";
import { Modal, Button, FormField } from "@/components/ui/modal";
import { PLATFORM_COLLEGE_ID } from "@/lib/constants";
import { createCollege, inviteUser, resendInvitation, revokeInvitation } from "./actions";

export default function SuperAdminCollegesPage() {
  const supabase = createClient();
  const [colleges, setColleges] = useState<any[]>([]);
  const [invitations, setInvitations] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [inviteFor, setInviteFor] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({ name: "", code: "", city: "", state: "", country: "India" });
  const [inviteForm, setInviteForm] = useState({ email: "", fullName: "" });

  useEffect(() => { load(); loadInvitations(); }, []);

  const load = async () => {
    const { data } = await supabase
      .from("colleges")
      .select("*")
      .neq("id", PLATFORM_COLLEGE_ID)
      .order("created_at", { ascending: false });
    setColleges(data || []);
  };

  const loadInvitations = async () => {
    const { data } = await supabase
      .from("invitations")
      .select("*, colleges:college_id(name)")
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    setInvitations(data || []);
  };

  const handleResend = async (invitationId: string) => {
    setError(null);
    try {
      await resendInvitation(invitationId);
      await loadInvitations();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to resend invitation.");
    }
  };

  const handleRevoke = async (invitationId: string) => {
    setError(null);
    try {
      await revokeInvitation(invitationId);
      await loadInvitations();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke invitation.");
    }
  };

  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    try {
      await createCollege(createForm);
      setCreateForm({ name: "", code: "", city: "", state: "", country: "India" });
      setShowCreate(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create college.");
    } finally {
      setLoading(false);
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
      await loadInvitations();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send invitation.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Colleges</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Every tenant on the platform</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Create College</Button>
      </div>

      {error && !showCreate && !inviteFor && (
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
                    {inv.role} · {(inv.colleges as any)?.name ?? "—"} · expires {new Date(inv.expires_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex gap-md">
                  <button onClick={() => handleResend(inv.id)} className="text-xs text-secondary hover:underline font-medium">
                    Resend
                  </button>
                  <button onClick={() => handleRevoke(inv.id)} className="text-xs text-error hover:underline font-medium">
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
        actions={(row: any) => (
          <button
            onClick={(e) => { e.stopPropagation(); setInviteFor(row); }}
            className="text-xs text-secondary hover:underline font-medium"
          >
            Invite Admin
          </button>
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
            <Button onClick={handleCreate} disabled={loading || !createForm.name || !createForm.code}>
              {loading ? "Creating..." : "Create College"}
            </Button>
          </>
        }
      >
        {error && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{error}</div>
        )}
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
            <Button onClick={handleInviteAdmin} disabled={loading || !inviteForm.email || !inviteForm.fullName}>
              {loading ? "Sending..." : "Send Invitation"}
            </Button>
          </>
        }
      >
        {error && (
          <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium mb-md">{error}</div>
        )}
        <div className="space-y-md">
          <FormField label="Full Name" id="admin_name" value={inviteForm.fullName} onChange={(v) => setInviteForm({ ...inviteForm, fullName: v })} placeholder="e.g. Jane Doe" required />
          <FormField label="Email" id="admin_email" type="email" value={inviteForm.email} onChange={(v) => setInviteForm({ ...inviteForm, email: v })} placeholder="jane@college.edu" required />
        </div>
      </Modal>
    </div>
  );
}
