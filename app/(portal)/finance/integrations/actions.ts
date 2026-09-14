"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole, type AuthorizedActor } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { assertClaimed } from "@/lib/concurrent-claim";
import { adapterFor, PROVIDERS } from "@/lib/finance/providers/registry";
import type { CapabilityMap, ProviderContext, ProviderCredential, ProviderId } from "@/lib/finance/providers/types";
import { credentialStorageConfigured, CredentialStorageUnavailableError } from "@/lib/finance/crypto";
import { deleteCredential, hasCredential, storeCredential, loadCredential } from "@/lib/finance/credentials";
import { validateMappings } from "@/lib/finance/mapping";
import { enqueue } from "@/lib/finance/pipeline";
import { reconcile } from "@/lib/finance/reconciliation";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import { dbError } from "@/lib/internal-error";

/**
 * Finance Integration Hub — the operator-facing actions.
 *
 * WHAT RUNS WHERE, AND WHY
 *
 * Anything that touches a CREDENTIAL runs on the service-role client, because
 * migration 049 gives finance_integration_credentials no RLS policy at all —
 * an admin's own session cannot read that table by design. Everything else
 * (listing connections, editing mappings, queueing work, reading the journal)
 * runs on the caller's own client so RLS remains the boundary rather than
 * this file's own care.
 *
 * A service-role call is therefore always preceded by requireRole and by an
 * explicit college check against the row it is about to touch — the two
 * things RLS would otherwise have done.
 *
 * NOTHING HERE POSTS TO A PROVIDER. Queueing is the most an operator action
 * does; the worker (app/api/cron/finance-sync) makes the call. That is what
 * keeps a posting alive across a closed browser tab (§78).
 */

type Db = SupabaseClient<Database>;
const CONNECTION_PATH = "/finance/integrations";

function revalidate() {
  revalidatePath(CONNECTION_PATH);
  revalidatePath(`${CONNECTION_PATH}/sync-operations`);
  revalidatePath(`${CONNECTION_PATH}/reconciliation`);
}

/** The connection, verified to belong to the actor's college. */
async function ownedConnection(db: Db, actor: AuthorizedActor, connectionId: string) {
  const { data } = await db
    .from("finance_integration_connections")
    .select("*")
    .eq("id", connectionId)
    .eq("college_id", actor.collegeId)
    .maybeSingle();
  if (!data) throw new Error("Integration connection not found in your college.");
  return data;
}

function contextFor(
  conn: Database["public"]["Tables"]["finance_integration_connections"]["Row"],
  credential: ProviderCredential
): ProviderContext {
  return {
    connectionId: conn.id,
    collegeId: conn.college_id,
    provider: conn.provider,
    environment: conn.environment,
    organizationId: conn.organization_id,
    externalCompanyId: conn.external_company_id,
    externalCompanyName: conn.external_company_name,
    host: conn.host,
    port: conn.port,
    baseUrl: conn.base_url,
    transport: conn.transport,
    credential,
  };
}

// ─────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────

export async function listProviders() {
  await requireRole(PERMISSIONS.finance_integration_read);
  return PROVIDERS.map((p) => ({ ...p }));
}

export async function listConnections() {
  const actor = await requireRole(PERMISSIONS.finance_integration_read);
  const supabase = await createClient();
  const { data } = await supabase
    .from("finance_integration_connections")
    .select("*")
    .eq("college_id", actor.collegeId)
    .order("created_at", { ascending: false });
  return data ?? [];
}

/**
 * The dashboard's health view (§66, §95). Deliberately computed from stored
 * state rather than by calling every provider on page load: a dashboard that
 * makes six outbound calls to render is a dashboard that times out during an
 * outage, exactly when it is being looked at.
 */
