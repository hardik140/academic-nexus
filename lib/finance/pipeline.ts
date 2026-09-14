import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import { adapterFor, implementsCapability } from "./providers/registry";
import {
  type CapabilityMap,
  type CapabilityName,
  type ProviderContext,
  type ProviderResult,
  type ExternalTransaction,
  isUsable,
} from "./providers/types";
import { bodyHash, redact } from "./crypto";
import { indexMappings, loadMappings, requireMapping, MappingMissingError, taxFor } from "./mapping";
import { financialYearFor, idempotencyKey, nextAttemptAt, periodKeyFor, retrySafetyFor } from "./idempotency";
import { dbError } from "@/lib/internal-error";

/**
 * The outbound financial transaction pipeline (§51).
 *
 * Runs in the service-role worker, never in a request handler: a browser
 * that navigates away must not be able to abandon a half-posted receipt
 * (§78). The queue is the `finance_sync_operations` table itself — rows in
 * QUEUED/RETRYING with next_attempt_at in the past — so there is no second
 * job store to keep consistent with the journal.
 *
 * Every gate below can only ever REFUSE. None of them can turn a refusal
 * into a posting, and the last one cannot turn a posting into a success
 * without an external identifier. In order:
 *
 *   connection ACTIVE?            -> BLOCKED
 *   already linked externally?    -> SYNCED, with no call at all
 *   capability usable?            -> BLOCKED
 *   mappings complete?            -> BLOCKED (never a default ledger)
 *   accounting period open?       -> BLOCKED, error POSTING_BLOCKED
 *   ---- the provider is called here, exactly once ----
 *   acknowledged with an id?      -> SYNCED + immutable external link
 *   acknowledged without an id?   -> RECONCILIATION_REQUIRED
 *   refused, safe to retry?       -> FAILED, scheduled
 *   refused, unsafe?              -> RECONCILIATION_REQUIRED
 */

type Db = SupabaseClient<Database>;
type SyncOperation = Database["public"]["Tables"]["finance_sync_operations"]["Row"];
type Connection = Database["public"]["Tables"]["finance_integration_connections"]["Row"];

export interface PipelineOutcome {
  operationId: string;
  status: SyncOperation["status"];
  externalId?: string;
  errorCode?: string;
  message?: string;
}

const CAPABILITY_FOR_OPERATION: Record<string, CapabilityName> = {
  create_customer: "createCustomer",
  update_customer: "updateCustomer",
  create_invoice: "createInvoice",
  update_invoice: "updateInvoice",
  create_payment: "createPayment",
  create_refund: "createRefund",
  create_journal_entry: "createJournalEntry",
};

// ─────────────────────────────────────────────────────────────
// Enqueue
// ─────────────────────────────────────────────────────────────

export interface EnqueueInput {
  collegeId: string;
  connectionId: string;
  provider: Connection["provider"];
  entityType: SyncOperation["entity_type"];
  entityId: string;
  operation: keyof typeof CAPABILITY_FOR_OPERATION;
  createdBy?: string;
  systemActor?: string;
  version?: number;
}

/**
 * Creates (or finds) the operation row for a transaction.
 *
 * Idempotent by construction: the key is deterministic, and the unique index
 * on (connection_id, idempotency_key) means a double-click, a re-queue and a
 * retry all resolve to the same row rather than three postings. A caller
 * that races itself gets the existing row back, not an error.
 */
export async function enqueue(db: Db, input: EnqueueInput): Promise<SyncOperation> {
  const key = idempotencyKey({
    collegeId: input.collegeId,
    connectionId: input.connectionId,
    entityType: input.entityType,
    entityId: input.entityId,
    operation: input.operation,
    version: input.version,
  });

  const { data: existing } = await db
    .from("finance_sync_operations")
    .select("*")
    .eq("connection_id", input.connectionId)
    .eq("idempotency_key", key)
    .maybeSingle();
  if (existing) return existing as SyncOperation;

  const { data, error } = await db
    .from("finance_sync_operations")
    .insert({
      college_id: input.collegeId,
      connection_id: input.connectionId,
      provider: input.provider,
      entity_type: input.entityType,
      entity_id: input.entityId,
      operation: input.operation,
      idempotency_key: key,
      status: "PENDING",
      created_by: input.createdBy ?? null,
      system_actor: input.createdBy ? null : (input.systemActor ?? "scheduler"),
    })
    .select("*")
    .single();

  if (error) {
    // Lost the race against a concurrent enqueue: the unique index did its
    // job, so return the row the winner created rather than failing.
    if (error.code === "23505") {
      const { data: winner } = await db
        .from("finance_sync_operations")
        .select("*")
        .eq("connection_id", input.connectionId)
        .eq("idempotency_key", key)
        .single();
      if (winner) return winner as SyncOperation;
    }
    throw dbError(error);
  }
  return data as SyncOperation;
}

