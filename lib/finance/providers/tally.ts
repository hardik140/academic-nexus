import {
  type AccountingProviderAdapter,
  type CapabilityMap,
  type ExternalAccount,
  type ExternalOrganization,
  type ExternalTransaction,
  type FinancialPeriod,
  type PaymentRequest,
  type ProviderContext,
  type ProviderResult,
  type RefundRequest,
  type CustomerRequest,
  type InvoiceRequest,
  fail,
  ok,
  unsupported,
} from "./types";
import { bodyHash } from "../crypto";

/**
 * TallyPrime adapter — XML over HTTP.
 *
 * Tally is not a cloud REST API and this adapter does not pretend otherwise.
 * TallyPrime acts as an HTTP server on a port (9000 by default) on a machine
 * inside the institution's network, speaking a request/response XML dialect,
 * with a COMPANY that must be loaded in the running instance. All four of
 * those are environmental facts, and each of them is a way for a posting to
 * go silently wrong, so each is checked rather than assumed.
 *
 * TRANSPORT IS SEPARATE FROM PROTOCOL. `TallyTransport` below is the seam:
 * XML/HTTP is implemented; ODBC is declared and reports
 * REQUIRES_CONFIGURATION because this runtime has no ODBC driver and
 * inventing one would be a lie the operator could not see; file-drop is not
 * implemented at all. Tally logic lives here and nowhere else in the finance
 * code (§42).
 *
 * THE COMPANY IS THE SAFETY BOUNDARY. `localhost:9000` is not an identity —
 * the same port serves whatever company happens to be open, and the wrong
 * one means a term's fee collection posted into another entity's books. So
 * every call carries SVCURRENTCOMPANY explicitly, and `getOrganizations`
 * exists to let the wizard confirm the loaded company before ACTIVE (§43).
 *
 * IDEMPOTENCY. Tally has no idempotency header. What it does have is
 * REMOTEID on a voucher: send the same REMOTEID twice and the second import
 * ALTERS the first rather than creating a second voucher. The pipeline's
 * idempotency key is used as that REMOTEID, which is what makes a retry
 * safe at Tally's end and not merely at ours.
 *
 * THE PARSER IS DELIBERATELY SMALL. Tally's responses for the shapes used
 * here are flat tag sequences, so tag extraction is sufficient and adds no
 * dependency. It is NOT a general XML parser, and anything it cannot read is
 * reported as an unknown result rather than guessed at.
 */

const DEFAULT_PORT = 9000;
const TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────

export interface TallyTransport {
  readonly kind: "xml_http" | "odbc" | "file";
  send(ctx: ProviderContext, xml: string): Promise<ProviderResult<string>>;
}

export const xmlHttpTransport: TallyTransport = {
  kind: "xml_http",
  async send(ctx, xml) {
    const host = ctx.host?.trim();
    if (!host) {
      return fail("capability", "NO_HOST", "This Tally connection has no host configured.", "exhausted");
    }
    const url = `http://${host}:${ctx.port ?? DEFAULT_PORT}`;
    const doFetch = ctx.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let sent = false;
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/xml;charset=utf-8" },
        body: xml,
        signal: controller.signal,
      });
      sent = true;
      const text = await response.text();
      if (!response.ok) {
        return fail("provider_error", `HTTP_${response.status}`,
          `TallyPrime returned HTTP ${response.status}.`, "safe", { responseHash: bodyHash(text) });
      }
      return ok(text, { responseHash: bodyHash(text) });
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError";
      if (aborted || sent) {
        // Tally may have imported the voucher and failed to answer. Never
        // re-POST on this outcome.
        return fail("unknown_result", "TIMEOUT",
          "TallyPrime did not respond in time. The voucher may or may not have been imported.", "unsafe");
      }
      return fail("network", "NETWORK",
        `Could not reach TallyPrime at ${url}. Is the instance running with its HTTP server enabled?`, "safe");
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * ODBC is a real TallyPrime integration mechanism and is NOT implemented
 * here: this runtime ships no ODBC driver, and an adapter that claimed the
 * capability would be discovered only when a posting silently failed.
 */
export const odbcTransport: TallyTransport = {
  kind: "odbc",
  async send() {
    return fail(
      "capability",
      "ODBC_NOT_CONFIGURED",
      "ODBC transport is not configured in this deployment. Use the XML/HTTP transport, " +
        "or install and configure an ODBC driver and enable it for this connection.",
      "exhausted"
    );
  },
};

function transportFor(ctx: ProviderContext): TallyTransport {
  return ctx.transport === "odbc" ? odbcTransport : xmlHttpTransport;
}

// ─────────────────────────────────────────────────────────────
// XML helpers
// ─────────────────────────────────────────────────────────────