export async function integrationHealth() {
  const actor = await requireRole(PERMISSIONS.finance_integration_read);
  const supabase = await createClient();

  const [connections, pending, failed, issues] = await Promise.all([
    supabase.from("finance_integration_connections").select("*").eq("college_id", actor.collegeId),
    supabase
      .from("finance_sync_operations")
      .select("id", { count: "exact", head: true })
      .eq("college_id", actor.collegeId)
      .in("status", ["PENDING", "QUEUED", "PROCESSING", "RETRYING"]),
    supabase
      .from("finance_sync_operations")
      .select("id", { count: "exact", head: true })
      .eq("college_id", actor.collegeId)
      .in("status", ["FAILED", "BLOCKED", "RECONCILIATION_REQUIRED"]),
    supabase
      .from("finance_reconciliation_items")
      .select("id", { count: "exact", head: true })
      .eq("college_id", actor.collegeId)
      .eq("status", "open"),
  ]);

  const rows = (connections.data ?? []).map((c) => {
    const capabilities = (c.capabilities ?? {}) as CapabilityMap;
    const missing = Object.entries(capabilities)
      .filter(([, state]) => state === "REQUIRES_CONFIGURATION" || state === "BLOCKED")
      .map(([name]) => name);
    const health =
      c.status === "ACTIVE" ? (c.last_error_code ? "DEGRADED" : "HEALTHY")
      : c.status === "DISABLED" || c.status === "BLOCKED" ? "BLOCKED"
      : "ACTION_REQUIRED";
    return {
      id: c.id,
      provider: c.provider,
      displayName: c.display_name,
      status: c.status,
      company: c.external_company_name ?? c.organization_id ?? null,
      lastSuccessAt: c.last_success_at,
      lastFailureAt: c.last_failure_at,
      lastError: c.last_error_message,
      health,
      unavailableCapabilities: missing,
    };
  });

  return {
    connections: rows,
    pendingOperations: pending.count ?? 0,
    failedOperations: failed.count ?? 0,
    openReconciliationIssues: issues.count ?? 0,
    credentialStorageConfigured: credentialStorageConfigured(),
  };
}

type SyncStatus = Database["public"]["Tables"]["finance_sync_operations"]["Row"]["status"];
type SyncEntityType = Database["public"]["Tables"]["finance_sync_operations"]["Row"]["entity_type"];

export async function listSyncOperations(filters: {
  connectionId?: string;
  status?: SyncStatus;
  entityType?: SyncEntityType;
  limit?: number;
} = {}) {
  const actor = await requireRole(PERMISSIONS.finance_sync_read);
  const supabase = await createClient();
  let query = supabase
    .from("finance_sync_operations")
    .select("*")
    .eq("college_id", actor.collegeId)
    .order("created_at", { ascending: false })
    .limit(Math.min(filters.limit ?? 100, 250));
  if (filters.connectionId) query = query.eq("connection_id", filters.connectionId);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.entityType) query = query.eq("entity_type", filters.entityType);
  const { data } = await query;
  return data ?? [];
}

export async function listMappings(connectionId: string) {
  const actor = await requireRole(PERMISSIONS.finance_mapping_read);
  const supabase = await createClient();
  await ownedConnection(supabase, actor, connectionId);
  const { data } = await supabase
    .from("finance_account_mappings")
    .select("*")
    .eq("connection_id", connectionId)
    .order("kind")
    .order("local_key");
  return data ?? [];
}

export async function mappingReadiness(connectionId: string) {
  const actor = await requireRole(PERMISSIONS.finance_mapping_read);
  const supabase = await createClient();
  await ownedConnection(supabase, actor, connectionId);
  return validateMappings(supabase, actor.collegeId, connectionId);
}

