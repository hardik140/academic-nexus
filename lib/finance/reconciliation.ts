import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { adapterFor } from "./providers/registry";
import { isUsable, type CapabilityMap, type ExternalTransaction, type ProviderContext } from "./providers/types";
import { loadCredential } from "./credentials";
import { dbError } from "@/lib/internal-error";
import { businessRpc } from "@/lib/business-rpc";

/**
 * The reconciliation engine (§64, §65, §80, §98).
 *
 * Synchronising is not the same as agreeing. A payment can be SYNCED with a
 * real external id and the two systems can still disagree the next morning —
 * somebody voided the voucher in Tally, an amount was edited in Zoho, a
 * receipt exists there that Academic Nexus never sent. Synchronisation
 * status answers "did we send it"; reconciliation answers "do the books
 * match", and only the second one is what a finance officer signs.
 *
 * WHAT THIS PRODUCES
 *
 * Not a number. Every difference is a typed row naming the exact local
 * transaction, the exact external document, and both amounts — because
 * "₹5,000 difference" is not something anyone can act on, and the whole
 * point of §80 is that the system says WHICH transaction.
 *
 * WHAT THIS NEVER DOES
 *
 * It does not repair anything. It does not create a missing external
 * document, does not adjust a local amount to match, and does not delete a
 * local record because the external one vanished (§71). Every finding waits
 * for a person, because each of those "repairs" is a different business
 * decision and picking one silently is how an integration corrupts a ledger.
 */

type Db = SupabaseClient<Database>;
type Connection = Database["public"]["Tables"]["finance_integration_connections"]["Row"];
type Item = Database["public"]["Tables"]["finance_reconciliation_items"]["Insert"];

export interface ReconcileInput {
  collegeId: string;
  connectionId: string;
  periodStart: string;   // YYYY-MM-DD
  periodEnd: string;
  createdBy?: string;
  systemActor?: string;
}

export interface ReconcileOutcome {
  runId: string;
  status: "RECONCILED" | "RECONCILIATION_REQUIRED" | "FAILED";
  localCount: number;
  externalCount: number;
  localAmount: number;
  externalAmount: number;
  differenceAmount: number;
  issues: number;
}

const MONEY_EPSILON = 0.005; // half a paisa — NUMERIC(12,2) rounding, not a tolerance

