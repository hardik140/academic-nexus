/**
 * The provider-neutral accounting contract.
 *
 * Academic Nexus talks to TallyPrime, BUSY and Zoho Books through this one
 * interface. Nothing above the adapter layer knows whether the transport is
 * XML over HTTP, ODBC, or a REST API with OAuth — and nothing below it knows
 * what a fee head or a semester is.
 *
 * TWO RULES SHAPE EVERY TYPE HERE
 *
 * 1. An adapter never pretends. A provider that cannot do something reports
 *    UNSUPPORTED or REQUIRES_CONFIGURATION; it does not return a fabricated
 *    success. `CapabilityState` exists so that "we have not tested this
 *    against a live environment" is a value the system can hold and display,
 *    rather than a gap that reads as working.
 *
 * 2. A failure says whether it is safe to retry. The difference between "the
 *    request never arrived" and "the response never arrived" is the whole
 *    difference between a safe retry and a duplicate receipt, so it is part
 *    of the result type rather than something a caller infers from an HTTP
 *    status.
 */

export type ProviderId = "tallyprime" | "busy" | "zoho_books";

/**
 * What a provider can actually do on THIS connection.
 *
 *   SUPPORTED               verified against the provider, works now
 *   CONFIGURED              the mechanism exists and this connection is set
 *                           up for it, but it has not been exercised live
 *   REQUIRES_CONFIGURATION  possible, but something (a partner integration,
 *                           an OAuth scope, a Tally setting) is missing
 *   UNSUPPORTED             the provider does not offer it at all
 *   BLOCKED                 offered, but unusable here (no environment, no
 *                           credentials, wrong company)
 *   NOT_TESTED              never exercised; the honest default
 */
export type CapabilityState =
  | "SUPPORTED"
  | "CONFIGURED"
  | "REQUIRES_CONFIGURATION"
  | "UNSUPPORTED"
  | "BLOCKED"
  | "NOT_TESTED";

export type CapabilityName =
  | "testConnection"
  | "getOrganizations"
  | "getAccounts"
  | "getTaxRates"
  | "getContacts"
  | "createCustomer"
  | "updateCustomer"
  | "createInvoice"
  | "updateInvoice"
  | "createPayment"
  | "createRefund"
  | "createJournalEntry"
  | "getInvoice"
  | "getPayment"
  | "searchTransactions"
  | "getFinancialPeriodStatus"
  | "webhooks";

export type CapabilityMap = Partial<Record<CapabilityName, CapabilityState>>;

/** A capability may be used only when the provider says it works. */
export function isUsable(state: CapabilityState | undefined): boolean {
  return state === "SUPPORTED" || state === "CONFIGURED";
}

// ─────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────

/**
 * Why a call failed, in the terms the pipeline reasons about. These are NOT
 * HTTP statuses: a 200 carrying a provider error body is `validation`, and a
 * socket timeout after the request was written is `unknown_result`.
 */
export type ProviderErrorKind =
  | "auth"              // credentials rejected / expired / revoked
  | "forbidden"         // authenticated but not permitted (OAuth scope)
  | "rate_limited"      // back off and try later
  | "not_found"         // the referenced external object does not exist
  | "validation"        // the provider refused the document as invalid
  | "period_closed"     // the accounting period will not accept a posting
  | "capability"        // this provider/connection cannot do this at all
  | "wrong_company"     // connected, but to the wrong company/organisation
  | "network"           // could not reach the provider — request never landed
  | "unknown_result"    // the request may or may not have been applied
  | "provider_error";   // the provider failed on its own side (5xx)

/**
 * Whether the SAME request may be sent again.
 *
 *   safe      the provider definitely did not apply it (or applying it twice
 *             is harmless because the provider itself de-duplicates)
 *   unsafe    it may already exist externally — reconcile, never re-POST
 *   exhausted retries are used up; a person must decide
 */
export type RetrySafety = "safe" | "unsafe" | "exhausted";

export interface ProviderFailure {
  ok: false;
  kind: ProviderErrorKind;
  /** Provider's own code where it gives one, else a normalised token. */
  code: string;
  message: string;
  retrySafety: RetrySafety;
  /** Seconds to wait, when the provider says so (429 Retry-After). */
  retryAfterSeconds?: number;
  /** SHA-256 of the response body; the body itself is never stored. */
  responseHash?: string;
}

