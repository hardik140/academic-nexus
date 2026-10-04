import {
  type AccountingProviderAdapter,
  type CapabilityMap,
  type ExternalAccount,
  type ExternalContact,
  type ExternalOrganization,
  type ExternalTaxRate,
  type ExternalTransaction,
  type FinancialPeriod,
  type InvoiceRequest,
  type PaymentRequest,
  type ProviderContext,
  type ProviderResult,
  type RefundRequest,
  type CustomerRequest,
  type TransactionPage,
  type TransactionQuery,
  fail,
  ok,
  unsupported,
} from "./types";
import { bodyHash } from "../crypto";

/**
 * Zoho Books adapter — REST over HTTPS, OAuth 2.0 refresh-token grant.
 *
 * Zoho is the one provider of the three whose integration model is a
 * documented public REST API, so this adapter is a real client: it refreshes
 * its own access token, scopes every call to an organization_id, and reads
 * Zoho's `code` field rather than trusting the HTTP status.
 *
 * THE `code` FIELD IS THE RESULT, NOT THE STATUS. Zoho answers many refusals
 * with HTTP 200 and a non-zero `code` in the body. An adapter that mapped
 * 200 to success would mark a rejected invoice SYNCED — precisely the
 * failure §40 forbids — so every response is parsed before it is judged.
 *
 * DATA CENTRE. Zoho is regional (.com, .in, .eu, .com.au, ...) and a token
 * issued in one region is rejected in another. The region comes from the
 * stored credential, never guessed, and a mismatch surfaces as an auth
 * failure the operator can read.
 *
 * TIMEOUTS ARE UNKNOWN RESULTS. An aborted request may already have created
 * a document, so it is reported `unknown_result` (unsafe), which routes the
 * operation to reconciliation instead of a retry. Only a connection that
 * never opened is `network` (safe).
 */

const DEFAULT_DC = "com";
const TIMEOUT_MS = 20_000;

function apiBase(ctx: ProviderContext): string {
  if (ctx.baseUrl) return ctx.baseUrl.replace(/\/+$/, "");
  const dc = (ctx.credential.kind === "oauth2" && ctx.credential.dataCenter) || DEFAULT_DC;
  return `https://www.zohoapis.${dc}/books/v3`;
}

function accountsBase(ctx: ProviderContext): string {
  const dc = (ctx.credential.kind === "oauth2" && ctx.credential.dataCenter) || DEFAULT_DC;
  return `https://accounts.zoho.${dc}`;
}

interface ZohoEnvelope {
  code?: number;
  message?: string;
  [key: string]: unknown;
}

/** Zoho's own error codes, mapped to the kinds the pipeline reasons about. */
function classify(status: number, body: ZohoEnvelope): { kind: Parameters<typeof fail>[0]; code: string } {
  const code = String(body.code ?? status);
  if (status === 401 || body.code === 57) return { kind: "auth", code };
  if (status === 403) return { kind: "forbidden", code };
  if (status === 429 || body.code === 1049) return { kind: "rate_limited", code };
  if (status === 404 || body.code === 1002) return { kind: "not_found", code };
  if (status >= 500) return { kind: "provider_error", code };
  // Zoho reports a closed books period as a validation refusal; the message
  // is what distinguishes it, and getting this wrong would retry forever.
  if (/clos(ed|ing)\s+(the\s+)?books|books.*locked|transaction.*locked/i.test(String(body.message ?? ""))) {
    return { kind: "period_closed", code };
  }
  return { kind: "validation", code };
}

/**
 * Errors that mean the request never left this machine: the name did not
 * resolve, or nothing accepted the connection. Node's fetch puts the system
 * code on `cause`; anything without one of these codes (including the
 * Workers runtime's "Network connection lost") is treated as possibly sent.
 */
const NEVER_CONNECTED = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
function neverConnected(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return NEVER_CONNECTED.has(e?.cause?.code ?? e?.code ?? "");
}

