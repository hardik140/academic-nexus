"use client";

import { useEffect, useRef, useState } from "react";
import { Button, FormField, Modal, StatusBadge } from "@/components/ui/modal";
import { DataTable, type DataTableQuery } from "@/components/ui/data-table";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import {
  actOnGatePass,
  listGatesForOverride,
  listPendingGatePasses,
  listProcessedGatePasses,
  recordManualGateMovement,
  revokeGatePassCredential,
} from "./actions";

const PROCESSED_PAGE_SIZE = 10;

export default function WardenGatePasses() {
  const [processed, setProcessed] = useState<any[]>([]);
  const [processedLoading, setProcessedLoading] = useState(false);
  const [processedError, setProcessedError] = useState<unknown>(null);
  const [totalProcessed, setTotalProcessed] = useState(0);
  const [processedQuery, setProcessedQuery] = useState<DataTableQuery>({ search: "", sortKey: null, sortDir: "asc", page: 0 });
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latestProcessed = useRef(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadProcessed(processedQuery); }, [processedQuery]);

  // Not paginated — this is the "needs your attention now" list, meant to
  // show everything actionable rather than page through it. Was previously
  // derived by filtering an already-fetched 500-row array; now scoped
  // server-side instead of over-fetching approved/rejected/etc. rows just
  // to discard them.
  //
  // A failed load is an error, never "No pending gate passes" — an empty
  // queue would read as every student's request handled (owner decision D5).
  const pendingResource = useAsyncResource(() => listPendingGatePasses(), []);
  const pending: any[] = pendingResource.data ?? [];

  const loadProcessed = async (q: DataTableQuery) => {
    const run = ++latestProcessed.current;
    setProcessedLoading(true);
    setProcessedError(null);
    try {
      const { data, count } = await listProcessedGatePasses(q);
      if (run !== latestProcessed.current) return;
      setProcessed(data);
      setTotalProcessed(count);
    } catch (e) {
      if (run === latestProcessed.current) setProcessedError(e);
    } finally {
      if (run === latestProcessed.current) setProcessedLoading(false);
    }
  };

  const handleAction = async (id: string, action: "approved" | "rejected") => {
    if (loading) return;
    setLoading(id);
    setError(null);
    setNotice(null);
    try {
      await actOnGatePass(id, action);
      setNotice(`Gate pass ${action}.`);
      // Reloading reports its own failure, never as a failed decision.
      pendingResource.reload();
      void loadProcessed(processedQuery);
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to update gate pass."));
    } finally {
      setLoading(null);
    }
  };

  // The manual override (migration 050 §13). This used to be a one-click
  // "Verify Exit" that wrote the timestamp directly. It is now a recorded
  // exception: the ordinary path is a guard scanning the student's QR at a
  // gate, and taking that path out of the guard's hands needs a reason
  // attached to it, because the ledger is what anyone reviewing an incident
  // will read months later.
  const [override, setOverride] = useState<{ id: string; action: "exit" | "return"; student: string } | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideGate, setOverrideGate] = useState("");
  const [revoke, setRevoke] = useState<{ id: string; student: string } | null>(null);
  const [revokeReason, setRevokeReason] = useState("");

  // The gate is optional on a manual record, so a failure here does not
  // block one — but it is said, not hidden behind an empty list.
  const gatesResource = useAsyncResource(() => listGatesForOverride(), []);
  const gates: { id: string; code: string; name: string }[] = gatesResource.data ?? [];

  const openOverride = (id: string, action: "exit" | "return", student: string) => {
    setOverrideReason("");
    setOverrideGate("");
    setError(null);
    setOverride({ id, action, student });
  };

  const submitOverride = async () => {
    if (!override || loading) return;
    setLoading(override.id);
    setError(null);
    setNotice(null);
    try {
      await recordManualGateMovement({
        passId: override.id,
        action: override.action,
        gateId: overrideGate || null,
        reason: overrideReason,
      });
      setNotice(`${override.action === "exit" ? "Exit" : "Return"} recorded for ${override.student}.`);
      setOverride(null);
      void loadProcessed(processedQuery);
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to record the movement."));
    } finally {
      setLoading(null);
    }
  };

  const submitRevoke = async () => {
    if (!revoke || loading) return;
    setLoading(revoke.id);
    setError(null);
    setNotice(null);
    try {
      await revokeGatePassCredential(revoke.id, revokeReason);
      setNotice(`QR revoked for ${revoke.student}.`);
      setRevoke(null);
      void loadProcessed(processedQuery);
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to revoke the QR."));
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between gap-md flex-wrap">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Gate Passes</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Review and approve student out-of-campus requests</p>
        </div>
        {pending.length > 0 && (
          <span className="text-xs font-semibold px-md py-xs rounded-full bg-warning-container text-on-warning-container shrink-0">
            {pending.length} Require Action
          </span>
        )}
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      {/* An open dialog shows its own failure. */}
      <ErrorAlert error={!override && !revoke ? error : null} />

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Pending Requests ({pending.length})</h2>
        </div>
        <StateView state={pendingResource} isEmpty={() => false} loadingLabel="Loading pending gate passes…" empty={{ title: "No pending gate passes" }}>
          {() => (
        <div className="divide-y divide-outline-variant">
          {pending.length > 0 ? pending.map((pass: any) => (
            <div key={pass.id} className="px-lg py-md hover:bg-surface-container-low transition-colors">
              <div className="flex items-start justify-between gap-md">
                <div>
                  <div className="text-sm font-semibold text-on-surface">{(pass.students as any)?.profiles?.full_name}</div>
                  <div className="text-xs text-outline">{(pass.students as any)?.enrollment_number}</div>
                  <div className="text-xs text-on-surface-variant mt-xs">
                    {pass.destination} — {pass.reason}
                  </div>
                  <div className="text-xs text-outline mt-xs">
                    {new Date(pass.exit_time).toLocaleString()} → {new Date(pass.return_time).toLocaleString()}
                  </div>
                </div>
                <div className="flex gap-xs shrink-0">
                  <Button size="sm" variant="destructive" onClick={() => handleAction(pass.id, "rejected")} disabled={loading === pass.id}>
                    Reject
                  </Button>
                  <Button size="sm" onClick={() => handleAction(pass.id, "approved")} disabled={loading === pass.id} aria-busy={loading === pass.id || undefined}>
                    {loading === pass.id ? "..." : "Approve"}
                  </Button>
                </div>
              </div>
            </div>
          )) : (
            <div className="p-xl text-center text-sm text-outline">🎉 No pending gate passes.</div>
          )}
        </div>
          )}
        </StateView>
      </div>

      <DataTable
        title={`Processed History (${totalProcessed})`}
        columns={[
          { key: "student", header: "Student", render: (row: any) => (row.students as any)?.profiles?.full_name || "—" },
          { key: "exit_time", header: "Date", sortable: true, render: (row: any) => new Date(row.exit_time).toLocaleDateString() },
          { key: "destination", header: "Destination", sortable: true },
          { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.status} /> },
          {
            key: "movement",
            header: "Movement",
            render: (row: any) => {
              const student = (row.students as any)?.profiles?.full_name || "this student";
              if (row.status === "approved") {
                return (
                  <div className="flex gap-xs">
                    <Button size="sm" variant="outline" onClick={() => openOverride(row.id, "exit", student)} disabled={loading === row.id}>
                      Record exit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setRevokeReason(""); setRevoke({ id: row.id, student }); }} disabled={loading === row.id}>
                      Revoke QR
                    </Button>
                  </div>
                );
              }
              if (row.status === "active") {
                return (
                  <div className="flex gap-xs items-center">
                    <span className="text-xs font-semibold text-warning">Outside</span>
                    <Button size="sm" variant="outline" onClick={() => openOverride(row.id, "return", student)} disabled={loading === row.id}>
                      Record return
                    </Button>
                  </div>
                );
              }
              if (row.status === "returned") {
                return <span className="text-xs text-outline">✓ {row.actual_return ? new Date(row.actual_return).toLocaleString() : ""}</span>;
              }
              return <span className="text-xs text-outline">—</span>;
            },
          },
        ]}
        data={processed}
        keyExtractor={(row) => row.id}
        serverMode
        totalCount={totalProcessed}
        loading={processedLoading}
        error={processedError}
        onRetry={() => loadProcessed(processedQuery)}
        onQueryChange={setProcessedQuery}
        pageSize={PROCESSED_PAGE_SIZE}
        emptyMessage="No processed requests yet."
      />

      <Modal
        open={!!override}
        onClose={() => setOverride(null)}
        title={override?.action === "exit" ? "Record an exit manually" : "Record a return manually"}
        description={`The usual path is a security guard scanning ${override?.student ?? "the student"}'s QR at a gate. Recording it here is an exception, and it is kept in the movement ledger as one.`}
        footer={
          <div className="flex justify-end gap-sm">
            <Button variant="ghost" onClick={() => setOverride(null)}>Cancel</Button>
            <Button onClick={submitOverride} disabled={overrideReason.trim().length < 10 || loading === override?.id} aria-busy={loading === override?.id || undefined}>
              {loading === override?.id ? "Recording..." : "Record movement"}
            </Button>
          </div>
        }
      >
        <div className="space-y-md">
          <ErrorAlert error={error} />
          <Alert
            tone="warning"
            action={<Button variant="outline" size="sm" onClick={gatesResource.reload}>Try again</Button>}
          >
            {gatesResource.status === "error" ? (
              <>
                The list of gates couldn&apos;t be loaded. You can still record the movement without a gate.
              </>
            ) : null}
          </Alert>
          <FormField
            label="Gate"
            id="override-gate"
            type="select"
            value={overrideGate}
            onChange={setOverrideGate}
            options={gates.map((g) => ({ value: g.id, label: `${g.code} — ${g.name}` }))}
          />
          <FormField
            label="Why is this being recorded manually?"
            id="override-reason"
            type="textarea"
            rows={3}
            value={overrideReason}
            onChange={setOverrideReason}
            placeholder="e.g. student's phone battery died at the main gate; identity checked against hostel ID"
            required
          />
          <p className="text-xs text-outline">
            At least 10 characters. The reason, your name and the server time are written to the movement ledger and the audit log, and cannot be edited afterwards.
          </p>
        </div>
      </Modal>

      <Modal
        open={!!revoke}
        onClose={() => setRevoke(null)}
        title="Revoke this QR"
        description={`The approval stands — only the QR stops working. ${revoke?.student ?? "The student"} will need a new pass to go out.`}
        footer={
          <div className="flex justify-end gap-sm">
            <Button variant="ghost" onClick={() => setRevoke(null)}>Cancel</Button>
            <Button variant="destructive" onClick={submitRevoke} disabled={revokeReason.trim().length < 5 || loading === revoke?.id} aria-busy={loading === revoke?.id || undefined}>
              {loading === revoke?.id ? "Revoking..." : "Revoke"}
            </Button>
          </div>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <FormField
          label="Reason"
          id="revoke-reason"
          type="textarea"
          rows={3}
          value={revokeReason}
          onChange={setRevokeReason}
          placeholder="e.g. student reported the phone lost"
          required
        />
      </Modal>
    </div>
  );
}
