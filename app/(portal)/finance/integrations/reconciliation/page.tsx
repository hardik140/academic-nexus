"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { classifyError } from "@/lib/feedback-error";
import Link from "next/link";
import { Button, FormField, Modal, StatusBadge } from "@/components/ui/modal";
import { listConnections, listReconciliation, resolveReconciliationItem, runReconciliation } from "../actions";

/**
 * Reconciliation (§64, §80, §98).
 *
 * The headline is deliberately three numbers, not one: what Academic Nexus
 * collected, what the accounting system holds, and the difference. A single
 * "synced" tick hides exactly the case this page exists for — both systems
 * responding normally while disagreeing about the money.
 *
 * Each finding names the transaction. Resolving one records a sentence and
 * the person who wrote it; it never edits the finding, and it never changes
 * a financial record.
 */

type Data = Awaited<ReturnType<typeof listReconciliation>>;
type Connection = Awaited<ReturnType<typeof listConnections>>[number];
type Item = Data["openItems"][number];

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-IN", { style: "currency", currency: "INR" });

export default function ReconciliationPage() {
  const [data, setData] = useState<Data>({ runs: [], openItems: [] });
  const [connections, setConnections] = useState<Connection[]>([]);
  // Loading and acting fail separately; findings that could not be loaded
  // are never "Nothing outstanding." (owner decision D5).
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ connectionId: "", from: today.slice(0, 8) + "01", to: today });
  const [resolving, setResolving] = useState<Item | null>(null);
  const [resolution, setResolution] = useState("");

  const load = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([listReconciliation(), listConnections()]);
      setData(d);
      setConnections(c);
      if (!form.connectionId && c.length > 0) setForm((f) => ({ ...f, connectionId: c[0].id }));
      setLoaded(true);
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
    }
    // form.connectionId intentionally omitted: this only seeds the first value
  }, [form.connectionId]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
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

  const latest = data.runs[0];

  return (
    <div className="space-y-lg">
      <div>
        <Link href="/finance/integrations" className="text-sm text-secondary font-semibold hover:underline">← Integrations</Link>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight mt-xs">Reconciliation</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Do the two systems agree? Synchronisation status alone cannot answer that.
        </p>
      </div>

      {/* The resolve dialog shows its own failure. */}
      <ErrorAlert error={resolving === null ? error : null} />

      <Alert tone="error" action={<Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>}>
        {loadError !== null && loaded ? (
          <>
            This couldn&apos;t be refreshed. Showing what was loaded earlier.
          </>
        ) : null}
      </Alert>

      <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg space-y-md">
        <h2 className="text-sm font-bold uppercase tracking-wide text-on-surface-variant">Run a comparison</h2>
        <div className="grid md:grid-cols-4 gap-md items-end">
          <label className="text-sm md:col-span-2">
            <span className="block text-xs uppercase tracking-wide text-on-surface-variant mb-xs">Connection</span>
            <select
              className="w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-sm text-sm"
              value={form.connectionId}
              onChange={(e) => setForm({ ...form, connectionId: e.target.value })}
            >
              {connections.map((c) => <option key={c.id} value={c.id}>{c.display_name} ({c.status})</option>)}
            </select>
          </label>
          <FormField label="From" id="from" type="date" value={form.from} onChange={(v) => setForm({ ...form, from: v })} required />
          <FormField label="To" id="to" type="date" value={form.to} onChange={(v) => setForm({ ...form, to: v })} required />
        </div>
        <Button
          disabled={!form.connectionId || busy === "run"}
          aria-busy={busy === "run" || undefined}
          onClick={() => run("run", () => runReconciliation({ connectionId: form.connectionId, from: form.from, to: form.to }))}
        >
          {busy === "run" ? "Comparing..." : "Reconcile"}
        </Button>
      </div>

      {latest && (
        <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg">
          <div className="flex items-center gap-md flex-wrap">
            <h2 className="text-sm font-bold uppercase tracking-wide text-on-surface-variant">Latest run</h2>
            <StatusBadge status={latest.status} />
            <span className="text-xs text-on-surface-variant">{latest.period_start} → {latest.period_end}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-md mt-md">
            <div>
              <p className="text-xs uppercase tracking-wide text-on-surface-variant">Academic Nexus</p>
              <p className="text-xl font-extrabold text-on-surface tabular-nums mt-xs">{money(latest.local_amount)}</p>
              <p className="text-xs text-on-surface-variant tabular-nums">{latest.local_count ?? 0} payments</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-on-surface-variant">Accounting system</p>
              <p className="text-xl font-extrabold text-on-surface tabular-nums mt-xs">{money(latest.external_amount)}</p>
              <p className="text-xs text-on-surface-variant tabular-nums">{latest.external_count ?? 0} documents</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-on-surface-variant">Difference</p>
              <p className={`text-xl font-extrabold tabular-nums mt-xs ${Math.abs(Number(latest.difference_amount ?? 0)) > 0.005 ? "text-error" : "text-success"}`}>
                {money(latest.difference_amount)}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-on-surface-variant">Findings</p>
              <p className={`text-xl font-extrabold tabular-nums mt-xs ${latest.issue_count > 0 ? "text-warning" : "text-success"}`}>{latest.issue_count}</p>
            </div>
          </div>
          {latest.error_message && <p className="text-sm text-error mt-md">{latest.error_message}</p>}
        </div>
      )}

      <div>
        <h2 className="text-sm font-bold uppercase tracking-wide text-on-surface-variant mb-md">
          Open findings ({data.openItems.length})
        </h2>
        {!loaded ? (
          loadError !== null ? (
            <ErrorState {...classifyError(loadError)} title="Findings couldn't be loaded" onRetry={() => void load()} />
          ) : (
            <LoadingState label="Loading findings…" />
          )
        ) : data.openItems.length === 0 ? (
          <p className="text-sm text-on-surface-variant">Nothing outstanding.</p>
        ) : (
          <div className="space-y-sm">
            {data.openItems.map((item) => (
              <div key={item.id} className="rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
                <div className="flex items-start justify-between gap-md flex-wrap">
                  <div className="min-w-0">
                    <span className="text-xs font-mono font-semibold text-error">{item.difference_type}</span>
                    <p className="text-sm text-on-surface mt-xs">{item.detail}</p>
                    <p className="text-xs text-on-surface-variant mt-xs tabular-nums">
                      {item.local_amount !== null && <>here {money(item.local_amount)} </>}
                      {item.external_amount !== null && <>· there {money(item.external_amount)}</>}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => { setResolving(item); setResolution(""); }}>Resolve</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={resolving !== null}
        onClose={() => setResolving(null)}
        title="Resolve finding"
        footer={
          <>
            <Button variant="outline" onClick={() => setResolving(null)}>Cancel</Button>
            <Button
              disabled={!resolution.trim() || busy === resolving?.id}
              aria-busy={busy === resolving?.id || undefined}
              onClick={() =>
                resolving &&
                run(resolving.id, async () => {
                  await resolveReconciliationItem(resolving.id, resolution);
                  setResolving(null);
                })
              }
            >
              Record resolution
            </Button>
          </>
        }
      >
        <div className="space-y-md">
          <ErrorAlert error={error} />
          <p className="text-sm text-on-surface">{resolving?.detail}</p>
          <FormField
            label="What was done about it"
            id="resolution"
            type="textarea"
            value={resolution}
            onChange={setResolution}
            placeholder="e.g. Voucher RV-000451 was voided in Tally by mistake and has been re-entered against the same reference."
            required
          />
          <p className="text-xs text-on-surface-variant">
            This records your explanation against the finding. It does not change any payment, fee or external document.
          </p>
        </div>
      </Modal>
    </div>
  );
}