export async function listReconciliation(connectionId?: string) {
  const actor = await requireRole(PERMISSIONS.finance_reconciliation_read);
  const supabase = await createClient();
  let runs = supabase
    .from("finance_reconciliation_runs")
    .select("*")
    .eq("college_id", actor.collegeId)
    .order("started_at", { ascending: false })
    .limit(25);
  if (connectionId) runs = runs.eq("connection_id", connectionId);
  const { data: runRows } = await runs;

  const { data: openItems } = await supabase
    .from("finance_reconciliation_items")
    .select("*")
    .eq("college_id", actor.collegeId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(200);

  return { runs: runRows ?? [], openItems: openItems ?? [] };
}

// ─────────────────────────────────────────────────────────────
// Connection lifecycle (§91)
// ─────────────────────────────────────────────────────────────

const CreateConnectionSchema = z.object({
  provider: z.enum(["tallyprime", "busy", "zoho_books"]),
  displayName: z.string().trim().min(1).max(120),
  environment: z.enum(["production", "sandbox"]).default("production"),
  host: z.string().trim().max(255).optional(),
  port: z.number().int().positive().max(65535).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  transport: z.enum(["xml_http", "odbc", "rest", "file"]).optional(),
  financialYearStartMonth: z.number().int().min(1).max(12).default(4),
});

export type CreateConnectionParams = z.input<typeof CreateConnectionSchema>;

export async function createConnection(params: CreateConnectionParams) {
  const actor = await requireRole(PERMISSIONS.finance_integration_connect);
  const parsed = CreateConnectionSchema.parse(params);
  await checkRateLimit(`financeConnection:${actor.userId}`, 10, 60);

  // Refuse before creating anything: a connection that cannot store its
  // credential securely is a connection that will be tempted to store it
  // some other way.
  if (!credentialStorageConfigured()) {
    throw new CredentialStorageUnavailableError();
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("finance_integration_connections")
    .insert({
      college_id: actor.collegeId,
      provider: parsed.provider,
      display_name: parsed.displayName,
      environment: parsed.environment,
      host: parsed.host || null,
      port: parsed.port ?? null,
      base_url: parsed.baseUrl || null,
      transport: parsed.transport ?? (parsed.provider === "zoho_books" ? "rest" : "xml_http"),
      financial_year_start_month: parsed.financialYearStartMonth,
      status: "DRAFT",
      created_by: actor.userId,
    })
    .select("id")
    .single();
  if (error) throw dbError(error);

  await logAudit(supabase, actor, "finance_connection_created", "finance_integration_connections", data.id, {
    newValue: { provider: parsed.provider, display_name: parsed.displayName, environment: parsed.environment },
  });
  revalidate();
  return data.id;
}

const CredentialSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("oauth2"),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1),
    refreshToken: z.string().trim().min(1),
    dataCenter: z.string().trim().max(10).optional(),
  }),
  z.object({ kind: z.literal("basic"), username: z.string().trim().min(1), password: z.string().trim().min(1) }),
  z.object({ kind: z.literal("api_key"), apiKey: z.string().trim().min(1) }),
]);

/**
 * Stores the credential and moves DRAFT -> CONFIGURING -> AUTH_REQUIRED.
 *
 * The secret never touches the caller's own Supabase client (which could not
 * write that table anyway) and is never echoed back. Only the fact that a
 * credential exists is ever reported.
 */
export async function setCredential(connectionId: string, credential: z.input<typeof CredentialSchema>) {
  const actor = await requireRole(PERMISSIONS.finance_integration_manage);
  const parsed = CredentialSchema.parse(credential);
  await checkRateLimit(`financeCredential:${actor.userId}`, 10, 60);

  const supabase = await createClient();
  const conn = await ownedConnection(supabase, actor, connectionId);

  const admin = createAdminClient();
  await storeCredential(admin, conn.id, conn.college_id, parsed as ProviderCredential);

  if (conn.status === "DRAFT") {
    await supabase.from("finance_integration_connections").update({ status: "CONFIGURING", updated_by: actor.userId }).eq("id", conn.id);
  }
  const { data: moved, error } = await supabase
    .from("finance_integration_connections")
    .update({ status: "AUTH_REQUIRED", updated_by: actor.userId })
    .eq("id", conn.id)
    .eq("college_id", actor.collegeId)
    .select("id");
  if (error) throw dbError(error);
  assertClaimed(moved, "integration connection");

  await logAudit(supabase, actor, "finance_credential_stored", "finance_integration_connections", conn.id, {
    newValue: { credential_kind: parsed.kind },
  });
  revalidate();
}

/**
 * Step 4 + 5 + 6 of the wizard: reach the provider, confirm WHICH company or
 * organisation the credential opens, and record what it can do.
 *
 * The company check is the financial-safety gate (§43). `expectedCompany`
 * is what the operator chose; if the provider reports something else the
 * connection lands in WRONG_COMPANY / WRONG_ORGANIZATION and can never be
 * activated from there without going back through configuration.
 */