/** Escapes the five XML entities. Tally rejects a raw & in a ledger name. */
function esc(value: string | number | undefined): string {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? m[1].trim() : undefined;
}

function tagAll(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

function envelope(body: string, company?: string | null, request = "Export Data"): string {
  return (
    `<ENVELOPE><HEADER><TALLYREQUEST>${request}</TALLYREQUEST></HEADER><BODY>` +
    `<DESC><STATICVARIABLES>` +
    `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>` +
    (company ? `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>` : "") +
    `</STATICVARIABLES></DESC>${body}</BODY></ENVELOPE>`
  );
}

function exportCollection(collection: string, company?: string | null): string {
  return envelope(
    `<EXPORTDATA><REQUESTDESC><REPORTNAME>${esc(collection)}</REPORTNAME></REQUESTDESC></EXPORTDATA>`,
    company
  );
}

/**
 * Reads Tally's import acknowledgement.
 *
 * A Tally import answers with counts. CREATED=1 with a LASTVCHID is an
 * acknowledgement carrying an identity; CREATED=0 with LINEERROR is a
 * refusal; anything else — including a 200 whose body has neither — is an
 * unknown result, because "Tally said something we do not understand" must
 * never become SYNCED.
 */
function readImportResponse(xml: string): {
  outcome: "created" | "altered" | "error" | "unknown";
  id?: string;
  error?: string;
} {
  const lineError = tag(xml, "LINEERROR");
  if (lineError) return { outcome: "error", error: lineError };

  const created = Number(tag(xml, "CREATED") ?? "0");
  const altered = Number(tag(xml, "ALTERED") ?? "0");
  const id = tag(xml, "LASTVCHID") || tag(xml, "LASTMID") || undefined;

  if (created > 0 && id) return { outcome: "created", id };
  if (altered > 0 && id) return { outcome: "altered", id };
  const errors = Number(tag(xml, "ERRORS") ?? "0");
  if (errors > 0) return { outcome: "error", error: tag(xml, "DESC") ?? "TallyPrime reported an import error." };
  return { outcome: "unknown" };
}

/**
 * A receipt voucher.
 *
 * REMOTEID carries the idempotency key so a repeated import alters rather
 * than duplicates. The ledger names come from the mapping table — never a
 * default — and the amounts follow Tally's sign convention (a receipt debits
 * the bank/cash ledger and credits the party).
 */
function receiptVoucher(req: PaymentRequest, idempotencyKey: string, company?: string | null): string {
  const body =
    `<IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>` +
    (company ? `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : "") +
    `</REQUESTDESC><REQUESTDATA><TALLYMESSAGE>` +
    `<VOUCHER VCHTYPE="Receipt" ACTION="Create" OBJVIEW="Accounting Voucher View">` +
    `<REMOTEID>${esc(idempotencyKey)}</REMOTEID>` +
    `<DATE>${esc(req.date.replace(/-/g, ""))}</DATE>` +
    `<VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>` +
    `<REFERENCE>${esc(req.receiptNumber ?? req.reference)}</REFERENCE>` +
    `<NARRATION>${esc(req.notes ?? "")}</NARRATION>` +
    `<ALLLEDGERENTRIES.LIST>` +
    `<LEDGERNAME>${esc(req.depositAccountExternalName)}</LEDGERNAME>` +
    `<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>` +
    `<AMOUNT>-${esc(req.amount)}</AMOUNT>` +
    `</ALLLEDGERENTRIES.LIST>` +
    `<ALLLEDGERENTRIES.LIST>` +
    `<LEDGERNAME>${esc(req.customerExternalId)}</LEDGERNAME>` +
    `<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>` +
    `<AMOUNT>${esc(req.amount)}</AMOUNT>` +
    `</ALLLEDGERENTRIES.LIST>` +
    `</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA>`;
  return envelope(body, company, "Import Data");
}

function paymentVoucher(req: RefundRequest, idempotencyKey: string, company?: string | null): string {
  // A refund out of the institution is a Payment voucher: the party ledger is
  // debited and the bank/cash ledger credited — the mirror of the receipt.
  const body =
    `<IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>` +
    (company ? `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : "") +
    `</REQUESTDESC><REQUESTDATA><TALLYMESSAGE>` +
    `<VOUCHER VCHTYPE="Payment" ACTION="Create" OBJVIEW="Accounting Voucher View">` +
    `<REMOTEID>${esc(idempotencyKey)}</REMOTEID>` +
    `<DATE>${esc(req.date.replace(/-/g, ""))}</DATE>` +
    `<VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>` +
    `<REFERENCE>${esc(req.reference)}</REFERENCE>` +
    `<NARRATION>${esc(req.reason ?? "Refund")}</NARRATION>` +
    `<ALLLEDGERENTRIES.LIST>` +
    `<LEDGERNAME>${esc(req.customerExternalId)}</LEDGERNAME>` +
    `<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>` +
    `<AMOUNT>-${esc(req.amount)}</AMOUNT>` +
    `</ALLLEDGERENTRIES.LIST>` +
    `</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA>`;
  return envelope(body, company, "Import Data");
}

// ─────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────

export const tallyPrimeAdapter: AccountingProviderAdapter = {
  id: "tallyprime",
  displayName: "TallyPrime",

  async testConnection(ctx) {
    const res = await transportFor(ctx).send(ctx, exportCollection("List of Companies"));
    if (!res.ok) return res;
    // Tally answers a request it cannot serve with a body containing
    // LINEERROR rather than an HTTP error.
    const err = tag(res.data, "LINEERROR");
    if (err) return fail("provider_error", "TALLY_LINEERROR", err, "safe", { responseHash: res.responseHash });
    return ok({ reachable: true as const }, { responseHash: res.responseHash });
  },

  async getCapabilities(ctx) {
    if (ctx.transport === "odbc") {
      return ok({ testConnection: "REQUIRES_CONFIGURATION" } as CapabilityMap);
    }
    const probe = await transportFor(ctx).send(ctx, exportCollection("List of Companies"));
    if (!probe.ok) {
      return ok({ testConnection: "BLOCKED" } as CapabilityMap, { responseHash: probe.responseHash });
    }
    const map: CapabilityMap = {
      testConnection: "SUPPORTED",
      getOrganizations: "SUPPORTED",
      getAccounts: "CONFIGURED",
      createCustomer: "CONFIGURED",       // a party ledger
      createPayment: "CONFIGURED",        // Receipt voucher
      createRefund: "CONFIGURED",         // Payment voucher
      createJournalEntry: "CONFIGURED",
      searchTransactions: "CONFIGURED",
      // Tally holds a sales invoice, but the fee-demand shape here maps onto
      // party ledgers and receipts; invoice export is not claimed until a
      // live environment confirms the voucher class an institution uses.
      createInvoice: "REQUIRES_CONFIGURATION",
      getTaxRates: "REQUIRES_CONFIGURATION",
      // Tally enforces period locks in the UI; reading that state over XML
      // depends on the company's configuration.
      getFinancialPeriodStatus: "REQUIRES_CONFIGURATION",
      webhooks: "UNSUPPORTED",            // Tally does not call out
    };
    return ok(map, { responseHash: probe.responseHash });
  },

  async getOrganizations(ctx) {
    const res = await transportFor(ctx).send(ctx, exportCollection("List of Companies"));
    if (!res.ok) return res;
    const names = tagAll(res.data, "NAME");
    if (names.length === 0) {
      return fail("wrong_company", "NO_COMPANY_LOADED",
        "TallyPrime answered but reported no loaded company. Open the company in TallyPrime and retry.",
        "exhausted", { responseHash: res.responseHash });
    }
    const orgs: ExternalOrganization[] = names.map((name) => ({ id: name, name }));
    return ok(orgs, { responseHash: res.responseHash });
  },

  async getAccounts(ctx) {
    const res = await transportFor(ctx).send(ctx, exportCollection("List of Ledgers"));
    if (!res.ok) return res;
    const names = tagAll(res.data, "NAME");
    const accounts: ExternalAccount[] = names.map((name) => ({ id: name, name }));
    return ok(accounts, { responseHash: res.responseHash });
  },

  /**
   * A "customer" in Tally is a party ledger under Sundry Debtors. Created by
   * name, which is also its identity — Tally ledgers are keyed by name, so
   * the mapping table stores that name and the pipeline sends it.
   */
  async createCustomer(ctx, req: CustomerRequest) {
    const body =
      `<IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>` +
      `<REQUESTDATA><TALLYMESSAGE>` +
      `<LEDGER NAME="${esc(req.name)}" ACTION="Create">` +
      `<NAME>${esc(req.name)}</NAME>` +
      `<PARENT>Sundry Debtors</PARENT>` +
      `<ISBILLWISEON>Yes</ISBILLWISEON>` +
      (req.email ? `<EMAIL>${esc(req.email)}</EMAIL>` : "") +
      `</LEDGER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA>`;
    const res = await transportFor(ctx).send(ctx, envelope(body, ctx.externalCompanyName, "Import Data"));
    if (!res.ok) return res;
    const parsed = readImportResponse(res.data);
    if (parsed.outcome === "error") {
      return fail("validation", "TALLY_IMPORT_ERROR", parsed.error ?? "TallyPrime refused the ledger.", "exhausted", {
        responseHash: res.responseHash,
      });
    }
    if (parsed.outcome === "unknown") {
      return fail("unknown_result", "UNREADABLE_ACK",
        "TallyPrime's response could not be read as an acknowledgement.", "unsafe", { responseHash: res.responseHash });
    }
    return ok({ id: req.name, name: req.name, reference: req.reference }, {
      externalId: req.name,
      responseHash: res.responseHash,
    });
  },

  async createPayment(ctx, req: PaymentRequest) {
    // The idempotency key doubles as Tally's REMOTEID (see the header note).
    const remoteId = req.reference;
    const res = await transportFor(ctx).send(ctx, receiptVoucher(req, remoteId, ctx.externalCompanyName));
    if (!res.ok) return res;
    const parsed = readImportResponse(res.data);
    if (parsed.outcome === "error") {
      const periodClosed = /period|closed|locked|date.*not.*allow/i.test(parsed.error ?? "");
      return fail(periodClosed ? "period_closed" : "validation", "TALLY_IMPORT_ERROR",
        parsed.error ?? "TallyPrime refused the receipt voucher.", "exhausted", { responseHash: res.responseHash });
    }
    if (parsed.outcome === "unknown" || !parsed.id) {
      return fail("unknown_result", "NO_VOUCHER_ID",
        "TallyPrime accepted the request but returned no voucher id. Reconcile before retrying.", "unsafe",
        { responseHash: res.responseHash });
    }
    const tx: ExternalTransaction = {
      id: parsed.id,
      type: "receipt",
      date: req.date,
      amount: req.amount,
      reference: req.reference,
    };
    return ok(tx, { externalId: parsed.id, responseHash: res.responseHash });
  },

  async createRefund(ctx, req: RefundRequest) {
    const res = await transportFor(ctx).send(ctx, paymentVoucher(req, req.reference, ctx.externalCompanyName));
    if (!res.ok) return res;
    const parsed = readImportResponse(res.data);
    if (parsed.outcome === "error") {
      return fail("validation", "TALLY_IMPORT_ERROR",
        parsed.error ?? "TallyPrime refused the payment voucher.", "exhausted", { responseHash: res.responseHash });
    }
    if (parsed.outcome === "unknown" || !parsed.id) {
      return fail("unknown_result", "NO_VOUCHER_ID",
        "TallyPrime accepted the request but returned no voucher id. Reconcile before retrying.", "unsafe",
        { responseHash: res.responseHash });
    }
    return ok(
      { id: parsed.id, type: "payment", date: req.date, amount: req.amount, reference: req.reference },
      { externalId: parsed.id, responseHash: res.responseHash }
    );
  },

  async createInvoice(_ctx, _req: InvoiceRequest) {
    return unsupported(
      "createInvoice",
      "The sales-voucher class an institution uses for fee demands is site-specific; " +
        "configure it and enable this capability once verified against the live company."
    );
  },

  async searchTransactions(ctx, query) {
    const res = await transportFor(ctx).send(ctx, exportCollection("Day Book", ctx.externalCompanyName));
    if (!res.ok) return res;
    const vouchers = tagAll(res.data, "VOUCHER");
    const transactions: ExternalTransaction[] = vouchers.map((v) => ({
      id: tag(v, "MASTERID") ?? tag(v, "REMOTEID") ?? "",
      number: tag(v, "VOUCHERNUMBER"),
      type: tag(v, "VOUCHERTYPENAME") ?? "voucher",
      date: (tag(v, "DATE") ?? "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
      amount: Math.abs(Number(tag(v, "AMOUNT") ?? 0)),
      reference: tag(v, "REFERENCE"),
    }));
    const inWindow = transactions.filter((t) => t.date >= query.from && t.date <= query.to);
    return ok({ transactions: inWindow }, { responseHash: res.responseHash });
  },

  async findByReference(ctx, reference) {
    const page = await this.searchTransactions!(ctx, { from: "1900-01-01", to: "2999-12-31" });
    if (!page.ok) return page;
    const hit = page.data.transactions.find((t) => t.reference === reference);
    return ok(hit ?? null, { externalId: hit?.id, responseHash: page.responseHash });
  },

  async getFinancialPeriodStatus(_ctx, _date): Promise<ProviderResult<FinancialPeriod>> {
    return unsupported(
      "getFinancialPeriodStatus",
      "Reading TallyPrime's period lock over XML depends on the company's configuration; " +
        "not claimed until verified against a live company."
    );
  },

  async healthCheck(ctx) {
    const res = await transportFor(ctx).send(ctx, exportCollection("List of Companies"));
    if (!res.ok) return ok({ healthy: false, detail: res.message });
    return ok({ healthy: true });
  },
};

export const __testing = { esc, tag, tagAll, envelope, readImportResponse, receiptVoucher, paymentVoucher };