export interface ProviderSuccess<T> {
  ok: true;
  data: T;
  /**
   * The external document identifier. Required for anything that CREATES a
   * document: without it the pipeline refuses to record SYNCED, because an
   * acknowledgement with no identity cannot be reconciled or reversed.
   */
  externalId?: string;
  externalNumber?: string;
  responseHash?: string;
}

export type ProviderResult<T> = ProviderSuccess<T> | ProviderFailure;

export const fail = (
  kind: ProviderErrorKind,
  code: string,
  message: string,
  retrySafety: RetrySafety,
  extra: Partial<ProviderFailure> = {}
): ProviderFailure => ({ ok: false, kind, code, message, retrySafety, ...extra });

export const ok = <T>(data: T, extra: Partial<ProviderSuccess<T>> = {}): ProviderSuccess<T> => ({
  ok: true,
  data,
  ...extra,
});

/** The unsupported answer, spelled once so no adapter improvises it. */
export const unsupported = (capability: CapabilityName, why: string): ProviderFailure =>
  fail("capability", "CAPABILITY_UNSUPPORTED", `${capability}: ${why}`, "exhausted");

// ─────────────────────────────────────────────────────────────
// Normalised domain objects
// ─────────────────────────────────────────────────────────────

export interface ExternalOrganization {
  id: string;
  name: string;
  currency?: string;
  /** Tally: the loaded company's GUID/name; Zoho: organization_id. */
  raw?: Record<string, unknown>;
}

export interface ExternalAccount {
  id: string;
  code?: string;
  name: string;
  type?: string;
  currency?: string;
}

export interface ExternalTaxRate {
  id: string;
  name: string;
  percentage: number;
}

export interface ExternalContact {
  id: string;
  name: string;
  email?: string;
  reference?: string;
}

export interface ExternalTransaction {
  id: string;
  number?: string;
  type: string;
  date: string;          // YYYY-MM-DD
  amount: number;
  reference?: string;
  accountId?: string;
  accountName?: string;
  status?: string;
}

export type PeriodStatus = "open" | "closed" | "unknown";

export interface FinancialPeriod {
  financialYear: string;   // 'FY 2026-27'
  periodKey: string;       // '2026-09'
  status: PeriodStatus;
}

// ─────────────────────────────────────────────────────────────
// Requests — provider-neutral, already mapped
// ─────────────────────────────────────────────────────────────

export interface CustomerRequest {
  /** Academic Nexus students.id — carried so the provider row is traceable back. */
  reference: string;
  name: string;
  email?: string;
  enrollmentNumber?: string;
}

export interface InvoiceLine {
  description: string;
  amount: number;
  /** Already resolved through the mapping table — never a fee-head string. */
  accountExternalId: string;
  accountExternalName: string;
  taxExternalId?: string;
  taxTreatment?: string;
}

export interface InvoiceRequest {
  reference: string;            // Academic Nexus fees.id
  customerExternalId: string;
  date: string;
  dueDate: string;
  currency: string;
  lines: InvoiceLine[];
  total: number;
  notes?: string;
}

export interface PaymentRequest {
  reference: string;            // Academic Nexus payments.id
  receiptNumber?: string;       // Academic Nexus receipt number, never overwritten
  customerExternalId: string;
  /** The bank/cash ledger this collection lands in — from the mapping table. */
  depositAccountExternalId: string;
  depositAccountExternalName: string;
  invoiceExternalId?: string;
  date: string;
  amount: number;
  currency: string;
  /** Mapped payment mode as the provider names it ('UPI', 'Bank', ...). */
  paymentMode: string;
  transactionRef?: string;
  notes?: string;
}

export interface RefundRequest {
  reference: string;            // Academic Nexus refund_requests.id
  paymentExternalId: string;
  customerExternalId: string;
  date: string;
  amount: number;
  currency: string;
  reason?: string;
}

export interface JournalEntryLine {
  accountExternalId: string;
  debit?: number;
  credit?: number;
  description?: string;
}

export interface JournalEntryRequest {
  reference: string;
  date: string;
  lines: JournalEntryLine[];
  notes?: string;
}

export interface TransactionQuery {
  from: string;   // YYYY-MM-DD
  to: string;
  type?: "payment" | "invoice" | "refund";
  cursor?: string;
}

export interface TransactionPage {
  transactions: ExternalTransaction[];
  nextCursor?: string;
}