// ─────────────────────────────────────────────────────────────
// Execute
// ─────────────────────────────────────────────────────────────

async function transition(
  db: Db,
  op: SyncOperation,
  patch: Database["public"]["Tables"]["finance_sync_operations"]["Update"]
): Promise<void> {
  const { error } = await db.from("finance_sync_operations").update(patch).eq("id", op.id);
  if (error) throw new Error(`finance sync operation ${op.id}: ${error.message}`);
}

async function block(db: Db, op: SyncOperation, code: string, message: string): Promise<PipelineOutcome> {
  await transition(db, op, {
    status: "BLOCKED",
    error_code: code,
    error_message: message,
    retry_safety: "exhausted",
    completed_at: new Date().toISOString(),
  });
  return { operationId: op.id, status: "BLOCKED", errorCode: code, message };
}

/**
 * Runs one queued operation to a terminal state.
 *
 * `fetchImpl` is threaded through to the adapter so tests can drive the whole
 * pipeline — gates, journal, links, state machine — against a scripted
 * provider without a network, while the production path uses global fetch.
 */
export async function runOperation(
  db: Db,
  operationId: string,
  deps: { fetchImpl?: typeof fetch; now?: () => Date } = {}
): Promise<PipelineOutcome> {
  const now = deps.now ?? (() => new Date());

  const { data: opRow, error: opError } = await db
    .from("finance_sync_operations")
    .select("*")
    .eq("id", operationId)
    .single();
  if (opError || !opRow) throw new Error(opError?.message ?? "Sync operation not found.");
  const op = opRow as SyncOperation;

  if (!["QUEUED", "RETRYING"].includes(op.status)) {
    return { operationId: op.id, status: op.status, message: `Not runnable from ${op.status}.` };
  }

  const { data: connRow } = await db
    .from("finance_integration_connections")
    .select("*")
    .eq("id", op.connection_id)
    .single();
  const conn = connRow as Connection | null;
  if (!conn) return block(db, op, "CONNECTION_MISSING", "The integration connection no longer exists.");

  // Tenancy, again, in the worker. RLS is bypassed here by construction
  // (service role), so the check that the operation and the connection
  // belong to the same college is made explicitly rather than inherited.
  if (conn.college_id !== op.college_id) {
    return block(db, op, "TENANT_MISMATCH", "Operation and connection belong to different colleges.");
  }
  if (conn.status !== "ACTIVE") {
    return block(db, op, "CONNECTION_NOT_ACTIVE", `The connection is ${conn.status}; only an ACTIVE connection may post.`);
  }

  await transition(db, op, { status: "PROCESSING", started_at: now().toISOString(), attempt_number: op.attempt_number + 1 });
  const attempt = op.attempt_number + 1;

  // ── Already posted? ────────────────────────────────────────
  // The link is the authority, not the journal: if this entity already has
  // an external document on this connection, the work is done and no call
  // is made. This is what makes a retry after an unknown result safe once
  // reconciliation has recorded the id it found.
  // `master_data` is the one entity_type with no link (it names no row), so
  // it is excluded here rather than cast away — a sweep has nothing to be
  // already-linked to.
  const linkableType =
    op.entity_type === "master_data"
      ? null
      : (op.entity_type as Database["public"]["Tables"]["finance_external_links"]["Row"]["entity_type"]);

  const { data: link } = linkableType && op.entity_id
    ? await db
        .from("finance_external_links")
        .select("external_id, external_number")
        .eq("connection_id", op.connection_id)
        .eq("entity_type", linkableType)
        .eq("entity_id", op.entity_id)
        .maybeSingle()
    : { data: null };
  if (link) {
    await transition(db, { ...op, status: "PROCESSING" }, {
      status: "SYNCED",
      external_id: link.external_id,
      external_number: link.external_number,
      error_code: null,
      error_message: null,
      completed_at: now().toISOString(),
    });
    return { operationId: op.id, status: "SYNCED", externalId: link.external_id, message: "Already linked; no call made." };
  }

  const processing: SyncOperation = { ...op, status: "PROCESSING", attempt_number: attempt };

  // ── Capability ─────────────────────────────────────────────
  const capability = CAPABILITY_FOR_OPERATION[op.operation];
  if (!capability) return block(db, processing, "UNKNOWN_OPERATION", `No capability is mapped to "${op.operation}".`);
  if (!implementsCapability(conn.provider, capability)) {
    return block(db, processing, "CAPABILITY_UNSUPPORTED",
      `${conn.provider} has no implementation for ${capability}.`);
  }
  const declared = (conn.capabilities ?? {}) as CapabilityMap;
  if (!isUsable(declared[capability])) {
    return block(db, processing, "CAPABILITY_NOT_AVAILABLE",
      `${capability} is ${declared[capability] ?? "NOT_TESTED"} on this connection. Re-run capability discovery or complete its configuration.`);
  }

  // ── Build the request from mapped values ───────────────────
  let built: BuiltRequest;
  try {
    built = await buildRequest(db, conn, processing);
  } catch (err) {
    if (err instanceof MappingMissingError) {
      return block(db, processing, err.code, err.message);
    }
    return block(db, processing, "REQUEST_BUILD_FAILED", (err as Error).message);
  }

  const financialYear = financialYearFor(built.date, conn.financial_year_start_month);
  const periodKey = periodKeyFor(built.date);
  const adapter = adapterFor(conn.provider);

  const ctx: ProviderContext = {
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
    credential: built.credential,
    fetchImpl: deps.fetchImpl,
  };

  // ── Period control (§60) ───────────────────────────────────
  // Only consulted when the provider actually offers it. A provider that
  // cannot report period status does NOT get treated as "open" silently —
  // the operation records that the check was unavailable, so a posting
  // refused later by the provider is explicable.
  let periodChecked = false;
  if (adapter.getFinancialPeriodStatus && isUsable(declared.getFinancialPeriodStatus)) {
    const period = await adapter.getFinancialPeriodStatus(ctx, built.date);
    if (period.ok) {
      periodChecked = true;
      if (period.data.status === "closed") {
        return block(db, processing, "POSTING_BLOCKED",
          `The accounting period ${period.data.periodKey} is closed at the provider. Academic Nexus will not reopen it.`);
      }
    }
  }

  await transition(db, processing, {
    financial_year: financialYear,
    period_key: periodKey,
    request_hash: bodyHash(built.payload),
    request_summary: redact({ ...built.summary, periodChecked }) as Json,
  });

  // ── The one call ───────────────────────────────────────────
  const result = await invoke(adapter, capability, ctx, built);

  // ── Outcome ────────────────────────────────────────────────
  if (result.ok) {
    const externalId = result.externalId ?? (result.data as ExternalTransaction | undefined)?.id;
    if (!externalId) {
      // §40: an acknowledgement with no identity is not a synchronisation.
      await transition(db, processing, {
        status: "RECONCILIATION_REQUIRED",
        retry_safety: "unsafe",
        error_code: "NO_EXTERNAL_ID",
        error_message: "The provider accepted the request but returned no identifier. Reconcile before any retry.",
        response_hash: result.responseHash ?? null,
        completed_at: now().toISOString(),
      });
      return { operationId: op.id, status: "RECONCILIATION_REQUIRED", errorCode: "NO_EXTERNAL_ID" };
    }

    // The link is written FIRST. If the status update were to fail after a
    // successful post, the link is what stops the next run from creating a
    // second document.
    const { error: linkError } = await db.from("finance_external_links").insert({
      college_id: op.college_id,
      connection_id: op.connection_id,
      entity_type: linkableType!,
      entity_id: op.entity_id!,
      external_id: externalId,
      external_number: result.externalNumber ?? null,
      external_type: built.externalType,
      external_created_at: now().toISOString(),
    });
    if (linkError && linkError.code !== "23505") {
      await transition(db, processing, {
        status: "RECONCILIATION_REQUIRED",
        retry_safety: "unsafe",
        error_code: "LINK_WRITE_FAILED",
        error_message: `The provider created ${externalId} but the link could not be stored: ${linkError.message}`,
        response_hash: result.responseHash ?? null,
        completed_at: now().toISOString(),
      });
      return { operationId: op.id, status: "RECONCILIATION_REQUIRED", errorCode: "LINK_WRITE_FAILED", externalId };
    }

    await transition(db, processing, {
      status: "SYNCED",
      external_id: externalId,
      external_number: result.externalNumber ?? null,
      response_hash: result.responseHash ?? null,
      error_code: null,
      error_message: null,
      retry_safety: null,
      completed_at: now().toISOString(),
    });
    await db
      .from("finance_integration_connections")
      .update({ last_success_at: now().toISOString(), last_error_code: null, last_error_message: null })
      .eq("id", conn.id);
    return { operationId: op.id, status: "SYNCED", externalId };
  }

  // Failure.
  const safety = retrySafetyFor(result.kind);
  const exhausted = attempt >= op.max_attempts;

  await db
    .from("finance_integration_connections")
    .update({ last_failure_at: now().toISOString(), last_error_code: result.code, last_error_message: result.message })
    .eq("id", conn.id);

  if (safety === "unsafe") {
    // The document may exist at the provider. Never a retry — reconcile.
    await transition(db, processing, {
      status: "RECONCILIATION_REQUIRED",
      retry_safety: "unsafe",
      error_code: result.code,
      error_message: result.message,
      response_hash: result.responseHash ?? null,
      completed_at: now().toISOString(),
    });
    return { operationId: op.id, status: "RECONCILIATION_REQUIRED", errorCode: result.code, message: result.message };
  }

  if (safety === "exhausted" || exhausted) {
    await transition(db, processing, {
      status: "FAILED",
      retry_safety: "exhausted",
      error_code: result.code,
      error_message: result.message,
      response_hash: result.responseHash ?? null,
      completed_at: now().toISOString(),
    });
    return { operationId: op.id, status: "FAILED", errorCode: result.code, message: result.message };
  }

  await transition(db, processing, {
    status: "FAILED",
    retry_safety: "safe",
    error_code: result.code,
    error_message: result.message,
    response_hash: result.responseHash ?? null,
    next_attempt_at: nextAttemptAt(attempt, result.retryAfterSeconds, now()).toISOString(),
    completed_at: now().toISOString(),
  });
  return { operationId: op.id, status: "FAILED", errorCode: result.code, message: result.message };
}

