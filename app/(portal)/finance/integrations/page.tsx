"use client";

import { useCallback, useEffect, useState } from "react";
import { todayInTimeZone } from "@/lib/format";
import Link from "next/link";
import { Modal, Button, FormField, StatusBadge } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { ErrorAlert } from "@/components/ui/error-alert";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { classifyError } from "@/lib/feedback-error";
import {
  activateConnection,
  createConnection,
  disableConnection,
  integrationHealth,
  listProviders,
  mappingReadiness,
  setCredential,
  syncNow,
  verifyConnection,
} from "./actions";

/**
 * The Finance Integration dashboard (§66) and the connection wizard (§91).
 *
 * The wizard's steps are the connection's own status values, so the screen
 * cannot offer an action the database would refuse: a DRAFT connection shows
 * "Add credential", an AUTH_REQUIRED one shows "Test & verify", a VERIFIED
 * one shows "Activate" — and Activate is disabled until mapping readiness
 * comes back clean, because 049 and the server both refuse it anyway and a
 * button that fails is worse than a button that explains.
 */

type Health = Awaited<ReturnType<typeof integrationHealth>>;
type ConnectionRow = Health["connections"][number];

const PROVIDER_HINT: Record<string, string> = {
  zoho_books: "REST API with OAuth 2.0. You will need a client id, client secret and refresh token from the Zoho API console, plus the data centre your organisation lives in.",
  tallyprime: "XML over HTTP. TallyPrime must be running on a reachable machine with its HTTP server enabled and the correct company open.",
  busy: "BUSY has no general public accounting API. A connection can be recorded and mapped, but it cannot be activated until your BUSY partner supplies an integration contract.",
};

const HEALTH_TONE: Record<string, string> = {
  HEALTHY: "bg-success-container text-on-success-container border-success/30",
  DEGRADED: "bg-warning-container text-on-warning-container border-warning/30",
  ACTION_REQUIRED: "bg-error-container text-on-error-container border-error/30",
  BLOCKED: "bg-surface-container-high text-on-surface-variant border-outline-variant",
};

