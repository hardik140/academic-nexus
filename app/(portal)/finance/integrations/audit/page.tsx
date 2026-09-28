"use client";

import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import Link from "next/link";
import { integrationAuditTrail } from "../actions";

/**
 * The integration audit view (§88).
 *
 * Reads the application's existing audit_logs rather than a second trail —
 * every action in the hub writes there through logAudit, so this is a filter
 * over one immutable store, not a parallel one that could disagree with it.
 *
 * The questions §88 requires to be answerable — who connected Tally, when,
 * which company, who changed a ledger mapping, who retried a payment, who
 * resolved a discrepancy — are each one row here.
 */

/**
 * Declared rather than derived: the query embeds `actor:user_id(...)`, and
 * the hand-maintained Database type carries no Relationships, so supabase-js
 * cannot infer an embedded shape. Same workaround every other file with an
 * embedded select uses (see finance/refunds/actions.ts).
 */
type Entry = {
  id: string;
  created_at: string;
  action: string;
  table_name: string;
  record_id: string | null;
  new_value: unknown;
  actor?: { full_name: string; role: string } | null;
};

const ACTION_LABEL: Record<string, string> = {
  finance_connection_created: "Integration created",
  finance_credential_stored: "Credential stored",
  finance_connection_verified: "Company verified",
  finance_connection_test_failed: "Connection test failed",
  finance_connection_activated: "Integration activated",
  finance_connection_disabled: "Integration disabled",
  finance_mapping_changed: "Mapping changed",
  finance_sync_started: "Synchronisation queued",
  finance_sync_retried: "Operation retried",
  finance_sync_cancelled: "Operation cancelled",
  finance_reconciliation_reconciled: "Reconciliation — matched",
  finance_reconciliation_reconciliation_required: "Reconciliation — differences found",
  finance_reconciliation_failed: "Reconciliation failed",
  finance_reconciliation_resolved: "Finding resolved",
};

export default function IntegrationAuditPage() {
  // A failed load is an error, never "Nothing recorded yet." (owner decision D5).
  const trail = useAsyncResource(async () => (await integrationAuditTrail()) as unknown as Entry[], []);

  return (
    <div className="space-y-lg">
      <div>
        <Link href="/finance/integrations" className="text-sm text-secondary font-semibold hover:underline">← Integrations</Link>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight mt-xs">Integration Audit</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Who did what to the accounting integration, and when. Immutable: these rows are never edited or deleted.
        </p>
      </div>

      <StateView state={trail} loadingLabel="Loading the audit trail…" empty={{ title: "Nothing recorded yet" }}>
        {(entries) => (
        <div className="overflow-x-auto rounded-2xl border border-outline-variant">
          <table className="w-full text-sm min-w-[860px]">
            <thead className="bg-surface-container-low text-xs uppercase tracking-wide text-on-surface-variant">
              <tr>
                <th className="text-left px-md py-sm font-semibold">When</th>
                <th className="text-left px-md py-sm font-semibold">Who</th>
                <th className="text-left px-md py-sm font-semibold">Action</th>
                <th className="text-left px-md py-sm font-semibold">Record</th>
                <th className="text-left px-md py-sm font-semibold">Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t border-outline-variant/60 align-top">
                  <td className="px-md py-sm text-on-surface-variant whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</td>
                  <td className="px-md py-sm">
                    <span className="font-medium text-on-surface">{e.actor?.full_name ?? "—"}</span>
                    <span className="block text-xs text-on-surface-variant">{e.actor?.role ?? ""}</span>
                  </td>
                  <td className="px-md py-sm text-on-surface">{ACTION_LABEL[e.action] ?? e.action}</td>
                  <td className="px-md py-sm">
                    <span className="text-xs text-on-surface-variant">{e.table_name}</span>
                    <span className="block font-mono text-xs text-on-surface-variant">{String(e.record_id ?? "").slice(0, 8)}</span>
                  </td>
                  <td className="px-md py-sm max-w-lg">
                    <pre className="text-xs text-on-surface-variant whitespace-pre-wrap break-words">
                      {e.new_value ? JSON.stringify(e.new_value) : "—"}
                    </pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </StateView>
    </div>
  );
}
