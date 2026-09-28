"use client";

import { useState, useTransition } from "react";
import { Button, FormField, Modal, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { GATE_SECURITY_CAPABILITIES } from "@/lib/permissions";
import {
  assignGate,
  authorizeSecurityPersonnel,
  createGate,
  revokeGateAssignment,
  sendSecurityInstruction,
  setGateActive,
  setSecurityPermissions,
  setSecurityPersonnelStatus,
  withdrawSecurityInstruction,
  type SecurityPersonnelRow,
} from "./actions";

type Gate = { id: string; code: string; name: string; description: string | null; is_active: boolean };
type Candidate = { id: string; full_name: string; email: string; status: string };
type Instruction = {
  id: string;
  title: string;
  message: string;
  priority: string;
  audience: string;
  status: string;
  created_at: string;
};

const CAPABILITY_LABEL: Record<string, string> = {
  "gate_security.dashboard.view": "Dashboard",
  "gate_security.scanner.use": "Use scanner",
  "gate_security.pass.view": "View pass details",
  "gate_security.pass.validate": "Validate pass",
  "gate_security.movement.record": "Record movements",
  "gate_security.movement.view": "View movements",
  "gate_security.history.view": "View history",
  "gate_security.instructions.view": "Receive instructions",
  "gate_security.audit.view": "View own audit trail",
  "gate_security.gate.view": "View gate",
};

export function SecurityAdminClient({
  personnel,
  candidates,
  gates,
  instructions,
}: {
  personnel: SecurityPersonnelRow[];
  candidates: Candidate[];
  gates: Gate[];
  instructions: Instruction[];
}) {
  const [pending, startTransition] = useTransition();
  // A failure, and where it happened: the page or the dialog that was open,
  // so it is shown there and nowhere else.
  const [failure, setFailure] = useState<{ surface: string; error: FeedbackError } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [authorizing, setAuthorizing] = useState<Candidate | null>(null);
  const [employeeCode, setEmployeeCode] = useState("");

  const [editing, setEditing] = useState<SecurityPersonnelRow | null>(null);
  const [caps, setCaps] = useState<string[]>([]);

  const [deactivating, setDeactivating] = useState<SecurityPersonnelRow | null>(null);
  const [deactivateReason, setDeactivateReason] = useState("");

  const [newGate, setNewGate] = useState(false);
  const [gateForm, setGateForm] = useState({ code: "", name: "", description: "" });

  const [instruction, setInstruction] = useState(false);
  const [instructionForm, setInstructionForm] = useState({
    title: "",
    message: "",
    priority: "normal" as "normal" | "high" | "emergency",
    audience: "all" as "all" | "gate" | "person",
    gateId: "",
    personnelId: "",
  });

  const [assigning, setAssigning] = useState<SecurityPersonnelRow | null>(null);
  const [assignGateId, setAssignGateId] = useState("");

  /**
   * One wrapper around every mutation so a refused write always reaches the
   * screen. Server Actions reject with the message thrown on the server;
   * swallowing that here would turn "you cannot deactivate a guard without
   * a reason" into a button that silently does nothing.
   */
  const surface = authorizing
    ? "authorize"
    : assigning
      ? "assign"
      : editing
        ? "capabilities"
        : deactivating
          ? "deactivate"
          : newGate
            ? "gate"
            : instruction
              ? "instruction"
              : "page";
  const errorFor = (where: string) => (failure?.surface === where ? failure.error : null);

  const run = (fn: () => Promise<unknown>, onDone?: () => void, done?: string) => {
    if (pending) return;
    const where = surface;
    setFailure(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await fn();
        onDone?.();
        if (done) setNotice(done);
      } catch (e) {
        setFailure({ surface: where, error: await toFeedbackError(e, "That could not be saved.") });
      }
    });
  };

  const activeGates = gates.filter((g) => g.is_active);

  return (
    <div className="space-y-lg">
      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      <ErrorAlert error={errorFor("page")} />

      {/* ── Awaiting authorization ───────────────────────────────── */}
      {candidates.length > 0 && (
        <section className="bg-warning/5 border border-warning/20 rounded-2xl">
          <div className="px-lg py-md border-b border-warning/20">
            <h2 className="text-sm font-bold text-warning">Awaiting authorization ({candidates.length})</h2>
            <p className="text-xs text-on-surface-variant mt-xs">
              These accounts can sign in but cannot operate a gate until you authorize them.
            </p>
          </div>
          <ul className="divide-y divide-warning/10">
            {candidates.map((c) => (
              <li key={c.id} className="px-lg py-md flex items-center gap-md">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-on-surface truncate">{c.full_name}</div>
                  <div className="text-xs text-outline truncate">{c.email}</div>
                </div>
                <Button size="sm" onClick={() => { setEmployeeCode(""); setAuthorizing(c); }} disabled={pending}>
                  Authorize
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Roster ───────────────────────────────────────────────── */}
      <section className="bg-surface-container-lowest border border-outline-variant rounded-2xl">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Security personnel ({personnel.length})</h2>
        </div>
        <ul className="divide-y divide-outline-variant">
          {personnel.length === 0 && (
            <li className="p-xl text-center text-sm text-outline">
              No security personnel yet. Invite one, then authorize the account.
            </li>
          )}
          {personnel.map((p) => (
            <li key={p.id} className="px-lg py-md">
              <div className="flex items-start justify-between gap-md flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-sm">
                    <span className="text-sm font-semibold text-on-surface">{p.full_name}</span>
                    <StatusBadge status={p.status.toLowerCase()} />
                    {p.employee_code && <span className="text-xs text-outline">{p.employee_code}</span>}
                  </div>
                  <div className="text-xs text-outline mt-xs">{p.email}</div>
                  <div className="flex flex-wrap gap-xs mt-sm">
                    {p.gates.length === 0 && <span className="text-xs text-warning font-medium">No gate assigned</span>}
                    {p.gates.map((g) => (
                      <span key={g.assignmentId} className="inline-flex items-center gap-xs text-xs bg-surface-container-low border border-outline-variant rounded-full pl-sm pr-xs py-[2px]">
                        {g.code}
                        <button
                          type="button"
                          aria-label={`Unassign ${g.code}`}
                          className="text-outline hover:text-error px-xs"
                          onClick={() => run(() => revokeGateAssignment(g.assignmentId), undefined, "Gate assignment removed.")}
                          disabled={pending}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="text-xs text-outline mt-sm">
                    {p.permissions.length} of {GATE_SECURITY_CAPABILITIES.length} capabilities
                  </div>
                  {p.deactivation_reason && (
                    <div className="text-xs text-error mt-xs">Deactivated: {p.deactivation_reason}</div>
                  )}
                </div>

                <div className="flex gap-xs flex-wrap shrink-0">
                  {p.status !== "DEACTIVATED" && (
                    <Button size="sm" variant="outline" onClick={() => { setAssignGateId(""); setAssigning(p); }} disabled={pending}>
                      Assign gate
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => { setCaps(p.permissions); setEditing(p); }} disabled={pending}>
                    Permissions
                  </Button>
                  {p.status === "ACTIVE" && (
                    <Button size="sm" variant="outline" onClick={() => run(() => setSecurityPersonnelStatus({ personnelId: p.id, status: "SUSPENDED" }), undefined, `${p.full_name} suspended.`)} disabled={pending}>
                      Suspend
                    </Button>
                  )}
                  {(p.status === "SUSPENDED" || p.status === "PENDING") && (
                    <Button size="sm" onClick={() => run(() => setSecurityPersonnelStatus({ personnelId: p.id, status: "ACTIVE" }), undefined, `${p.full_name} reactivated.`)} disabled={pending}>
                      Activate
                    </Button>
                  )}
                  {p.status !== "DEACTIVATED" && (
                    <Button size="sm" variant="destructive" onClick={() => { setDeactivateReason(""); setDeactivating(p); }} disabled={pending}>
                      Deactivate
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Gates ────────────────────────────────────────────────── */}
      <section className="bg-surface-container-lowest border border-outline-variant rounded-2xl">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between gap-md">
          <h2 className="text-sm font-bold text-on-surface">Gates ({gates.length})</h2>
          <Button size="sm" onClick={() => { setGateForm({ code: "", name: "", description: "" }); setNewGate(true); }} disabled={pending}>
            + Add gate
          </Button>
        </div>
        <ul className="divide-y divide-outline-variant">
          {gates.length === 0 && <li className="p-xl text-center text-sm text-outline">No gates defined yet.</li>}
          {gates.map((g) => (
            <li key={g.id} className="px-lg py-md flex items-center gap-md">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-on-surface">
                  {g.code} — {g.name}
                </div>
                {g.description && <div className="text-xs text-outline mt-xs">{g.description}</div>}
              </div>
              <span className={`text-xs font-semibold ${g.is_active ? "text-success" : "text-outline"}`}>
                {g.is_active ? "Active" : "Retired"}
              </span>
              <Button size="sm" variant="outline" onClick={() => run(() => setGateActive(g.id, !g.is_active), undefined, `${g.name} ${g.is_active ? "deactivated" : "activated"}.`)} disabled={pending}>
                {g.is_active ? "Retire" : "Reopen"}
              </Button>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Instructions ─────────────────────────────────────────── */}
      <section className="bg-surface-container-lowest border border-outline-variant rounded-2xl">
        <div className="px-lg py-md border-b border-outline-variant flex items-center justify-between gap-md">
          <h2 className="text-sm font-bold text-on-surface">Security instructions</h2>
          <Button size="sm" onClick={() => setInstruction(true)} disabled={pending}>
            + New instruction
          </Button>
        </div>
        <ul className="divide-y divide-outline-variant">
          {instructions.length === 0 && <li className="p-xl text-center text-sm text-outline">Nothing issued yet.</li>}
          {instructions.map((i) => (
            <li key={i.id} className="px-lg py-md flex items-start gap-md">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-sm flex-wrap">
                  <span className="text-sm font-semibold text-on-surface">{i.title}</span>
                  {i.priority !== "normal" && (
                    <span className={`text-[10px] font-bold uppercase px-sm py-[2px] rounded-full ${i.priority === "emergency" ? "bg-error/15 text-error" : "bg-warning/15 text-warning"}`}>
                      {i.priority}
                    </span>
                  )}
                  <span className="text-xs text-outline">{i.audience}</span>
                  {i.status !== "active" && <span className="text-xs text-outline">· {i.status}</span>}
                </div>
                <p className="text-sm text-on-surface-variant mt-xs">{i.message}</p>
                <div className="text-xs text-outline mt-xs">{new Date(i.created_at).toLocaleString()}</div>
              </div>
              {i.status === "active" && (
                <Button size="sm" variant="outline" onClick={() => run(() => withdrawSecurityInstruction(i.id), undefined, "Instruction withdrawn.")} disabled={pending}>
                  Withdraw
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* ── Modals ───────────────────────────────────────────────── */}
      <Modal
        open={!!authorizing}
        onClose={() => setAuthorizing(null)}
        title="Authorize for gate duty"
        description={`${authorizing?.full_name ?? ""} will be able to operate the gates you assign, and nothing else in the system.`}
        footer={
          <div className="flex justify-end gap-sm">
            <Button variant="ghost" onClick={() => setAuthorizing(null)}>Cancel</Button>
            <Button
              disabled={pending}
              aria-busy={pending || undefined}
              onClick={() =>
                run(
                  () => authorizeSecurityPersonnel({ profileId: authorizing!.id, employeeCode: employeeCode || undefined }),
                  () => setAuthorizing(null),
                  `${authorizing!.full_name} authorized for gate duty. Assign a gate next.`
                )
              }
            >
              {pending ? "Authorizing..." : "Authorize"}
            </Button>
          </div>
        }
      >
        <div className="space-y-md">
          <ErrorAlert error={errorFor("authorize")} />
          <FormField label="Employee code (optional)" id="emp-code" value={employeeCode} onChange={setEmployeeCode} placeholder="SEC-04" />
          <p className="text-xs text-outline">
            They start with the standard operational capabilities. Assign at least one gate afterwards — a guard with no
            gate cannot scan anything.
          </p>
        </div>
      </Modal>

      <Modal
        open={!!assigning}
        onClose={() => setAssigning(null)}
        title="Assign a gate"
        description={`${assigning?.full_name ?? ""} will be able to record movements at this gate, and only at gates assigned here.`}
        footer={
          <div className="flex justify-end gap-sm">
            <Button variant="ghost" onClick={() => setAssigning(null)}>Cancel</Button>
            <Button
              disabled={!assignGateId || pending}
              aria-busy={pending || undefined}
              onClick={() => run(() => assignGate(assigning!.id, assignGateId), () => setAssigning(null), "Gate assigned.")}
            >
              Assign
            </Button>
          </div>
        }
      >
        <ErrorAlert error={errorFor("assign")} className="mb-md" />
        <FormField
          label="Gate"
          id="assign-gate"
          type="select"
          value={assignGateId}
          onChange={setAssignGateId}
          options={activeGates.map((g) => ({ value: g.id, label: `${g.code} — ${g.name}` }))}
          required
        />
      </Modal>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Capabilities"
        description={`What ${editing?.full_name ?? "this guard"} may do while on duty.`}
        footer={
          <div className="flex justify-end gap-sm">
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={pending} aria-busy={pending || undefined} onClick={() => run(() => setSecurityPermissions(editing!.id, caps), () => setEditing(null), "Capabilities saved.")}>
              Save
            </Button>
          </div>
        }
      >
        <div className="space-y-xs">
          <ErrorAlert error={errorFor("capabilities")} />
          {GATE_SECURITY_CAPABILITIES.map((cap) => (
            <label key={cap} className="flex items-center gap-sm text-sm text-on-surface py-xs">
              <input
                type="checkbox"
                className="rounded border-outline-variant"
                checked={caps.includes(cap)}
                onChange={(e) => setCaps((prev) => (e.target.checked ? [...prev, cap] : prev.filter((c) => c !== cap)))}
              />
              <span>{CAPABILITY_LABEL[cap] ?? cap}</span>
              <code className="ml-auto text-[10px] text-outline">{cap}</code>
            </label>
          ))}
        </div>
      </Modal>

      <Modal
        open={!!deactivating}
        onClose={() => setDeactivating(null)}
        title="Deactivate this guard"
        description="Deactivation is permanent. Re-employing them later is a new authorization, with its own record."
        footer={
          <div className="flex justify-end gap-sm">
            <Button variant="ghost" onClick={() => setDeactivating(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deactivateReason.trim().length < 5 || pending}
              aria-busy={pending || undefined}
              onClick={() =>
                run(
                  () => setSecurityPersonnelStatus({ personnelId: deactivating!.id, status: "DEACTIVATED", reason: deactivateReason }),
                  () => setDeactivating(null),
                  `${deactivating!.full_name} deactivated.`
                )
              }
            >
              Deactivate
            </Button>
          </div>
        }
      >
        <ErrorAlert error={errorFor("deactivate")} className="mb-md" />
        <FormField label="Reason" id="deact-reason" type="textarea" rows={3} value={deactivateReason} onChange={setDeactivateReason} required />
      </Modal>

      <Modal
        open={newGate}
        onClose={() => setNewGate(false)}
        title="Add a gate"
        footer={
          <div className="flex justify-end gap-sm">
            <Button variant="ghost" onClick={() => setNewGate(false)}>Cancel</Button>
            <Button
              disabled={!gateForm.code.trim() || !gateForm.name.trim() || pending}
              aria-busy={pending || undefined}
              onClick={() => run(() => createGate(gateForm), () => setNewGate(false), `Gate ${gateForm.name} added.`)}
            >
              Add
            </Button>
          </div>
        }
      >
        <div className="space-y-md">
          <ErrorAlert error={errorFor("gate")} />
          <FormField label="Code" id="gate-code" value={gateForm.code} onChange={(v) => setGateForm((f) => ({ ...f, code: v }))} placeholder="MAIN" required />
          <FormField label="Name" id="gate-name" value={gateForm.name} onChange={(v) => setGateForm((f) => ({ ...f, name: v }))} placeholder="Main Gate" required />
          <FormField label="Description" id="gate-desc" value={gateForm.description} onChange={(v) => setGateForm((f) => ({ ...f, description: v }))} />
        </div>
      </Modal>

      <Modal
        open={instruction}
        onClose={() => setInstruction(false)}
        title="Issue a security instruction"
        description="It stays on the guard's dashboard while it is in force, and is delivered as a notification now."
        footer={
          <div className="flex justify-end gap-sm">
            <Button variant="ghost" onClick={() => setInstruction(false)}>Cancel</Button>
            <Button
              disabled={!instructionForm.title.trim() || !instructionForm.message.trim() || pending}
              aria-busy={pending || undefined}
              onClick={() =>
                run(
                  () =>
                    sendSecurityInstruction({
                      title: instructionForm.title,
                      message: instructionForm.message,
                      priority: instructionForm.priority,
                      audience: instructionForm.audience,
                      gateId: instructionForm.audience === "gate" ? instructionForm.gateId : null,
                      personnelId: instructionForm.audience === "person" ? instructionForm.personnelId : null,
                    }),
                  () => {
                    setInstruction(false);
                    setInstructionForm({ title: "", message: "", priority: "normal", audience: "all", gateId: "", personnelId: "" });
                  },
                  "Instruction issued."
                )
              }
            >
              Issue
            </Button>
          </div>
        }
      >
        <div className="space-y-md">
          <ErrorAlert error={errorFor("instruction")} />
          <FormField label="Title" id="ins-title" value={instructionForm.title} onChange={(v) => setInstructionForm((f) => ({ ...f, title: v }))} required />
          <FormField label="Message" id="ins-message" type="textarea" rows={4} value={instructionForm.message} onChange={(v) => setInstructionForm((f) => ({ ...f, message: v }))} required />
          <FormField
            label="Priority"
            id="ins-priority"
            type="select"
            value={instructionForm.priority}
            onChange={(v) => setInstructionForm((f) => ({ ...f, priority: v as typeof f.priority }))}
            options={[
              { value: "normal", label: "Normal" },
              { value: "high", label: "High" },
              { value: "emergency", label: "Emergency" },
            ]}
          />
          <FormField
            label="Who it applies to"
            id="ins-audience"
            type="select"
            value={instructionForm.audience}
            onChange={(v) => setInstructionForm((f) => ({ ...f, audience: v as typeof f.audience }))}
            options={[
              { value: "all", label: "All security personnel" },
              { value: "gate", label: "Everyone at one gate" },
              { value: "person", label: "One guard" },
            ]}
          />
          {instructionForm.audience === "gate" && (
            <FormField
              label="Gate"
              id="ins-gate"
              type="select"
              value={instructionForm.gateId}
              onChange={(v) => setInstructionForm((f) => ({ ...f, gateId: v }))}
              options={activeGates.map((g) => ({ value: g.id, label: `${g.code} — ${g.name}` }))}
              required
            />
          )}
          {instructionForm.audience === "person" && (
            <FormField
              label="Guard"
              id="ins-person"
              type="select"
              value={instructionForm.personnelId}
              onChange={(v) => setInstructionForm((f) => ({ ...f, personnelId: v }))}
              options={personnel.filter((p) => p.status === "ACTIVE").map((p) => ({ value: p.id, label: p.full_name }))}
              required
            />
          )}
        </div>
      </Modal>
    </div>
  );
}
