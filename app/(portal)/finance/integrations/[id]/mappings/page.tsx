"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { classifyError, feedbackMessage } from "@/lib/feedback-error";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button, FormField, Modal } from "@/components/ui/modal";
import { discoverAccounts, listMappings, mappingReadiness, upsertMapping } from "../../actions";

/**
 * Account mapping (§48, §49, §62, §63).
 *
 * The gaps are shown FIRST, with how many live records each one blocks,
 * because "configuration error" without a list is not something anyone can
 * act on. A connection cannot be activated until this page is empty of gaps —
 * the server refuses, and so does the Activate button upstream.
 *
 * A payment mode needs two mappings, not one: the mode NAME the provider
 * understands, and the bank or cash LEDGER the money lands in. Conflating
 * them is how UPI collections end up in the cash account.
 */

type Mapping = Awaited<ReturnType<typeof listMappings>>[number];
type Readiness = Awaited<ReturnType<typeof mappingReadiness>>;
type Account = { id: string; name: string; code?: string };

const KIND_LABEL: Record<string, string> = {
  fee_head: "Fee head → income ledger",
  payment_method: "Payment mode → provider mode",
  bank_account: "Payment mode → bank / cash ledger",
  customer: "Student → party ledger / contact",
  tax_code: "Tax code",
  cost_center: "Cost centre",
  department: "Department",
  branch: "Branch",
};