// ─────────────────────────────────────────────────────────────
// Connection context
// ─────────────────────────────────────────────────────────────

/**
 * Everything an adapter needs for one call, assembled by the worker. The
 * credential has already been decrypted in the service-role process; it
 * never crosses into a client bundle and is never logged.
 */
export interface ProviderContext {
  connectionId: string;
  collegeId: string;
  provider: ProviderId;
  environment: "production" | "sandbox";
  organizationId?: string | null;
  externalCompanyId?: string | null;
  externalCompanyName?: string | null;
  host?: string | null;
  port?: number | null;
  baseUrl?: string | null;
  transport?: "xml_http" | "odbc" | "rest" | "file" | null;
  credential: ProviderCredential;
  /** Injected so tests can drive an adapter without a network. */
  fetchImpl?: typeof fetch;
}

/**
 * The decrypted secret, shaped per provider. Deliberately a union: a Tally
 * connection has no refresh token, and a Zoho connection has no port.
 */
export type ProviderCredential =
  | { kind: "none" }
  | { kind: "oauth2"; clientId: string; clientSecret: string; refreshToken: string; accessToken?: string; accessTokenExpiresAt?: string; dataCenter?: string }
  | { kind: "basic"; username: string; password: string }
  | { kind: "api_key"; apiKey: string };

/**
 * The capability surface a provider may implement. Every method is optional
 * EXCEPT the three that describe the connection itself — an adapter that
 * cannot say what it is and whether it works has no business posting money.
 *
 * A method that is absent is not an error: `getCapabilities()` is the single
 * source of truth for what this connection can do, and the pipeline checks
 * it before dispatching rather than calling and hoping.
 */
export interface AccountingProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;

  /** Reachability + credential validity. Never creates anything. */
  testConnection(ctx: ProviderContext): Promise<ProviderResult<{ reachable: true }>>;

  /** What this connection can actually do, discovered rather than assumed. */
  getCapabilities(ctx: ProviderContext): Promise<ProviderResult<CapabilityMap>>;

  /**
   * The companies/organisations this credential can see. Used to VERIFY the
   * connection points at the intended one before any posting is allowed.
   */
  getOrganizations(ctx: ProviderContext): Promise<ProviderResult<ExternalOrganization[]>>;

  getAccounts?(ctx: ProviderContext): Promise<ProviderResult<ExternalAccount[]>>;
  getTaxRates?(ctx: ProviderContext): Promise<ProviderResult<ExternalTaxRate[]>>;
  getContacts?(ctx: ProviderContext): Promise<ProviderResult<ExternalContact[]>>;

  createCustomer?(ctx: ProviderContext, req: CustomerRequest): Promise<ProviderResult<ExternalContact>>;
  updateCustomer?(ctx: ProviderContext, externalId: string, req: CustomerRequest): Promise<ProviderResult<ExternalContact>>;

  createInvoice?(ctx: ProviderContext, req: InvoiceRequest): Promise<ProviderResult<ExternalTransaction>>;
  updateInvoice?(ctx: ProviderContext, externalId: string, req: InvoiceRequest): Promise<ProviderResult<ExternalTransaction>>;

  createPayment?(ctx: ProviderContext, req: PaymentRequest): Promise<ProviderResult<ExternalTransaction>>;
  createRefund?(ctx: ProviderContext, req: RefundRequest): Promise<ProviderResult<ExternalTransaction>>;
  createJournalEntry?(ctx: ProviderContext, req: JournalEntryRequest): Promise<ProviderResult<ExternalTransaction>>;

  getInvoice?(ctx: ProviderContext, externalId: string): Promise<ProviderResult<ExternalTransaction>>;
  getPayment?(ctx: ProviderContext, externalId: string): Promise<ProviderResult<ExternalTransaction>>;

  /**
   * The recovery path for an unknown result: look for a document carrying
   * our reference before considering a retry (§52, §68).
   */
  searchTransactions?(ctx: ProviderContext, query: TransactionQuery): Promise<ProviderResult<TransactionPage>>;
  findByReference?(ctx: ProviderContext, reference: string): Promise<ProviderResult<ExternalTransaction | null>>;

  getFinancialPeriodStatus?(ctx: ProviderContext, date: string): Promise<ProviderResult<FinancialPeriod>>;

  healthCheck(ctx: ProviderContext): Promise<ProviderResult<{ healthy: boolean; detail?: string }>>;
}