export async function verifyConnection(connectionId: string, expectedCompany?: string) {
  const actor = await requireRole(PERMISSIONS.finance_integration_manage);
  await checkRateLimit(`financeVerify:${actor.userId}`, 20, 60);

  const supabase = await createClient();
  const conn = await ownedConnection(supabase, actor, connectionId);
  const admin = createAdminClient();
  const credential = await loadCredential(admin, conn.id);
  const adapter = adapterFor(conn.provider as ProviderId);
  const ctx = contextFor(conn, credential);

  const now = new Date().toISOString();
  const test = await adapter.testConnection(ctx);
  if (!test.ok) {
    const status =
      test.kind === "auth" ? "AUTH_FAILED"
      : test.kind === "capability" ? "CAPABILITY_MISSING"
      : test.kind === "wrong_company" ? "WRONG_COMPANY"
      : "CONNECTION_FAILED";
    await supabase
      .from("finance_integration_connections")
      .update({ status, last_tested_at: now, last_failure_at: now, last_error_code: test.code, last_error_message: test.message, updated_by: actor.userId })
      .eq("id", conn.id);
    await logAudit(supabase, actor, "finance_connection_test_failed", "finance_integration_connections", conn.id, {
      newValue: { status, error_code: test.code },
    });
    revalidate();
    return { ok: false as const, status, message: test.message };
  }

  // Authenticated. Now: which company?
  await supabase
    .from("finance_integration_connections")
    .update({ status: "AUTHENTICATED", last_tested_at: now, last_error_code: null, last_error_message: null, updated_by: actor.userId })
    .eq("id", conn.id);

  const orgs = await adapter.getOrganizations({ ...ctx });
  if (!orgs.ok) {
    await supabase
      .from("finance_integration_connections")
      .update({ status: orgs.kind === "wrong_company" ? "WRONG_COMPANY" : "CONNECTION_FAILED", last_failure_at: now, last_error_code: orgs.code, last_error_message: orgs.message, updated_by: actor.userId })
      .eq("id", conn.id);
    revalidate();
    return { ok: false as const, status: "WRONG_COMPANY", message: orgs.message };
  }

  const chosen = expectedCompany
    ? orgs.data.find((o) => o.id === expectedCompany || o.name === expectedCompany)
    : orgs.data.length === 1
      ? orgs.data[0]
      : undefined;

  if (!chosen) {
    const wrong = conn.provider === "zoho_books" ? "WRONG_ORGANIZATION" : "WRONG_COMPANY";
    await supabase
      .from("finance_integration_connections")
      .update({ status: wrong, last_failure_at: now, last_error_code: "COMPANY_NOT_CONFIRMED", last_error_message: `The provider offers: ${orgs.data.map((o) => o.name).join(", ") || "(none)"}. Choose the correct one.`, updated_by: actor.userId })
      .eq("id", conn.id);
    revalidate();
    return { ok: false as const, status: wrong, message: "Confirm which company this connection must post into.", options: orgs.data };
  }

  const caps = await adapter.getCapabilities({ ...ctx, organizationId: chosen.id });
  const capabilities = (caps.ok ? caps.data : {}) as CapabilityMap;

  const { data: verified, error } = await supabase
    .from("finance_integration_connections")
    .update({
      status: "VERIFIED",
      organization_id: conn.provider === "zoho_books" ? chosen.id : conn.organization_id,
      external_company_id: chosen.id,
      external_company_name: chosen.name,
      capabilities: capabilities as unknown as Json,
      last_success_at: now,
      updated_by: actor.userId,
    })
    .eq("id", conn.id)
    .eq("college_id", actor.collegeId)
    .select("id");
  if (error) throw dbError(error);
  assertClaimed(verified, "integration connection");

  await logAudit(supabase, actor, "finance_connection_verified", "finance_integration_connections", conn.id, {
    newValue: { company: chosen.name, company_id: chosen.id, capabilities: capabilities as unknown as Json },
  });
  revalidate();
  return { ok: true as const, status: "VERIFIED", company: chosen };
}

/**
 * The last gate before money can move (§92): a VERIFIED connection becomes
 * ACTIVE only when every mapping a live record needs exists.
 */
export async function activateConnection(connectionId: string) {
  const actor = await requireRole(PERMISSIONS.finance_integration_manage);
  const supabase = await createClient();
  const conn = await ownedConnection(supabase, actor, connectionId);

  if (conn.status !== "VERIFIED") {
    throw new Error(`Only a VERIFIED connection can be activated; this one is ${conn.status}.`);
  }
  const readiness = await validateMappings(supabase, actor.collegeId, conn.id);
  if (!readiness.ready) {
    throw new Error(
      `Mapping is incomplete: ${readiness.gaps
        .slice(0, 5)
        .map((g) => `${g.kind} "${g.localKey}" (${g.affectedRecords} records)`)
        .join("; ")}${readiness.gaps.length > 5 ? `, and ${readiness.gaps.length - 5} more` : ""}.`
    );
  }

  const { data: activated, error } = await supabase
    .from("finance_integration_connections")
    .update({ status: "ACTIVE", updated_by: actor.userId })
    .eq("id", conn.id)
    .eq("college_id", actor.collegeId)
    .eq("status", "VERIFIED")
    .select("id");
  if (error) throw dbError(error);
  assertClaimed(activated, "integration connection");

  await logAudit(supabase, actor, "finance_connection_activated", "finance_integration_connections", conn.id, {
    oldValue: { status: "VERIFIED" },
    newValue: { status: "ACTIVE" },
  });
  revalidate();
}