// ─────────────────────────────────────────────────────────────
// Request construction
// ─────────────────────────────────────────────────────────────

interface BuiltRequest {
  date: string;
  payload: unknown;
  summary: Record<string, unknown>;
  externalType: string;
  credential: ProviderContext["credential"];
  kind: "payment" | "refund" | "customer";
  request: unknown;
}

/**
 * Turns an Academic Nexus row into a provider-neutral request, resolving
 * every external reference through the mapping table.
 *
 * The credential is loaded here, in the worker, and is never returned to a
 * caller or written to the journal.
 */
async function buildRequest(db: Db, conn: Connection, op: SyncOperation): Promise<BuiltRequest> {
  const { loadCredential } = await import("./credentials");
  const credential = await loadCredential(db, conn.id);
  const index = indexMappings(await loadMappings(db, conn.id));

  if (op.operation === "create_payment") {
    const { data: payment } = await db
      .from("payments")
      .select("id, amount, method, transaction_ref, receipt_number, notes, created_at, status, student_id, fee_id, college_id")
      .eq("id", op.entity_id!)
      .single();
    if (!payment) throw new Error("Payment not found.");
    if (payment.college_id !== conn.college_id) throw new Error("Payment belongs to another college.");
    // §57: only money that actually arrived may become an accounting entry.
    // 'cleared' is the only status that credits the fee (047 §7i), so it is
    // the only one that may leave the building.
    if (payment.status !== "cleared") {
      throw new Error(`A ${payment.status} payment is not postable; only a cleared payment becomes an accounting entry.`);
    }

    const { data: fee } = await db.from("fees").select("type").eq("id", payment.fee_id).single();
    const feeHead = fee?.type ?? "";
    requireMapping(index, "fee_head", feeHead);          // income account must exist even for a receipt
    const mode = requireMapping(index, "payment_method", payment.method);
    const bank = requireMapping(index, "bank_account", payment.method);
    const customer = requireMapping(index, "customer", payment.student_id);

    const date = String(payment.created_at).slice(0, 10);
    const request = {
      reference: payment.id,
      receiptNumber: payment.receipt_number ?? undefined,
      customerExternalId: customer.external_id ?? customer.external_name,
      depositAccountExternalId: bank.external_id ?? bank.external_name,
      depositAccountExternalName: bank.external_name,
      date,
      amount: Number(payment.amount),
      currency: "INR",
      paymentMode: mode.external_name,
      transactionRef: payment.transaction_ref ?? undefined,
      notes: payment.notes ?? undefined,
    };
    return {
      date,
      payload: request,
      summary: { entity: "payment", amount: request.amount, mode: mode.external_name, ledger: bank.external_name, feeHead },
      externalType: "receipt",
      credential,
      kind: "payment",
      request,
    };
  }

  if (op.operation === "create_refund") {
    const { data: refund } = await db
      .from("refund_requests")
      .select("id, amount, status, student_id, payment_id, reason, college_id, reviewed_at")
      .eq("id", op.entity_id!)
      .single();
    if (!refund) throw new Error("Refund request not found.");
    if (refund.college_id !== conn.college_id) throw new Error("Refund belongs to another college.");
    // §59: a requested refund is not a refund. Only an approved one — the
    // state approve_refund() produces — has moved money.
    if (refund.status !== "approved") {
      throw new Error(`A ${refund.status} refund request is not postable; only an approved refund is an accounting event.`);
    }

    const customer = requireMapping(index, "customer", refund.student_id);
    const { data: paymentLink } = await db
      .from("finance_external_links")
      .select("external_id")
      .eq("connection_id", conn.id)
      .eq("entity_type", "payment")
      .eq("entity_id", refund.payment_id)
      .maybeSingle();
    if (!paymentLink) {
      throw new Error("The original payment has not been posted to this accounting system yet; refund it there first.");
    }

    const date = String(refund.reviewed_at ?? new Date().toISOString()).slice(0, 10);
    const request = {
      reference: refund.id,
      paymentExternalId: paymentLink.external_id,
      customerExternalId: customer.external_id ?? customer.external_name,
      date,
      amount: Number(refund.amount),
      currency: "INR",
      reason: refund.reason ?? undefined,
    };
    return {
      date,
      payload: request,
      summary: { entity: "refund", amount: request.amount, against: paymentLink.external_id },
      externalType: "credit_note",
      credential,
      kind: "refund",
      request,
    };
  }

  if (op.operation === "create_customer") {
    const { data: student } = await db
      .from("students")
      .select("id, enrollment_number, college_id, user_id")
      .eq("id", op.entity_id!)
      .single();
    if (!student) throw new Error("Student not found.");
    if (student.college_id !== conn.college_id) throw new Error("Student belongs to another college.");
    const { data: profile } = await db
      .from("profiles")
      .select("full_name, email")
      .eq("id", student.user_id)
      .single();

    const date = new Date().toISOString().slice(0, 10);
    const request = {
      reference: student.id,
      name: profile?.full_name ?? student.enrollment_number,
      email: profile?.email ?? undefined,
      enrollmentNumber: student.enrollment_number,
    };
    return {
      date,
      payload: request,
      summary: { entity: "student", enrollment: student.enrollment_number },
      externalType: "contact",
      credential,
      kind: "customer",
      request,
    };
  }

  throw new Error(`Operation "${op.operation}" has no request builder.`);
}

async function invoke(
  adapter: ReturnType<typeof adapterFor>,
  capability: CapabilityName,
  ctx: ProviderContext,
  built: BuiltRequest
): Promise<ProviderResult<unknown>> {
  switch (capability) {
    case "createPayment":
      return adapter.createPayment!(ctx, built.request as Parameters<NonNullable<typeof adapter.createPayment>>[1]);
    case "createRefund":
      return adapter.createRefund!(ctx, built.request as Parameters<NonNullable<typeof adapter.createRefund>>[1]);
    case "createCustomer":
      return adapter.createCustomer!(ctx, built.request as Parameters<NonNullable<typeof adapter.createCustomer>>[1]);
    case "createInvoice":
      return adapter.createInvoice!(ctx, built.request as Parameters<NonNullable<typeof adapter.createInvoice>>[1]);
    default:
      throw new Error(`invoke(): ${capability} is not dispatchable.`);
  }
}

export const __testing = { CAPABILITY_FOR_OPERATION, buildRequest, taxFor };