export default function FinanceIntegrationsPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [providers, setProviders] = useState<{ id: string; displayName: string }[]>([]);
  // Loading the dashboard and running an action fail separately: a failed
  // load is never "No accounting integration yet" (owner decision D5).
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [disableFor, setDisableFor] = useState<ConnectionRow | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ provider: "zoho_books", displayName: "", host: "", port: "9000", dataCenter: "in", financialYearStartMonth: "4" });

  const [credentialFor, setCredentialFor] = useState<ConnectionRow | null>(null);
  const [cred, setCred] = useState({ clientId: "", clientSecret: "", refreshToken: "", dataCenter: "in", username: "", password: "", apiKey: "" });

  const [syncFor, setSyncFor] = useState<ConnectionRow | null>(null);
  const today = todayInTimeZone();
  const [syncRange, setSyncRange] = useState({ from: today.slice(0, 8) + "01", to: today });

  const [readiness, setReadiness] = useState<Record<string, { ready: boolean; gaps: number }>>({});

  const load = useCallback(async () => {
    try {
      const [h, p] = await Promise.all([integrationHealth(), listProviders()]);
      setHealth(h);
      setProviders(p);
      const checks: Record<string, { ready: boolean; gaps: number }> = {};
      for (const c of h.connections) {
        if (c.status === "VERIFIED" || c.status === "ACTIVE") {
          try {
            const r = await mappingReadiness(c.id);
            checks[c.id] = { ready: r.ready, gaps: r.gaps.length };
          } catch {
            /* readiness is advisory on this screen */
          }
        }
      }
      setReadiness(checks);
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, successMessage?: string) => {
    if (busy) return null;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const result = await fn();
      if (successMessage) setNotice(successMessage);
      // Reloading reports its own failure (loadError), never as a failed action.
      void load();
      return result ?? true;
    } catch (e) {
      setError(await toFeedbackError(e, "The action did not complete."));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const dialogOpen = showCreate || credentialFor !== null || syncFor !== null || disableFor !== null;

  const handleCreate = () =>
    run(
      "create",
      async () => {
        await createConnection({
          provider: form.provider as "zoho_books" | "tallyprime" | "busy",
          displayName: form.displayName,
          host: form.provider === "tallyprime" ? form.host : undefined,
          port: form.provider === "tallyprime" ? Number(form.port) : undefined,
          financialYearStartMonth: Number(form.financialYearStartMonth),
        });
        setShowCreate(false);
        setForm({ ...form, displayName: "", host: "" });
      },
      "Connection created. Add its credential next."
    );

  const handleCredential = () => {
    if (!credentialFor) return;
    const provider = credentialFor.provider;
    const payload =
      provider === "zoho_books"
        ? { kind: "oauth2" as const, clientId: cred.clientId, clientSecret: cred.clientSecret, refreshToken: cred.refreshToken, dataCenter: cred.dataCenter }
        : provider === "tallyprime"
          ? { kind: "none" as const }
          : { kind: "api_key" as const, apiKey: cred.apiKey };
    return run(
      credentialFor.id,
      async () => {
        await setCredential(credentialFor.id, payload);
        setCredentialFor(null);
        setCred({ clientId: "", clientSecret: "", refreshToken: "", dataCenter: "in", username: "", password: "", apiKey: "" });
      },
      "Credential stored. Test and verify the connection next."
    );
  };

  const handleSync = () => {
    if (!syncFor) return;
    return run(
      syncFor.id,
      async () => {
        const result = (await syncNow({ connectionId: syncFor.id, from: syncRange.from, to: syncRange.to })) as { queued: number; skipped: number };
        setSyncFor(null);
        setNotice(`Queued ${result.queued} payment(s); ${result.skipped} already posted.`);
      }
    );
  };

  const connections = health?.connections ?? [];

  return (
    <div className="space-y-lg">
      <div className="flex items-start justify-between gap-md">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Accounting Integrations</h1>
          <p className="text-sm text-on-surface-variant mt-xs max-w-3xl">
            Academic Nexus stays the record of what was collected. These connections mirror those collections into your
            accounting system and then check that the two still agree.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Add Integration</Button>
      </div>

      {/* An open dialog shows its own failure. */}
      <ErrorAlert error={!dialogOpen ? error : null} />
      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>

      {!health && !loadError && <LoadingState label="Loading integrations…" />}
      {loadError !== null && !health && (
        <ErrorState
          {...classifyError(loadError)}
          title="Integrations couldn't be loaded"
          onRetry={() => void load()}
          className="rounded-2xl border border-outline-variant bg-surface-container-lowest"
        />
      )}
      <Alert tone="error" action={<Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>}>
        {loadError !== null && health ? (
          <>
            This couldn&apos;t be refreshed. Showing what was loaded earlier.
          </>
        ) : null}
      </Alert>

      <Alert tone="error" title={health && !health.credentialStorageConfigured ? "Credential storage is not configured." : undefined}>
        {health && !health.credentialStorageConfigured ? (
          <>
            FINANCE_CREDENTIAL_KEY is not set, so accounting credentials cannot be encrypted. New connections are
            refused rather than stored in a weaker form. Set a 32-byte key in the server environment.
          </>
        ) : null}
      </Alert>

      {health && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-md">
          {[
            { label: "Connections", value: connections.length },
            { label: "Pending operations", value: health.pendingOperations },
            { label: "Failed / blocked", value: health.failedOperations, tone: health.failedOperations > 0 ? "text-error" : undefined },
            { label: "Open reconciliation issues", value: health.openReconciliationIssues, tone: health.openReconciliationIssues > 0 ? "text-warning" : undefined },
          ].map((card) => (
            <div key={card.label} className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-md">
              <p className="text-xs uppercase tracking-wide text-on-surface-variant">{card.label}</p>
              <p className={`text-2xl font-extrabold mt-xs tabular-nums ${card.tone ?? "text-on-surface"}`}>{card.value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-md text-sm">
        <Link href="/finance/integrations/sync-operations" className="text-secondary font-semibold hover:underline">Sync operations →</Link>
        <Link href="/finance/integrations/reconciliation" className="text-secondary font-semibold hover:underline">Reconciliation →</Link>
        <Link href="/finance/integrations/audit" className="text-secondary font-semibold hover:underline">Audit →</Link>
      </div>

      {health && connections.length === 0 && (
        <div className="rounded-2xl border border-dashed border-outline-variant p-lg text-sm text-on-surface-variant">
          No accounting integration yet. Adding one does not change how fees or payments are recorded — it only mirrors
          them outward.
        </div>
      )}

      <div className="space-y-md">
        {connections.map((c) => {
          const ready = readiness[c.id];
          return (
            <section key={c.id} className="rounded-2xl border border-outline-variant bg-surface-container-lowest overflow-hidden">
              <header className="flex flex-wrap items-center justify-between gap-md px-lg py-md bg-surface-container-low">
                <div className="flex items-center gap-md flex-wrap">
                  <h2 className="text-lg font-bold text-on-surface">{c.displayName}</h2>
                  <span className="text-xs font-mono uppercase tracking-wide text-on-surface-variant">{c.provider}</span>
                  <StatusBadge status={c.status} />
                  <span className={`text-xs font-semibold px-sm py-xs rounded-lg border ${HEALTH_TONE[c.health] ?? ""}`}>{c.health}</span>
                </div>
                <div className="flex items-center gap-xs flex-wrap">
                  {(c.status === "DRAFT" || c.status === "CONFIGURING" || c.status === "AUTH_FAILED" || c.status === "REVOKED") && (
                    <Button size="sm" onClick={() => setCredentialFor(c)}>Add credential</Button>
                  )}
                  {(c.status === "AUTH_REQUIRED" || c.status === "AUTHENTICATED" || c.status === "CONNECTION_FAILED" || c.status === "WRONG_COMPANY" || c.status === "WRONG_ORGANIZATION") && (
                    <Button size="sm" disabled={busy === c.id} aria-busy={busy === c.id || undefined} onClick={() => run(c.id, () => verifyConnection(c.id), "Verification finished.")}>
                      Test &amp; verify
                    </Button>
                  )}
                  <Link href={`/finance/integrations/${c.id}/mappings`}>
                    <Button size="sm" variant="outline">Mappings{ready && !ready.ready ? ` (${ready.gaps} missing)` : ""}</Button>
                  </Link>
                  {c.status === "VERIFIED" && (
                    <Button size="sm" disabled={busy === c.id || (ready ? !ready.ready : false)} aria-busy={busy === c.id || undefined} onClick={() => run(c.id, () => activateConnection(c.id), "Connection activated.")}>
                      Activate
                    </Button>
                  )}
                  {c.status === "ACTIVE" && (
                    <Button size="sm" onClick={() => setSyncFor(c)}>Sync now</Button>
                  )}
                  {c.status !== "DISABLED" && (
                    <Button size="sm" variant="destructive" disabled={busy === c.id} onClick={() => { setError(null); setDisableFor(c); }}>
                      Disable
                    </Button>
                  )}
                </div>
              </header>

              <dl className="grid grid-cols-2 md:grid-cols-4 gap-md px-lg py-md text-sm">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-on-surface-variant">Company / organisation</dt>
                  <dd className="text-on-surface font-medium mt-xs">{c.company ?? "— not confirmed —"}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-on-surface-variant">Last success</dt>
                  <dd className="text-on-surface-variant mt-xs">{c.lastSuccessAt ? new Date(c.lastSuccessAt).toLocaleString() : "never"}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-on-surface-variant">Last failure</dt>
                  <dd className="text-on-surface-variant mt-xs">{c.lastFailureAt ? new Date(c.lastFailureAt).toLocaleString() : "never"}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-on-surface-variant">Mapping</dt>
                  <dd className="mt-xs">
                    {ready ? (
                      ready.ready ? <span className="text-success font-medium">complete</span> : <span className="text-error font-medium">{ready.gaps} gap(s)</span>
                    ) : (
                      <span className="text-on-surface-variant">—</span>
                    )}
                  </dd>
                </div>
              </dl>

              {c.lastError && (
                <p className="px-lg pb-md text-sm text-error">{c.lastError}</p>
              )}
              {c.unavailableCapabilities.length > 0 && (
                <p className="px-lg pb-md text-xs text-on-surface-variant">
                  Not available on this connection: {c.unavailableCapabilities.join(", ")}.
                </p>
              )}
            </section>
          );
        })}
      </div>

      {/* ── Wizard step 1–3 ─────────────────────────────────── */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Add Accounting Integration"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={busy === "create"} aria-busy={busy === "create" || undefined}>{busy === "create" ? "Creating..." : "Create"}</Button>
          </>
        }
      >
        <div className="space-y-md">
          <ErrorAlert error={error} />
          <FormField
            label="Provider"
            id="provider"
            type="select"
            value={form.provider}
            onChange={(v) => setForm({ ...form, provider: v })}
            options={providers.map((p) => ({ value: p.id, label: p.displayName }))}
            required
          />
          <p className="text-xs text-on-surface-variant">{PROVIDER_HINT[form.provider]}</p>
          <FormField label="Name" id="displayName" value={form.displayName} onChange={(v) => setForm({ ...form, displayName: v })} placeholder="e.g. Main books 2026-27" required />
          {form.provider === "tallyprime" && (
            <>
              <FormField label="Tally host" id="host" value={form.host} onChange={(v) => setForm({ ...form, host: v })} placeholder="e.g. 192.168.1.20" required />
              <FormField label="Port" id="port" type="number" value={form.port} onChange={(v) => setForm({ ...form, port: v })} required />
            </>
          )}
          <FormField
            label="Financial year starts in month"
            id="fyStart"
            type="number"
            value={form.financialYearStartMonth}
            onChange={(v) => setForm({ ...form, financialYearStartMonth: v })}
            required
          />
          <p className="text-xs text-on-surface-variant">
            The financial year is separate from the academic year. April (4) is the common default in India.
          </p>
        </div>
      </Modal>

      {/* ── Wizard step 3: credentials ──────────────────────── */}
      <Modal
        open={credentialFor !== null}
        onClose={() => setCredentialFor(null)}
        title={credentialFor ? `Credential for ${credentialFor.displayName}` : "Credential"}
        footer={
          <>
            <Button variant="outline" onClick={() => setCredentialFor(null)}>Cancel</Button>
            <Button onClick={handleCredential} disabled={busy === credentialFor?.id} aria-busy={busy === credentialFor?.id || undefined}>Store securely</Button>
          </>
        }
      >
        <div className="space-y-md">
          <ErrorAlert error={error} />
          <p className="text-xs text-on-surface-variant">
            Stored encrypted. It is never shown again, never sent to the browser, and no role in the application can
            read it back — only the synchronisation worker can.
          </p>
          {credentialFor?.provider === "zoho_books" && (
            <>
              <FormField label="Client ID" id="clientId" value={cred.clientId} onChange={(v) => setCred({ ...cred, clientId: v })} required />
              <FormField label="Client secret" id="clientSecret" type="password" value={cred.clientSecret} onChange={(v) => setCred({ ...cred, clientSecret: v })} required />
              <FormField label="Refresh token" id="refreshToken" type="password" value={cred.refreshToken} onChange={(v) => setCred({ ...cred, refreshToken: v })} required />
              <FormField
                label="Data centre"
                id="dataCenter"
                type="select"
                value={cred.dataCenter}
                onChange={(v) => setCred({ ...cred, dataCenter: v })}
                options={[
                  { value: "in", label: "India (.in)" },
                  { value: "com", label: "United States (.com)" },
                  { value: "eu", label: "Europe (.eu)" },
                  { value: "com.au", label: "Australia (.com.au)" },
                ]}
                required
              />
            </>
          )}
          {credentialFor?.provider === "tallyprime" && (
            <p className="text-sm text-on-surface-variant">
              TallyPrime on a local network uses no credential — reachability and the loaded company are what authorise
              the connection. Continue to store an empty credential and then verify the company.
            </p>
          )}
          {credentialFor?.provider === "busy" && (
            <>
              <p className="text-sm text-on-surface-variant">{PROVIDER_HINT.busy}</p>
              <FormField label="API key (if your partner supplied one)" id="apiKey" type="password" value={cred.apiKey} onChange={(v) => setCred({ ...cred, apiKey: v })} />
            </>
          )}
        </div>
      </Modal>

      {/* ── Sync now (§93) ──────────────────────────────────── */}
      <Modal
        open={syncFor !== null}
        onClose={() => setSyncFor(null)}
        title={syncFor ? `Sync ${syncFor.displayName}` : "Sync"}
        footer={
          <>
            <Button variant="outline" onClick={() => setSyncFor(null)}>Cancel</Button>
            <Button onClick={handleSync} disabled={busy === syncFor?.id} aria-busy={busy === syncFor?.id || undefined}>Queue</Button>
          </>
        }
      >
        <div className="space-y-md text-sm">
          <ErrorAlert error={error} />
          <dl className="grid grid-cols-2 gap-sm">
            <dt className="text-on-surface-variant">Provider</dt><dd className="text-on-surface font-medium">{syncFor?.provider}</dd>
            <dt className="text-on-surface-variant">Company</dt><dd className="text-on-surface font-medium">{syncFor?.company ?? "—"}</dd>
            <dt className="text-on-surface-variant">Direction</dt><dd className="text-on-surface font-medium">Academic Nexus → accounting</dd>
            <dt className="text-on-surface-variant">Objects</dt><dd className="text-on-surface font-medium">Cleared payments</dd>
          </dl>
          <FormField label="From" id="from" type="date" value={syncRange.from} onChange={(v) => setSyncRange({ ...syncRange, from: v })} required />
          <FormField label="To" id="to" type="date" value={syncRange.to} onChange={(v) => setSyncRange({ ...syncRange, to: v })} required />
          <p className="text-xs text-on-surface-variant">
            Payments already posted to this connection are skipped. Queued work is carried out by the background worker,
            so you can leave this page.
          </p>
        </div>
      </Modal>

      <ConfirmationDialog
        open={disableFor !== null}
        title="Disable this integration?"
        description={
          disableFor
            ? `${disableFor.displayName} stops syncing and its stored credential is removed. Payments already recorded in Academic Nexus are not affected.`
            : undefined
        }
        confirmLabel="Disable integration"
        pendingLabel="Disabling…"
        pending={disableFor !== null && busy === disableFor.id}
        error={disableFor !== null ? error : null}
        onConfirm={async () => {
          if (!disableFor) return;
          const target = disableFor;
          const done = await run(target.id, () => disableConnection(target.id), "Connection disabled and its credential removed.");
          if (done !== null) setDisableFor(null);
        }}
        onCancel={() => setDisableFor(null)}
      />
    </div>
  );
}