async function call<T>(
  ctx: ProviderContext,
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {}
): Promise<ProviderResult<T>> {
  if (ctx.credential.kind !== "oauth2") {
    return fail("auth", "NO_OAUTH_CREDENTIAL", "This Zoho connection has no OAuth credential.", "exhausted");
  }

  const token = await accessToken(ctx);
  if (!token.ok) return token as ProviderResult<T>;

  const url = new URL(`${apiBase(ctx)}${path}`);
  if (ctx.organizationId) url.searchParams.set("organization_id", ctx.organizationId);
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

  const doFetch = ctx.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let sent = false;

  try {
    const response = await doFetch(url.toString(), {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Zoho-oauthtoken ${token.data}`,
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    sent = true;

    const text = await response.text();
    let parsed: ZohoEnvelope;
    try {
      parsed = text ? (JSON.parse(text) as ZohoEnvelope) : {};
    } catch {
      // A body we cannot parse after a request that definitely landed: we do
      // not know what the server did with it.
      return fail("unknown_result", "UNPARSEABLE_RESPONSE", "Zoho returned a response that could not be parsed.", "unsafe", {
        responseHash: bodyHash(text),
      });
    }

    const hash = bodyHash(text);
    if (!response.ok || (parsed.code !== undefined && parsed.code !== 0)) {
      const { kind, code } = classify(response.status, parsed);
      const retryAfter = Number(response.headers.get("Retry-After") ?? "") || undefined;
      return fail(kind, code, parsed.message ?? `Zoho request failed (HTTP ${response.status}).`,
        kind === "rate_limited" || kind === "provider_error" ? "safe" : kind === "unknown_result" ? "unsafe" : "exhausted",
        { responseHash: hash, retryAfterSeconds: retryAfter });
    }

    return ok(parsed as unknown as T, { responseHash: hash });
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    if (aborted || sent) {
      return fail("unknown_result", "TIMEOUT",
        "Zoho did not respond in time. The request may or may not have been applied.", "unsafe");
    }
    // fetch() rejecting is NOT proof the request never arrived. A connection
    // reset after the body was written — Zoho created the payment, the
    // response was lost — rejects exactly like a refused connection. The old
    // code called every rejection "network" (safe to retry), so a lost
    // response on a POST could be retried into a second receipt. Only an
    // error that proves no connection was ever made is safe for a POST;
    // anything else is an unknown result and goes to reconciliation. A GET
    // creates nothing, so it may stay "network".
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && !neverConnected(err)) {
      return fail("unknown_result", "CONNECTION_LOST",
        "The connection to Zoho failed while the request was in flight. It may or may not have been applied.", "unsafe");
    }
    return fail("network", "NETWORK", (err as Error)?.message ?? "Could not reach Zoho Books.", "safe");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exchanges the refresh token for an access token.
 *
 * The access token is deliberately NOT cached across processes here: caching
 * it would mean writing it back to the credentials table on a hot path, and
 * the refresh call is cheap next to the cost of a stale token producing a
 * spurious auth failure mid-posting. A worker that batches many calls can
 * pass `accessToken` in the context to reuse one within a run.
 */
async function accessToken(ctx: ProviderContext): Promise<ProviderResult<string>> {
  if (ctx.credential.kind !== "oauth2") {
    return fail("auth", "NO_OAUTH_CREDENTIAL", "No OAuth credential on this connection.", "exhausted");
  }
  const cred = ctx.credential;
  if (cred.accessToken && cred.accessTokenExpiresAt && new Date(cred.accessTokenExpiresAt) > new Date(Date.now() + 60_000)) {
    return ok(cred.accessToken);
  }

  const doFetch = ctx.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    refresh_token: cred.refreshToken,
    client_id: cred.clientId,
    client_secret: cred.clientSecret,
    grant_type: "refresh_token",
  });

  try {
    const res = await doFetch(`${accountsBase(ctx)}/oauth/v2/token?${params.toString()}`, { method: "POST" });
    const text = await res.text();
    const body = text ? (JSON.parse(text) as { access_token?: string; error?: string }) : {};
    if (!res.ok || !body.access_token) {
      // An invalid or revoked refresh token is terminal until a person
      // re-authorises — retrying cannot fix it.
      return fail("auth", body.error ?? `HTTP_${res.status}`,
        body.error === "invalid_code" || body.error === "invalid_client"
          ? "Zoho rejected the stored credential. Re-authorise this connection."
          : `Could not refresh the Zoho access token (${body.error ?? res.status}).`,
        "exhausted");
    }
    return ok(body.access_token);
  } catch (err) {
    return fail("network", "NETWORK", (err as Error)?.message ?? "Could not reach Zoho accounts.", "safe");
  }
}

export const zohoBooksAdapter: AccountingProviderAdapter = {
  id: "zoho_books",
  displayName: "Zoho Books",

  async testConnection(ctx) {
    const res = await call<{ organizations?: unknown[] }>(ctx, "/organizations");
    if (!res.ok) return res;
    return ok({ reachable: true as const }, { responseHash: res.responseHash });
  },

  async getCapabilities(ctx) {
    // Discovered, not declared: the organisation call proves the credential
    // and the region; everything else is marked CONFIGURED (the mechanism
    // exists and this connection is set up for it) and only becomes
    // SUPPORTED once it has actually been exercised against the live org.
    const probe = await call<{ organizations?: unknown[] }>(ctx, "/organizations");
    if (!probe.ok) {
      const blocked: CapabilityMap = { testConnection: "BLOCKED" };
      return ok(blocked, { responseHash: probe.responseHash });
    }
    const map: CapabilityMap = {
      testConnection: "SUPPORTED",
      getOrganizations: "SUPPORTED",
      getAccounts: "CONFIGURED",
      getTaxRates: "CONFIGURED",
      getContacts: "CONFIGURED",
      createCustomer: "CONFIGURED",
      updateCustomer: "CONFIGURED",
      createInvoice: "CONFIGURED",
      updateInvoice: "CONFIGURED",
      createPayment: "CONFIGURED",
      createRefund: "CONFIGURED",
      createJournalEntry: "CONFIGURED",
      getInvoice: "CONFIGURED",
      getPayment: "CONFIGURED",
      searchTransactions: "CONFIGURED",
      // Zoho Books does expose a books-closing date, but reading it needs a
      // settings scope this connection may not hold — so it is not claimed.
      getFinancialPeriodStatus: "REQUIRES_CONFIGURATION",
      webhooks: "REQUIRES_CONFIGURATION",
    };
    return ok(map, { responseHash: probe.responseHash });
  },

  async getOrganizations(ctx) {
    const res = await call<{ organizations: Array<Record<string, unknown>> }>(ctx, "/organizations");
    if (!res.ok) return res;
    const orgs: ExternalOrganization[] = (res.data.organizations ?? []).map((o) => ({
      id: String(o.organization_id),
      name: String(o.name ?? ""),
      currency: o.currency_code ? String(o.currency_code) : undefined,
    }));
    return ok(orgs, { responseHash: res.responseHash });
  },

  async getAccounts(ctx) {
    const res = await call<{ chartofaccounts: Array<Record<string, unknown>> }>(ctx, "/chartofaccounts");
    if (!res.ok) return res;
    const accounts: ExternalAccount[] = (res.data.chartofaccounts ?? []).map((a) => ({
      id: String(a.account_id),
      code: a.account_code ? String(a.account_code) : undefined,
      name: String(a.account_name ?? ""),
      type: a.account_type ? String(a.account_type) : undefined,
    }));
    return ok(accounts, { responseHash: res.responseHash });
  },

  async getTaxRates(ctx) {
    const res = await call<{ taxes: Array<Record<string, unknown>> }>(ctx, "/settings/taxes");
    if (!res.ok) return res;
    const taxes: ExternalTaxRate[] = (res.data.taxes ?? []).map((t) => ({
      id: String(t.tax_id),
      name: String(t.tax_name ?? ""),
      percentage: Number(t.tax_percentage ?? 0),
    }));
    return ok(taxes, { responseHash: res.responseHash });
  },

  async getContacts(ctx) {
    const res = await call<{ contacts: Array<Record<string, unknown>> }>(ctx, "/contacts");
    if (!res.ok) return res;
    const contacts: ExternalContact[] = (res.data.contacts ?? []).map((c) => ({
      id: String(c.contact_id),
      name: String(c.contact_name ?? ""),
      email: c.email ? String(c.email) : undefined,
      reference: c.reference_number ? String(c.reference_number) : undefined,
    }));
    return ok(contacts, { responseHash: res.responseHash });
  },

  async createCustomer(ctx, req: CustomerRequest) {
    const res = await call<{ contact: Record<string, unknown> }>(ctx, "/contacts", {
      method: "POST",
      body: {
        contact_name: req.name,
        company_name: req.name,
        // The Academic Nexus student id travels with the contact so a later
        // reconciliation can match without name-guessing.
        reference_number: req.reference,
        ...(req.email ? { email: req.email } : {}),
        custom_fields: req.enrollmentNumber ? [{ label: "Enrollment Number", value: req.enrollmentNumber }] : undefined,
      },
    });
    if (!res.ok) return res;
    const id = String(res.data.contact?.contact_id ?? "");
    if (!id) {
      return fail("unknown_result", "NO_EXTERNAL_ID", "Zoho accepted the contact but returned no id.", "unsafe", {
        responseHash: res.responseHash,
      });
    }
    return ok(
      { id, name: String(res.data.contact.contact_name ?? req.name), reference: req.reference },
      { externalId: id, responseHash: res.responseHash }
    );
  },

  async updateCustomer(ctx, externalId, req) {
    const res = await call<{ contact: Record<string, unknown> }>(ctx, `/contacts/${externalId}`, {
      method: "PUT",
      body: { contact_name: req.name, ...(req.email ? { email: req.email } : {}) },
    });
    if (!res.ok) return res;
    return ok({ id: externalId, name: req.name, reference: req.reference }, { externalId, responseHash: res.responseHash });
  },

  async createInvoice(ctx, req: InvoiceRequest) {
    const res = await call<{ invoice: Record<string, unknown> }>(ctx, "/invoices", {
      method: "POST",
      body: {
        customer_id: req.customerExternalId,
        reference_number: req.reference,
        date: req.date,
        due_date: req.dueDate,
        line_items: req.lines.map((l) => ({
          name: l.description,
          description: l.description,
          rate: l.amount,
          quantity: 1,
          account_id: l.accountExternalId,
          ...(l.taxExternalId ? { tax_id: l.taxExternalId } : {}),
        })),
        notes: req.notes,
      },
    });
    if (!res.ok) return res;
    const id = String(res.data.invoice?.invoice_id ?? "");
    if (!id) {
      return fail("unknown_result", "NO_EXTERNAL_ID", "Zoho accepted the invoice but returned no id.", "unsafe", {
        responseHash: res.responseHash,
      });
    }
    return ok(
      {
        id,
        number: String(res.data.invoice.invoice_number ?? ""),
        type: "invoice",
        date: req.date,
        amount: Number(res.data.invoice.total ?? req.total),
        reference: req.reference,
      },
      { externalId: id, externalNumber: String(res.data.invoice.invoice_number ?? ""), responseHash: res.responseHash }
    );
  },

  async createPayment(ctx, req: PaymentRequest) {
    const res = await call<{ payment: Record<string, unknown> }>(ctx, "/customerpayments", {
      method: "POST",
      body: {
        customer_id: req.customerExternalId,
        payment_mode: req.paymentMode,
        amount: req.amount,
        date: req.date,
        // Academic Nexus's own receipt number travels as the reference and
        // never as Zoho's own numbering (§58).
        reference_number: req.receiptNumber ?? req.reference,
        description: req.notes,
        account_id: req.depositAccountExternalId,
        ...(req.invoiceExternalId
          ? { invoices: [{ invoice_id: req.invoiceExternalId, amount_applied: req.amount }] }
          : {}),
      },
    });
    if (!res.ok) return res;
    const id = String(res.data.payment?.payment_id ?? "");
    if (!id) {
      return fail("unknown_result", "NO_EXTERNAL_ID", "Zoho accepted the payment but returned no id.", "unsafe", {
        responseHash: res.responseHash,
      });
    }
    return ok(
      {
        id,
        number: String(res.data.payment.payment_number ?? ""),
        type: "payment",
        date: req.date,
        amount: req.amount,
        reference: req.reference,
      },
      { externalId: id, externalNumber: String(res.data.payment.payment_number ?? ""), responseHash: res.responseHash }
    );
  },

  async createRefund(ctx, req: RefundRequest) {
    const res = await call<{ creditnote: Record<string, unknown> }>(ctx, "/creditnotes", {
      method: "POST",
      body: {
        customer_id: req.customerExternalId,
        reference_number: req.reference,
        date: req.date,
        line_items: [{ name: req.reason ?? "Refund", rate: req.amount, quantity: 1 }],
      },
    });
    if (!res.ok) return res;
    const id = String(res.data.creditnote?.creditnote_id ?? "");
    if (!id) {
      return fail("unknown_result", "NO_EXTERNAL_ID", "Zoho accepted the credit note but returned no id.", "unsafe", {
        responseHash: res.responseHash,
      });
    }
    return ok(
      { id, type: "credit_note", date: req.date, amount: req.amount, reference: req.reference },
      { externalId: id, responseHash: res.responseHash }
    );
  },

  async getPayment(ctx, externalId) {
    const res = await call<{ payment: Record<string, unknown> }>(ctx, `/customerpayments/${externalId}`);
    if (!res.ok) return res;
    const p = res.data.payment ?? {};
    return ok(
      {
        id: externalId,
        number: p.payment_number ? String(p.payment_number) : undefined,
        type: "payment",
        date: String(p.date ?? ""),
        amount: Number(p.amount ?? 0),
        reference: p.reference_number ? String(p.reference_number) : undefined,
      },
      { externalId, responseHash: res.responseHash }
    );
  },

  async getInvoice(ctx, externalId) {
    const res = await call<{ invoice: Record<string, unknown> }>(ctx, `/invoices/${externalId}`);
    if (!res.ok) return res;
    const i = res.data.invoice ?? {};
    return ok(
      {
        id: externalId,
        number: i.invoice_number ? String(i.invoice_number) : undefined,
        type: "invoice",
        date: String(i.date ?? ""),
        amount: Number(i.total ?? 0),
        reference: i.reference_number ? String(i.reference_number) : undefined,
        status: i.status ? String(i.status) : undefined,
      },
      { externalId, responseHash: res.responseHash }
    );
  },

  async searchTransactions(ctx, query: TransactionQuery) {
    const res = await call<{ customerpayments: Array<Record<string, unknown>>; page_context?: Record<string, unknown> }>(
      ctx,
      "/customerpayments",
      { query: { date_start: query.from, date_end: query.to, page: query.cursor } }
    );
    if (!res.ok) return res;
    const page: TransactionPage = {
      transactions: (res.data.customerpayments ?? []).map((p) => ({
        id: String(p.payment_id),
        number: p.payment_number ? String(p.payment_number) : undefined,
        type: "payment",
        date: String(p.date ?? ""),
        amount: Number(p.amount ?? 0),
        reference: p.reference_number ? String(p.reference_number) : undefined,
      })),
      nextCursor: res.data.page_context?.has_more_page
        ? String(Number(query.cursor ?? "1") + 1)
        : undefined,
    };
    return ok(page, { responseHash: res.responseHash });
  },

  /**
   * The recovery lookup for an unknown result. Searches by OUR reference,
   * which is why every create above carries it.
   */
  async findByReference(ctx, reference) {
    const res = await call<{ customerpayments: Array<Record<string, unknown>> }>(ctx, "/customerpayments", {
      query: { reference_number: reference },
    });
    if (!res.ok) return res;
    const hit = (res.data.customerpayments ?? [])[0];
    if (!hit) return ok(null, { responseHash: res.responseHash });
    return ok(
      {
        id: String(hit.payment_id),
        number: hit.payment_number ? String(hit.payment_number) : undefined,
        type: "payment",
        date: String(hit.date ?? ""),
        amount: Number(hit.amount ?? 0),
        reference,
      },
      { externalId: String(hit.payment_id), responseHash: res.responseHash }
    );
  },

  async getFinancialPeriodStatus(_ctx, _date): Promise<ProviderResult<FinancialPeriod>> {
    // Not claimed. Reading Zoho's books-closing date needs a settings scope
    // this connection is not guaranteed to hold, and guessing "open" would
    // let a posting into a closed period look like a success.
    return unsupported(
      "getFinancialPeriodStatus",
      "Zoho Books period status requires a settings scope this connection has not been granted."
    );
  },

  async healthCheck(ctx) {
    const res = await call<{ organizations?: unknown[] }>(ctx, "/organizations");
    if (!res.ok) return ok({ healthy: false, detail: res.message });
    return ok({ healthy: true });
  },
};

export const __testing = { classify, apiBase, accountsBase };