export async function disableConnection(connectionId: string, removeCredential = true) {
  const actor = await requireRole(PERMISSIONS.finance_integration_manage);
  const supabase = await createClient();
  const conn = await ownedConnection(supabase, actor, connectionId);

  const { data: disabled, error } = await supabase
    .from("finance_integration_connections")
    .update({ status: "DISABLED", updated_by: actor.userId })
    .eq("id", conn.id)
    .eq("college_id", actor.collegeId)
    .select("id");
  if (error) throw dbError(error);
  assertClaimed(disabled, "integration connection");

  if (removeCredential) await deleteCredential(createAdminClient(), conn.id);

  await logAudit(supabase, actor, "finance_connection_disabled", "finance_integration_connections", conn.id, {
    oldValue: { status: conn.status },
    newValue: { status: "DISABLED", credential_removed: removeCredential },
  });
  revalidate();
}

export async function connectionCredentialPresent(connectionId: string) {
  const actor = await requireRole(PERMISSIONS.finance_integration_read);
  const supabase = await createClient();
  await ownedConnection(supabase, actor, connectionId);
  return hasCredential(createAdminClient(), connectionId);
}

// ─────────────────────────────────────────────────────────────
// Mappings
// ─────────────────────────────────────────────────────────────

const MappingSchema = z.object({
  connectionId: z.string().guid(),
  kind: z.enum(["fee_head", "payment_method", "bank_account", "tax_code", "customer", "cost_center", "department", "branch"]),
  localKey: z.string().trim().min(1).max(200),
  localLabel: z.string().trim().max(200).optional(),
  externalId: z.string().trim().max(200).optional(),
  externalCode: z.string().trim().max(100).optional(),
  externalName: z.string().trim().min(1).max(200),
  taxRate: z.number().min(0).max(100).optional(),
  taxTreatment: z.enum(["taxable", "exempt", "zero_rated", "non_taxable", "out_of_scope"]).optional(),
});

export type UpsertMappingParams = z.input<typeof MappingSchema>;

export async function upsertMapping(params: UpsertMappingParams) {
  const actor = await requireRole(PERMISSIONS.finance_mapping_manage);
  const parsed = MappingSchema.parse(params);
  await checkRateLimit(`financeMapping:${actor.userId}`, 60, 60);

  const supabase = await createClient();
  await ownedConnection(supabase, actor, parsed.connectionId);

  const { data, error } = await supabase
    .from("finance_account_mappings")
    .upsert(
      {
        college_id: actor.collegeId,
        connection_id: parsed.connectionId,
        kind: parsed.kind,
        local_key: parsed.localKey,
        local_label: parsed.localLabel ?? null,
        external_id: parsed.externalId ?? null,
        external_code: parsed.externalCode ?? null,
        external_name: parsed.externalName,
        tax_rate: parsed.taxRate ?? null,
        tax_treatment: parsed.taxTreatment ?? null,
        status: "active",
        updated_by: actor.userId,
      },
      { onConflict: "connection_id,kind,local_key" }
    )
    .select("id")
    .single();
  if (error) throw dbError(error);

  await logAudit(supabase, actor, "finance_mapping_changed", "finance_account_mappings", data.id, {
    newValue: { kind: parsed.kind, local_key: parsed.localKey, external_name: parsed.externalName },
  });
  revalidate();
  return data.id;
}

/**
 * Pulls the provider's chart of accounts so an operator maps against real
 * ledgers rather than typing names that may not exist (§50).
 */
