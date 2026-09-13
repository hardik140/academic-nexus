import type { AccountingProviderAdapter, CapabilityName, ProviderId } from "./types";
import { zohoBooksAdapter } from "./zoho";
import { tallyPrimeAdapter } from "./tally";
import { busyAdapter } from "./busy";

/**
 * The provider registry — the only place a provider id becomes an adapter.
 *
 * Everything above this line is provider-neutral. If a fourth accounting
 * system is added, it is added here and nowhere else; a `switch (provider)`
 * anywhere in the pipeline or the UI would be the start of the "three
 * unrelated API integrations" shape §102 exists to prevent.
 */

const ADAPTERS: Record<ProviderId, AccountingProviderAdapter> = {
  zoho_books: zohoBooksAdapter,
  tallyprime: tallyPrimeAdapter,
  busy: busyAdapter,
};

export function adapterFor(provider: ProviderId): AccountingProviderAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`No adapter registered for provider "${provider}".`);
  return adapter;
}

export const PROVIDERS: ReadonlyArray<{ id: ProviderId; displayName: string }> = (
  Object.keys(ADAPTERS) as ProviderId[]
).map((id) => ({ id, displayName: ADAPTERS[id].displayName }));

/**
 * Whether the adapter implements a capability AT ALL.
 *
 * Separate from the capability MAP on purpose, and both are checked before
 * dispatch: this answers "is there code", the map answers "does it work on
 * this connection". A method that exists but is REQUIRES_CONFIGURATION must
 * not be called, and a capability marked SUPPORTED with no method behind it
 * is a bug this catches at the boundary rather than at the provider.
 */
export function implementsCapability(provider: ProviderId, capability: CapabilityName): boolean {
  const adapter = adapterFor(provider) as unknown as Record<string, unknown>;
  const METHOD: Partial<Record<CapabilityName, string>> = {
    testConnection: "testConnection",
    getOrganizations: "getOrganizations",
    getAccounts: "getAccounts",
    getTaxRates: "getTaxRates",
    getContacts: "getContacts",
    createCustomer: "createCustomer",
    updateCustomer: "updateCustomer",
    createInvoice: "createInvoice",
    updateInvoice: "updateInvoice",
    createPayment: "createPayment",
    createRefund: "createRefund",
    createJournalEntry: "createJournalEntry",
    getInvoice: "getInvoice",
    getPayment: "getPayment",
    searchTransactions: "searchTransactions",
    getFinancialPeriodStatus: "getFinancialPeriodStatus",
  };
  const method = METHOD[capability];
  return !!method && typeof adapter[method] === "function";
}
