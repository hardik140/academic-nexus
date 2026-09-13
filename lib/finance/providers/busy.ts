import {
  type AccountingProviderAdapter,
  type CapabilityMap,
  type ProviderContext,
  type ProviderResult,
  type ExternalOrganization,
  fail,
  ok,
} from "./types";

/**
 * BUSY adapter.
 *
 * WHAT THIS DELIBERATELY IS NOT
 *
 * It is not a REST client. BUSY does not publish a general-purpose public
 * accounting API the way Zoho Books does; third-party integration is
 * arranged through BUSY's own integration/customisation route or a channel
 * partner, and what is available differs per deployment. Writing a plausible
 * `POST /api/v1/receipts` here would produce an adapter that compiles, tests
 * green against a mock, and fails the first time a college points it at
 * their actual installation — after the dashboard has told them they are
 * connected.
 *
 * SO THE ADAPTER IS HONEST INSTEAD
 *
 * It implements the full interface, and reports REQUIRES_CONFIGURATION for
 * everything until a deployment supplies a concrete endpoint contract. A
 * connection created for BUSY can be stored, mapped and inspected; it cannot
 * reach ACTIVE, so the pipeline will never post through it. §84's rule, in
 * code: no fake_busy_api(), and no BUSY transaction is ever marked SYNCED
 * without a real external acknowledgement.
 *
 * WHAT COMPLETING THIS TAKES — written here so it is a task, not a mystery:
 *
 *   1. the deployment's integration mechanism and its base URL / connection
 *      string, from the customer's BUSY partner;
 *   2. the authentication it uses (BUSY has no OAuth: expect a key, or
 *      network-local trust);
 *   3. the document shapes for a receipt and a payment voucher, with the
 *      identifier each returns — an id is mandatory, since without one no
 *      posting may be recorded SYNCED;
 *   4. an idempotency anchor: either a field BUSY de-duplicates on, or a
 *      lookup by our reference that can be run before every create.
 *
 * Points 3 and 4 are not optional. An integration that cannot return an
 * identifier and cannot be searched by reference cannot be made safe against
 * retries, and should not be enabled at all.
 */

const NOT_CONFIGURED_MESSAGE =
  "BUSY integration is not configured for this deployment. BUSY does not expose a general public " +
  "accounting API; a concrete integration contract (endpoint, authentication, document shapes and an " +
  "identifier) must be supplied by the BUSY partner before this connection can post transactions.";

function notConfigured(): ProviderResult<never> {
  return fail("capability", "BUSY_REQUIRES_CONFIGURATION", NOT_CONFIGURED_MESSAGE, "exhausted");
}

export const busyAdapter: AccountingProviderAdapter = {
  id: "busy",
  displayName: "BUSY",

  async testConnection() {
    return notConfigured();
  },

  async getCapabilities(): Promise<ProviderResult<CapabilityMap>> {
    // Every capability is stated, and every one of them says the same true
    // thing. A capability map with omissions would read as "unknown"; this
    // reads as "known, and not available yet".
    const map: CapabilityMap = {
      testConnection: "REQUIRES_CONFIGURATION",
      getOrganizations: "REQUIRES_CONFIGURATION",
      getAccounts: "REQUIRES_CONFIGURATION",
      getTaxRates: "REQUIRES_CONFIGURATION",
      getContacts: "REQUIRES_CONFIGURATION",
      createCustomer: "REQUIRES_CONFIGURATION",
      updateCustomer: "REQUIRES_CONFIGURATION",
      createInvoice: "REQUIRES_CONFIGURATION",
      updateInvoice: "REQUIRES_CONFIGURATION",
      createPayment: "REQUIRES_CONFIGURATION",
      createRefund: "REQUIRES_CONFIGURATION",
      createJournalEntry: "REQUIRES_CONFIGURATION",
      getInvoice: "REQUIRES_CONFIGURATION",
      getPayment: "REQUIRES_CONFIGURATION",
      searchTransactions: "REQUIRES_CONFIGURATION",
      getFinancialPeriodStatus: "REQUIRES_CONFIGURATION",
      webhooks: "UNSUPPORTED",
    };
    return ok(map);
  },

  async getOrganizations(): Promise<ProviderResult<ExternalOrganization[]>> {
    return notConfigured();
  },

  async healthCheck(_ctx: ProviderContext) {
    return ok({ healthy: false, detail: NOT_CONFIGURED_MESSAGE });
  },
};

export const __testing = { NOT_CONFIGURED_MESSAGE };
