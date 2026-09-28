"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, StatusBadge } from "@/components/ui/modal";
import { cancelOperation, listConnections, listSyncOperations, retryOperation } from "../actions";

/**
 * The sync-operation journal (§67).
 *
 * Every row answers the four questions §101 requires to be answerable:
 * what was attempted, what the provider said, which external document
 * resulted, and — when nothing resulted — exactly why and whether it is safe
 * to try again.
 *
 * Retry is offered ONLY where the pipeline classified the failure `safe`.
 * For an unknown result the button is absent and the reason is shown in its
 * place, because a second POST is how one payment becomes two receipts.
 */

type Operation = Awaited<ReturnType<typeof listSyncOperations>>[number];
type Connection = Awaited<ReturnType<typeof listConnections>>[number];

const STATUSES = [
  "PENDING", "QUEUED", "PROCESSING", "SYNCED", "PARTIALLY_SYNCED",
  "FAILED", "RETRYING", "RECONCILIATION_REQUIRED", "BLOCKED", "CANCELLED",
] as const;

export default function SyncOperationsPage() {
  const [operations, setOperations] = useState<Operation[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [filters, setFilters] = useState<{ connectionId: string; status: string }>({ connectionId: "", status: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ops, conns] = await Promise.all([
        listSyncOperations({
          connectionId: filters.connectionId || undefined,
          status: (filters.status || undefined) as Operation["status"] | undefined,
        }),
        listConnections(),
      ]);
      setOperations(ops);
      setConnections(conns);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load sync operations.");
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The action did not complete.");
    } finally {
      setBusy(null);
    }
  };

  const connectionName = (id: string) => connections.find((c) => c.id === id)?.display_name ?? id.slice(0, 8);

  return (
    <div className="space-y-lg">
      <div>
        <Link href="/finance/integrations" className="text-sm text-secondary font-semibold hover:underline">← Integrations</Link>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight mt-xs">Sync Operations</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Every attempt to mirror a transaction outward, with what came back.
        </p>
      </div>

      {error && <div className="bg-error/10 border border-error/20 text-error rounded-xl p-md text-sm font-medium">{error}</div>}

      <div className="flex flex-wrap gap-md items-end">
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-on-surface-variant mb-xs">Connection</span>
          <select
            className="rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm text-sm"
            value={filters.connectionId}
            onChange={(e) => setFilters({ ...filters, connectionId: e.target.value })}
          >
            <option value="">All</option>
            {connections.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-on-surface-variant mb-xs">Status</span>
          <select
            className="rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm text-sm"
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          >
            <option value="">All</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>

      {operations.length === 0 ? (
        <p className="text-sm text-on-surface-variant">No operations match.</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-outline-variant">
          <table className="w-full text-sm min-w-[1000px]">
            <thead className="bg-surface-container-low text-xs uppercase tracking-wide text-on-surface-variant">
              <tr>
                <th className="text-left px-md py-sm font-semibold">Entity</th>
                <th className="text-left px-md py-sm font-semibold">Operation</th>
                <th className="text-left px-md py-sm font-semibold">Connection</th>
                <th className="text-left px-md py-sm font-semibold">Status</th>
                <th className="text-left px-md py-sm font-semibold">External document</th>
                <th className="text-left px-md py-sm font-semibold">Detail</th>
                <th className="text-right px-md py-sm font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((op) => (
                <tr key={op.id} className="border-t border-outline-variant/60 align-top">
                  <td className="px-md py-sm">
                    <span className="font-medium text-on-surface">{op.entity_type}</span>
                    <span className="block font-mono text-xs text-on-surface-variant">{op.entity_id?.slice(0, 8) ?? "—"}</span>
                  </td>
                  <td className="px-md py-sm text-on-surface-variant">{op.operation}</td>
                  <td className="px-md py-sm text-on-surface-variant">{connectionName(op.connection_id)}</td>
                  <td className="px-md py-sm">
                    <StatusBadge status={op.status} />
                    {op.attempt_number > 0 && (
                      <span className="block text-xs text-on-surface-variant mt-xs tabular-nums">
                        attempt {op.attempt_number}/{op.max_attempts}
                      </span>
                    )}
                  </td>
                  <td className="px-md py-sm">
                    {op.external_id ? (
                      <>
                        <span className="font-mono text-xs text-on-surface">{op.external_id}</span>
                        {op.external_number && <span className="block text-xs text-on-surface-variant">{op.external_number}</span>}
                      </>
                    ) : (
                      <span className="text-on-surface-variant">—</span>
                    )}
                  </td>
                  <td className="px-md py-sm max-w-md">
                    {op.error_code && <span className="font-mono text-xs text-error">{op.error_code}</span>}
                    {op.error_message && <span className="block text-xs text-on-surface-variant">{op.error_message}</span>}
                    {op.status === "RECONCILIATION_REQUIRED" && (
                      <span className="block text-xs text-warning mt-xs">
                        Not safe to retry — the provider may already hold this document. Reconcile first.
                      </span>
                    )}
                  </td>
                  <td className="px-md py-sm">
                    <div className="flex justify-end gap-xs">
                      {op.status === "FAILED" && op.retry_safety === "safe" && op.attempt_number < op.max_attempts && (
                        <Button size="sm" disabled={busy === op.id} onClick={() => act(op.id, () => retryOperation(op.id))}>Retry</Button>
                      )}
                      {["PENDING", "BLOCKED", "FAILED"].includes(op.status) && (
                        <Button size="sm" variant="outline" disabled={busy === op.id} onClick={() => act(op.id, () => cancelOperation(op.id))}>Cancel</Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