export async function reconcile(
  db: Db,
  input: ReconcileInput,
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<ReconcileOutcome> {
  const { data: runRow, error: runError } = await db
    .from("finance_reconciliation_runs")
    .insert({
      college_id: input.collegeId,
      connection_id: input.connectionId,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      status: "RUNNING",
      created_by: input.createdBy ?? null,
      system_actor: input.createdBy ? null : (input.systemActor ?? "scheduler"),
    })
    .select("id, started_at")
    .single();
  if (runError || !runRow) {
    throw dbError({ ...runError, message: runError?.message ?? "Could not start a reconciliation run." });
  }
  const runId = runRow.id;
  // The run's set of local payments is fixed here: one created later is the next run's.
  const asOf = runRow.started_at;

  try {
    const { data: connRow } = await db
      .from("finance_integration_connections")
      .select("*")
      .eq("id", input.connectionId)
      .single();
    const conn = connRow as Connection | null;
    if (!conn) throw new Error("Connection not found.");
    if (conn.college_id !== input.collegeId) throw new Error("Connection belongs to another college.");

    const adapter = adapterFor(conn.provider);
    const declared = (conn.capabilities ?? {}) as CapabilityMap;
    if (!adapter.searchTransactions || !isUsable(declared.searchTransactions)) {
      throw new Error(
        `${conn.provider} cannot list transactions on this connection (searchTransactions is ` +
          `${declared.searchTransactions ?? "NOT_TESTED"}), so the books cannot be compared.`
      );
    }

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
      credential: await loadCredential(db, conn.id),
      fetchImpl: deps.fetchImpl,
    };

    // ── The two sides ──────────────────────────────────────────
    const local = await loadLocalPayments(db, input, asOf);
    const external = await loadExternalTransactions(adapter, ctx, input);
    const links = await loadLinks(db, input.connectionId, local.map((p) => p.id));

    const items: Item[] = [];
    const externalById = new Map(external.map((t) => [t.id, t]));
    const externalByReference = new Map<string, ExternalTransaction[]>();
    for (const t of external) {
      if (!t.reference) continue;
      externalByReference.set(t.reference, [...(externalByReference.get(t.reference) ?? []), t]);
    }
    const matchedExternalIds = new Set<string>();

    for (const payment of local) {
      const link = links.get(payment.id);

      if (!link) {
        // Never posted, or posted and the link lost. Distinguishing the two
        // matters: a document at the provider carrying our reference is a
        // lost link, not a missing transaction, and re-posting it would
        // duplicate.
        const orphans = externalByReference.get(payment.id) ?? [];
        if (orphans.length > 0) {
          for (const orphan of orphans) matchedExternalIds.add(orphan.id);
          items.push({
            college_id: input.collegeId,
            run_id: runId,
            difference_type: "EXTERNAL_ID_MISMATCH",
            entity_type: "payment",
            entity_id: payment.id,
            external_id: orphans[0].id,
            local_amount: payment.amount,
            external_amount: orphans[0].amount,
            detail:
              `Payment ${payment.id} has no recorded external link, but ${orphans.length === 1 ? "a document" : `${orphans.length} documents`} ` +
              `carrying its reference exist(s) at the provider (${orphans.map((o) => o.id).join(", ")}). ` +
              `Link it rather than re-posting.`,
          });
        } else {
          items.push({
            college_id: input.collegeId,
            run_id: runId,
            difference_type: "MISSING_EXTERNAL_TRANSACTION",
            entity_type: "payment",
            entity_id: payment.id,
            local_amount: payment.amount,
            detail: `Payment ${payment.id} of ${payment.amount.toFixed(2)} on ${payment.date} has not been posted to the accounting system.`,
          });
        }
        continue;
      }

      matchedExternalIds.add(link.external_id);
      const counterpart = externalById.get(link.external_id);

      if (!counterpart) {
        // We hold a link to a document the provider no longer returns: it
        // was voided or deleted there. §71 — never mirror that deletion.
        items.push({
          college_id: input.collegeId,
          run_id: runId,
          difference_type: "MISSING_LOCAL_TRANSACTION",
          entity_type: "payment",
          entity_id: payment.id,
          external_id: link.external_id,
          local_amount: payment.amount,
          detail:
            `Payment ${payment.id} is linked to external document ${link.external_id}, which the provider did not return ` +
            `for this period. It may have been voided or deleted externally. Academic Nexus has changed nothing.`,
        });
        continue;
      }

      if (Math.abs(counterpart.amount - payment.amount) > MONEY_EPSILON) {
        items.push({
          college_id: input.collegeId,
          run_id: runId,
          difference_type: "AMOUNT_MISMATCH",
          entity_type: "payment",
          entity_id: payment.id,
          external_id: counterpart.id,
          local_amount: payment.amount,
          external_amount: counterpart.amount,
          detail: `Payment ${payment.id}: Academic Nexus holds ${payment.amount.toFixed(2)}, the accounting system holds ${counterpart.amount.toFixed(2)}.`,
        });
      }

      if (counterpart.date && counterpart.date !== payment.date) {
        items.push({
          college_id: input.collegeId,
          run_id: runId,
          difference_type: "DATE_MISMATCH",
          entity_type: "payment",
          entity_id: payment.id,
          external_id: counterpart.id,
          detail: `Payment ${payment.id}: recorded ${payment.date} here, ${counterpart.date} at the provider.`,
        });
      }
    }

    // Duplicates on either side.
    const localByKey = new Map<string, string[]>();
    for (const p of local) {
      const key = `${p.student_id}|${p.fee_id}|${p.amount}|${p.date}`;
      localByKey.set(key, [...(localByKey.get(key) ?? []), p.id]);
    }
    for (const [key, ids] of localByKey) {
      if (ids.length > 1) {
        items.push({
          college_id: input.collegeId,
          run_id: runId,
          difference_type: "DUPLICATE_LOCAL_TRANSACTION",
          entity_type: "payment",
          entity_id: ids[0],
          detail: `${ids.length} Academic Nexus payments share (student, fee, amount, date) [${key}]: ${ids.join(", ")}.`,
        });
      }
    }

    const externalByRefCount = new Map<string, ExternalTransaction[]>();
    for (const t of external) {
      if (!t.reference) continue;
      externalByRefCount.set(t.reference, [...(externalByRefCount.get(t.reference) ?? []), t]);
    }
    for (const [reference, docs] of externalByRefCount) {
      if (docs.length > 1) {
        items.push({
          college_id: input.collegeId,
          run_id: runId,
          difference_type: "DUPLICATE_EXTERNAL_TRANSACTION",
          entity_type: "payment",
          external_id: docs[0].id,
          external_amount: docs[0].amount,
          detail: `${docs.length} external documents carry reference ${reference}: ${docs.map((d) => d.id).join(", ")}. One of them is a duplicate posting.`,
        });
      }
    }

    // Anything at the provider we never sent.
    for (const t of external) {
      if (matchedExternalIds.has(t.id)) continue;
      items.push({
        college_id: input.collegeId,
        run_id: runId,
        difference_type: "MISSING_LOCAL_TRANSACTION",
        external_id: t.id,
        external_amount: t.amount,
        detail:
          `External document ${t.id}${t.number ? ` (${t.number})` : ""} of ${t.amount.toFixed(2)} on ${t.date} has no ` +
          `Academic Nexus counterpart. It may have been entered directly in the accounting system.`,
      });
    }

    const localAmount = round2(local.reduce((s, p) => s + p.amount, 0));
    const externalAmount = round2(external.reduce((s, t) => s + t.amount, 0));
    const difference = round2(localAmount - externalAmount);

    if (items.length > 0) {
      const { error } = await db.from("finance_reconciliation_items").insert(items);
      if (error) throw dbError(error);
    }

    const status = items.length === 0 && Math.abs(difference) <= MONEY_EPSILON ? "RECONCILED" : "RECONCILIATION_REQUIRED";
    await db
      .from("finance_reconciliation_runs")
      .update({
        status,
        local_count: local.length,
        external_count: external.length,
        local_amount: localAmount,
        external_amount: externalAmount,
        difference_amount: difference,
        issue_count: items.length,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);

    return {
      runId,
      status,
      localCount: local.length,
      externalCount: external.length,
      localAmount,
      externalAmount,
      differenceAmount: difference,
      issues: items.length,
    };
  } catch (err) {
    await db
      .from("finance_reconciliation_runs")
      .update({ status: "FAILED", error_message: (err as Error).message, completed_at: new Date().toISOString() })
      .eq("id", runId);
    return {
      runId,
      status: "FAILED",
      localCount: 0,
      externalCount: 0,
      localAmount: 0,
      externalAmount: 0,
      differenceAmount: 0,
      issues: 0,
    };
  }
}

interface LocalPayment {
  id: string;
  amount: number;
  date: string;
  student_id: string;
  fee_id: string;
}

/** Rows per page when loading a period's payments; PostgREST caps a page at 1,000 anyway. */
export const RECONCILE_PAGE = 1000;
/** Payment ids per finance_external_links read: keeps the `in (...)` list well inside a URL. */
export const LINK_CHUNK = 100;

interface PaymentPageRow {
  id: string;
  amount: number | string;
  created_at: string;
  student_id: string;
  fee_id: string;
}

/**
 * EVERY cleared payment of the period that existed when the run started, a
 * keyset page at a time (migration 060, finance_reconciliation_payments).
 *
 * Only cleared payments are accounting events (047 §7i, §57). A pending or
 * failed row missing from the provider is correct, not a discrepancy.
 *
 * WHY KEYSET. This used to page with OFFSET: a payment inserted or deleted
 * between two pages shifted every later row by one, so one could be read
 * twice or never. Each page now continues strictly after the last
 * (created_at, id) read — the cursor is the database's own value, never
 * re-parsed in JavaScript, which would drop microseconds.
 *
 * CONSISTENCY. Pages are separate statements, not one snapshot. A payment
 * present for the whole walk is read exactly once. One created after the run
 * started is excluded (p_as_of). One that changes while the walk is on is
 * read as it was when its page was read: a change behind the cursor shows
 * in the next run, not this one. No payment is ever counted twice; a
 * repeated id would mean the order broke, and fails the run.
 */
async function loadLocalPayments(db: Db, input: ReconcileInput, asOf: string): Promise<LocalPayment[]> {
  const out: LocalPayment[] = [];
  const seen = new Set<string>();
  let after: { created: string; id: string } | null = null;
  for (let page = 1; ; page++) {
    let rows: PaymentPageRow[];
    try {
      rows = await businessRpc<PaymentPageRow>(db, "finance_reconciliation_payments", {
        p_college_id: input.collegeId,
        p_from: input.periodStart,
        p_to: input.periodEnd,
        p_as_of: asOf,
        p_after_created: after?.created ?? null,
        p_after_id: after?.id ?? null,
        p_limit: RECONCILE_PAGE,
      });
    } catch {
      // businessRpc has logged the database error with its SQLSTATE.
      throw new Error(
        `Could not read page ${page} of this period's payments (after ${out.length} read). Nothing was compared; run reconciliation again.`
      );
    }
    for (const p of rows) {
      if (seen.has(p.id)) throw new Error(`Payment ${p.id} was read twice while paging; the run was stopped rather than double-count it.`);
      seen.add(p.id);
      out.push({
        id: p.id,
        amount: Number(p.amount),
        date: String(p.created_at).slice(0, 10),
        student_id: p.student_id,
        fee_id: p.fee_id,
      });
    }
    if (rows.length < RECONCILE_PAGE) return out;
    const last = rows[rows.length - 1];
    after = { created: last.created_at, id: last.id };
  }
}

/** Provider pages read per run. A provider still handing back a cursor after this many fails the run. */
const MAX_EXTERNAL_PAGES = 200;

async function loadExternalTransactions(
  adapter: ReturnType<typeof adapterFor>,
  ctx: ProviderContext,
  input: ReconcileInput
): Promise<ExternalTransaction[]> {
  const all: ExternalTransaction[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_EXTERNAL_PAGES; page++) {
    const res = await adapter.searchTransactions!(ctx, { from: input.periodStart, to: input.periodEnd, cursor });
    if (!res.ok) throw new Error(`${res.code}: ${res.message}`);
    all.push(...res.data.transactions);
    if (!res.data.nextCursor) return all;
    cursor = res.data.nextCursor;
  }
  // Comparing against part of the provider's list would report its unread
  // documents' payments as unposted. Stop instead.
  throw new Error(`The provider was still returning transactions after ${MAX_EXTERNAL_PAGES} pages; reconcile a shorter period.`);
}

async function loadLinks(db: Db, connectionId: string, paymentIds: string[]) {
  const map = new Map<string, { external_id: string }>();
  // In chunks: one `in` of every id overflowed the URL and was capped at 1,000
  // rows, and a failed read left linked payments looking unposted.
  for (let i = 0; i < paymentIds.length; i += LINK_CHUNK) {
    const { data, error } = await db
      .from("finance_external_links")
      .select("entity_id, external_id")
      .eq("connection_id", connectionId)
      .eq("entity_type", "payment")
      .in("entity_id", paymentIds.slice(i, i + LINK_CHUNK));
    if (error) {
      dbError(error);
      throw new Error("Could not read which payments are already posted. Nothing was compared; run reconciliation again.");
    }
    for (const row of data ?? []) map.set(row.entity_id, { external_id: row.external_id });
  }
  return map;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