export async function discoverAccounts(connectionId: string) {
  const actor = await requireRole(PERMISSIONS.finance_mapping_manage);
  const supabase = await createClient();
  const conn = await ownedConnection(supabase, actor, connectionId);
  const adapter = adapterFor(conn.provider as ProviderId);
  if (!adapter.getAccounts) {
    return { ok: false as const, message: `${conn.provider} cannot list accounts through this adapter.`, accounts: [] };
  }
  const credential = await loadCredential(createAdminClient(), conn.id);
  const res = await adapter.getAccounts(contextFor(conn, credential));
  if (!res.ok) return { ok: false as const, message: res.message, accounts: [] };
  return { ok: true as const, accounts: res.data };
}

// ─────────────────────────────────────────────────────────────
// Queueing work (§93)
// ─────────────────────────────────────────────────────────────

const SyncNowSchema = z.object({
  connectionId: z.string().guid(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type SyncNowParams = z.infer<typeof SyncNowSchema>;

/**
 * Queues every postable payment in a window. Queues only — the worker posts.
 *
 * "Postable" is narrow on purpose: cleared payments, in this college, in the
 * window, that do not already carry an external link. A payment that is
 * already linked is skipped rather than re-queued, so pressing Sync Now
 * twice cannot produce two receipts even before the pipeline's own guards.
 */
export async function syncNow(params: SyncNowParams) {
  const actor = await requireRole(PERMISSIONS.finance_sync_execute);
  const { connectionId, from, to } = SyncNowSchema.parse(params);
  await checkRateLimit(`financeSyncNow:${actor.userId}`, 10, 60);

  const supabase = await createClient();
  const conn = await ownedConnection(supabase, actor, connectionId);
  if (conn.status !== "ACTIVE") {
    throw new Error(`This connection is ${conn.status}. Only an ACTIVE connection can synchronise.`);
  }

  const { data: payments } = await supabase
    .from("payments")
    .select("id")
    .eq("college_id", actor.collegeId)
    .eq("status", "cleared")
    .gte("created_at", `${from}T00:00:00Z`)
    .lte("created_at", `${to}T23:59:59Z`);

  const ids = (payments ?? []).map((p) => p.id);
  if (ids.length === 0) return { queued: 0, skipped: 0 };

  const { data: linked } = await supabase
    .from("finance_external_links")
    .select("entity_id")
    .eq("connection_id", connectionId)
    .eq("entity_type", "payment")
    .in("entity_id", ids);
  const already = new Set((linked ?? []).map((l) => l.entity_id));

  let queued = 0;
  for (const id of ids) {
    if (already.has(id)) continue;
    const op = await enqueue(supabase, {
      collegeId: actor.collegeId,
      connectionId,
      provider: conn.provider,
      entityType: "payment",
      entityId: id,
      operation: "create_payment",
      createdBy: actor.userId,
    });
    if (op.status === "PENDING") {
      await supabase.from("finance_sync_operations").update({ status: "QUEUED" }).eq("id", op.id).eq("status", "PENDING");
      queued++;
    }
  }

  await logAudit(supabase, actor, "finance_sync_started", "finance_integration_connections", connectionId, {
    newValue: { from, to, queued, candidates: ids.length },
  });
  revalidate();
  return { queued, skipped: already.size };
}

/**
 * Operator retry (§68). Only a failure the pipeline classified `safe` can be
 * retried here; anything else needs reconciliation first, and the database
 * trigger refuses the transition regardless of what this function tries.
 */
export async function retryOperation(operationId: string) {
  const actor = await requireRole(PERMISSIONS.finance_sync_retry);
  z.string().guid().parse(operationId);
  const supabase = await createClient();

  const { data: op } = await supabase
    .from("finance_sync_operations")
    .select("id, status, retry_safety, college_id, attempt_number, max_attempts, error_code")
    .eq("id", operationId)
    .eq("college_id", actor.collegeId)
    .maybeSingle();
  if (!op) throw new Error("Sync operation not found in your college.");
  if (op.status !== "FAILED") throw new Error(`Only a FAILED operation can be retried; this one is ${op.status}.`);
  if (op.retry_safety !== "safe") {
    throw new Error(
      `This failure (${op.error_code ?? "unknown"}) is not safe to retry — the accounting system may already hold the ` +
        `document. Run reconciliation for this period first.`
    );
  }
  if (op.attempt_number >= op.max_attempts) {
    throw new Error(`This operation has used all ${op.max_attempts} attempts. Reconcile and resolve it manually.`);
  }

  const { data: claimed, error } = await supabase
    .from("finance_sync_operations")
    .update({ status: "RETRYING", next_attempt_at: new Date().toISOString() })
    .eq("id", operationId)
    .eq("status", "FAILED")
    .select("id");
  if (error) throw dbError(error);
  assertClaimed(claimed, "sync operation");

  await logAudit(supabase, actor, "finance_sync_retried", "finance_sync_operations", operationId, {
    oldValue: { status: "FAILED" },
    newValue: { status: "RETRYING", attempt: op.attempt_number + 1 },
  });
  revalidate();
}

export async function cancelOperation(operationId: string) {
  const actor = await requireRole(PERMISSIONS.finance_sync_retry);
  z.string().guid().parse(operationId);
  const supabase = await createClient();
  const { data: cancelled, error } = await supabase
    .from("finance_sync_operations")
    .update({ status: "CANCELLED" })
    .eq("id", operationId)
    .eq("college_id", actor.collegeId)
    .in("status", ["PENDING", "BLOCKED", "FAILED"])
    .select("id");
  if (error) throw dbError(error);
  assertClaimed(cancelled, "sync operation");
  await logAudit(supabase, actor, "finance_sync_cancelled", "finance_sync_operations", operationId, {
    newValue: { status: "CANCELLED" },
  });
  revalidate();
}

// ─────────────────────────────────────────────────────────────
// Reconciliation
// ─────────────────────────────────────────────────────────────

export async function runReconciliation(params: { connectionId: string; from: string; to: string }) {
  const actor = await requireRole(PERMISSIONS.finance_reconciliation_execute);
  const parsed = SyncNowSchema.parse({ connectionId: params.connectionId, from: params.from, to: params.to });
  await checkRateLimit(`financeReconcile:${actor.userId}`, 10, 60);

  const supabase = await createClient();
  const conn = await ownedConnection(supabase, actor, parsed.connectionId);

  // Runs on the caller's client: reconciliation reads payments and writes
  // findings, both of which its RLS already permits. The credential read
  // inside uses the service-role client, and only there.
  const outcome = await reconcile(supabase, {
    collegeId: actor.collegeId,
    connectionId: conn.id,
    periodStart: parsed.from,
    periodEnd: parsed.to,
    createdBy: actor.userId,
  });

  await logAudit(supabase, actor, `finance_reconciliation_${outcome.status.toLowerCase()}`, "finance_reconciliation_runs", outcome.runId, {
    newValue: {
      period: `${parsed.from}..${parsed.to}`,
      local: outcome.localAmount,
      external: outcome.externalAmount,
      difference: outcome.differenceAmount,
      issues: outcome.issues,
    },
  });
  revalidate();
  return outcome;
}

export async function resolveReconciliationItem(itemId: string, resolution: string, accept = false) {
  const actor = await requireRole(PERMISSIONS.finance_reconciliation_resolve);
  z.string().guid().parse(itemId);
  const text = z.string().trim().min(1).max(2000).parse(resolution);

  const supabase = await createClient();
  const { data: resolved, error } = await supabase
    .from("finance_reconciliation_items")
    .update({
      status: accept ? "accepted" : "resolved",
      resolution: text,
      resolved_by: actor.userId,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", itemId)
    .eq("college_id", actor.collegeId)
    .eq("status", "open")
    .select("id");
  if (error) throw dbError(error);
  assertClaimed(resolved, "reconciliation finding");

  await logAudit(supabase, actor, "finance_reconciliation_resolved", "finance_reconciliation_items", itemId, {
    newValue: { status: accept ? "accepted" : "resolved", resolution: text },
  });
  revalidate();
}

/**
 * The audit view (§88). Reads the existing audit_logs table rather than a
 * second trail — every action above writes there through logAudit, so this
 * is a filter, not a new store.
 */
export async function integrationAuditTrail(limit = 100) {
  const actor = await requireRole(PERMISSIONS.finance_integration_audit_read);
  const supabase = await createClient();
  const { data } = await supabase
    .from("audit_logs")
    .select("*, actor:user_id(full_name, role)")
    .eq("college_id", actor.collegeId)
    .in("table_name", [
      "finance_integration_connections",
      "finance_account_mappings",
      "finance_sync_operations",
      "finance_reconciliation_runs",
      "finance_reconciliation_items",
    ])
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, 250));
  return data ?? [];
}