export default function MappingsPage() {
  const params = useParams<{ id: string }>();
  const connectionId = params.id;

  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsNote, setAccountsNote] = useState<string | null>(null);
  // Loading and saving fail separately; a failed load is never "No mappings
  // configured yet" (owner decision D5).
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [editing, setEditing] = useState<{ kind: string; localKey: string; localLabel?: string } | null>(null);
  const [form, setForm] = useState({ externalName: "", externalId: "", externalCode: "", taxTreatment: "" });

  const load = useCallback(async () => {
    try {
      const [rows, ready] = await Promise.all([listMappings(connectionId), mappingReadiness(connectionId)]);
      setMappings(rows);
      setReadiness(ready);
      setLoaded(true);
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
    }
  }, [connectionId]);

  useEffect(() => {
    load();
  }, [load]);

  const pullAccounts = async () => {
    setBusy("accounts");
    setAccountsNote(null);
    try {
      const res = await discoverAccounts(connectionId);
      if (res.ok) {
        setAccounts(res.accounts);
        setAccountsNote(`${res.accounts.length} ledger(s) read from the provider.`);
      } else {
        setAccountsNote(res.message);
      }
    } catch (e) {
      setAccountsNote(feedbackMessage(e, "Could not read the chart of accounts."));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!editing || busy) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      await upsertMapping({
        connectionId,
        kind: editing.kind as Mapping["kind"],
        localKey: editing.localKey,
        localLabel: editing.localLabel,
        externalName: form.externalName,
        externalId: form.externalId || undefined,
        externalCode: form.externalCode || undefined,
        taxTreatment: (form.taxTreatment || undefined) as Mapping["tax_treatment"] extends null ? never : undefined,
      });
      setNotice(`Mapping for ${editing.localKey} saved.`);
      setEditing(null);
      setForm({ externalName: "", externalId: "", externalCode: "", taxTreatment: "" });
      // Reloading reports its own failure, never as a failed save.
      void load();
    } catch (e) {
      setError(await toFeedbackError(e, "Could not save the mapping."));
    } finally {
      setBusy(null);
    }
  };

  const openEditor = (kind: string, localKey: string, localLabel?: string) => {
    const existing = mappings.find((m) => m.kind === kind && m.local_key === localKey);
    setEditing({ kind, localKey, localLabel });
    setForm({
      externalName: existing?.external_name ?? "",
      externalId: existing?.external_id ?? "",
      externalCode: existing?.external_code ?? "",
      taxTreatment: existing?.tax_treatment ?? "",
    });
  };

  const grouped = mappings.reduce<Record<string, Mapping[]>>((acc, m) => {
    (acc[m.kind] ??= []).push(m);
    return acc;
  }, {});

  return (
    <div className="space-y-lg">
      <div>
        <Link href="/finance/integrations" className="text-sm text-secondary font-semibold hover:underline">← Integrations</Link>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight mt-xs">Account Mapping</h1>
        <p className="text-sm text-on-surface-variant mt-xs">
          Academic Nexus and your accounting system name things differently. Nothing is guessed — a transaction whose
          mapping is missing is blocked rather than posted to a default ledger.
        </p>
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      {/* The mapping dialog shows its own failure. */}
      <ErrorAlert error={editing === null ? error : null} />

      {!loaded && !loadError && <LoadingState label="Loading mappings…" />}
      {loadError !== null && !loaded && (
        <ErrorState {...classifyError(loadError)} title="Mappings couldn't be loaded" onRetry={() => void load()} />
      )}
      <Alert tone="error" action={<Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>}>
        {loadError !== null && loaded ? (
          <>
            This couldn&apos;t be refreshed. Showing what was loaded earlier.
          </>
        ) : null}
      </Alert>

      {readiness && (
        <div className={`rounded-2xl border p-lg ${readiness.ready ? "border-success/30 bg-success-container text-on-success-container" : "border-error/30 bg-error-container text-on-error-container"}`}>
          {readiness.ready ? (
            <p className="text-sm font-semibold">Mapping is complete. This connection can be activated.</p>
          ) : (
            <>
              <p className="text-sm font-semibold">
                {readiness.gaps.length} mapping{readiness.gaps.length === 1 ? "" : "s"} still missing.
              </p>
              <ul className="mt-md space-y-xs">
                {readiness.gaps.map((gap) => (
                  <li key={`${gap.kind}:${gap.localKey}`} className="flex items-center justify-between gap-md text-sm">
                    <span className="text-on-surface">
                      <span className="font-mono text-xs text-on-surface-variant">{gap.kind}</span>{" "}
                      <span className="font-medium">{gap.localKey}</span>
                      <span className="text-on-surface-variant"> — blocks {gap.affectedRecords} record(s)</span>
                    </span>
                    <Button size="sm" onClick={() => openEditor(gap.kind, gap.localKey)}>Map</Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="flex items-center gap-md">
        <Button variant="outline" disabled={busy === "accounts"} aria-busy={busy === "accounts" || undefined} onClick={pullAccounts}>
          {busy === "accounts" ? "Reading..." : "Read chart of accounts"}
        </Button>
        {accountsNote && <span className="text-xs text-on-surface-variant">{accountsNote}</span>}
      </div>

      {!loaded ? null : Object.keys(grouped).length === 0 ? (
        <p className="text-sm text-on-surface-variant">No mappings configured yet.</p>
      ) : (
        Object.entries(grouped).map(([kind, rows]) => (
          <section key={kind} className="rounded-2xl border border-outline-variant overflow-hidden">
            <h2 className="px-lg py-sm bg-surface-container-low text-sm font-bold text-on-surface">{KIND_LABEL[kind] ?? kind}</h2>
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-on-surface-variant">
                <tr>
                  <th className="text-left px-lg py-sm font-semibold">Academic Nexus</th>
                  <th className="text-left px-md py-sm font-semibold">Accounting system</th>
                  <th className="text-left px-md py-sm font-semibold">External id / code</th>
                  <th className="text-right px-lg py-sm font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} className="border-t border-outline-variant/60">
                    <td className="px-lg py-sm font-medium text-on-surface">{m.local_label ?? m.local_key}</td>
                    <td className="px-md py-sm text-on-surface">{m.external_name}</td>
                    <td className="px-md py-sm font-mono text-xs text-on-surface-variant">{m.external_id ?? m.external_code ?? "—"}</td>
                    <td className="px-lg py-sm text-right">
                      <Button size="sm" variant="ghost" onClick={() => openEditor(m.kind, m.local_key, m.local_label ?? undefined)}>Edit</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Map "${editing.localKey}"` : "Map"}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={save} disabled={!form.externalName.trim() || busy === "save"} aria-busy={busy === "save" || undefined}>Save</Button>
          </>
        }
      >
        <div className="space-y-md">
          <ErrorAlert error={error} />
          <p className="text-xs text-on-surface-variant">{editing ? KIND_LABEL[editing.kind] ?? editing.kind : ""}</p>
          {accounts.length > 0 ? (
            <FormField
              label="Accounting ledger"
              id="externalName"
              type="select"
              value={form.externalName}
              onChange={(v) => {
                const hit = accounts.find((a) => a.name === v);
                setForm({ ...form, externalName: v, externalId: hit?.id ?? "", externalCode: hit?.code ?? "" });
              }}
              options={accounts.map((a) => ({ value: a.name, label: a.code ? `${a.code} — ${a.name}` : a.name }))}
              required
            />
          ) : (
            <FormField
              label="Accounting ledger name"
              id="externalName"
              value={form.externalName}
              onChange={(v) => setForm({ ...form, externalName: v })}
              placeholder="exactly as it is named in the accounting system"
              required
            />
          )}
          <FormField label="External id (optional)" id="externalId" value={form.externalId} onChange={(v) => setForm({ ...form, externalId: v })} />
          <FormField label="External code (optional)" id="externalCode" value={form.externalCode} onChange={(v) => setForm({ ...form, externalCode: v })} />
          {editing?.kind === "fee_head" && (
            <>
              <FormField
                label="Tax treatment"
                id="taxTreatment"
                type="select"
                value={form.taxTreatment}
                onChange={(v) => setForm({ ...form, taxTreatment: v })}
                options={[
                  { value: "", label: "Not declared" },
                  { value: "exempt", label: "Exempt" },
                  { value: "non_taxable", label: "Non-taxable" },
                  { value: "zero_rated", label: "Zero-rated" },
                  { value: "taxable", label: "Taxable" },
                  { value: "out_of_scope", label: "Out of scope" },
                ]}
              />
              <p className="text-xs text-on-surface-variant">
                Academic Nexus records no tax component on a fee — only the gross amount. This declares how that gross
                amount should be treated in the accounting system; it does not compute a split.
              </p>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
