"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { classifyError } from "@/lib/feedback-error";
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
  const [error, setError] = useState<FeedbackError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Which filters the operations shown were loaded for: rows loaded for one
  // filter are never shown as the answer for another, and a failed load is
  // never "No operations match." (owner decision D5).
  const filterKey = `${filters.connectionId}|${filters.status}`;
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const latestLoad = useRef(0);
  const loaded = loadedFor === filterKey;

  const load = useCallback(async () => {
    const run = ++latestLoad.current;
    const key = `${filters.connectionId}|${filters.status}`;
    setLoadError(null);
    try {
      const [ops, conns] = await Promise.all([
        listSyncOperations({
          connectionId: filters.connectionId || undefined,
          status: (filters.status || undefined) as Operation["status"] | undefined,
        }),
        listConnections(),
      ]);
      if (run !== latestLoad.current) return;
      setOperations(ops);
      setConnections(conns);
      setLoadedFor(key);
    } catch (e) {
      if (run === latestLoad.current) setLoadError(e);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      await fn();
      // Reloading reports its own failure, never as a failed action.
      void load();
    } catch (e) {
      setError(await toFeedbackError(e, "The action did not complete."));
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

      <ErrorAlert error={error} />
      <Alert tone="error" action={<Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>}>
        {loadError !== null && loaded ? (
          <>
            This couldn&apos;t be refreshed. Showing what was loaded earlier.
          </>
        ) : null}
      </Alert>

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

      {!loaded ? (
        loadError !== null ? (
          <ErrorState {...classifyError(loadError)} title="Sync operations couldn't be loaded" onRetry={() => void load()} />
        ) : (
          <LoadingState label="Loading sync operations…" />
        )
      ) : operations.length === 0 ? (
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
                        <Button size="sm" disabled={busy === op.id} aria-busy={busy === op.id || undefined} onClick={() => act(op.id, () => retryOperation(op.id))}>Retry</Button>
                      )}
                      {["PENDING", "BLOCKED", "FAILED"].includes(op.status) && (
                        <Button size="sm" variant="outline" disabled={busy === op.id} aria-busy={busy === op.id || undefined} onClick={() => act(op.id, () => cancelOperation(op.id))}>Cancel</Button>
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
