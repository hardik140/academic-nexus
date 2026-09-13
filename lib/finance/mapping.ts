import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * Mapping resolution and pre-flight validation (§48, §49, §62, §63).
 *
 * Academic Nexus and an accounting system do not share a vocabulary. Here a
 * fee head is the free-text `fees.type` ("Tuition Fee") and a payment mode
 * is one of `payments.method`'s eight CHECK values; there, both are ledgers
 * with codes and names somebody in the accounts department chose. Nothing
 * in this file guesses the correspondence — every one of them is a row an
 * operator configured, per college and per connection.
 *
 * THE RULE THAT MATTERS
 *
 * A transaction whose mapping is incomplete is BLOCKED, never posted to a
 * default or "misc income" ledger. Posting to an arbitrary account produces
 * books that balance and are wrong, which is harder to find later than a
 * transaction that visibly did not post.
 */

export type MappingKind =
  | "fee_head"
  | "payment_method"
  | "bank_account"
  | "tax_code"
  | "customer"
  | "cost_center"
  | "department"
  | "branch";

export interface AccountMapping {
  id: string;
  kind: MappingKind;
  local_key: string;
  local_label: string | null;
  external_id: string | null;
  external_code: string | null;
  external_name: string;
  tax_rate: number | null;
  tax_treatment: string | null;
  status: "active" | "inactive";
}

export interface MappingGap {
  kind: MappingKind;
  localKey: string;
  localLabel?: string;
  /** How many live records currently depend on this missing mapping. */
  affectedRecords: number;
}

export interface MappingValidation {
  ready: boolean;
  gaps: MappingGap[];
}

export class MappingMissingError extends Error {
  readonly code = "MAPPING_MISSING";
  constructor(readonly gap: { kind: MappingKind; localKey: string }) {
    super(
      `No ${gap.kind.replace(/_/g, " ")} mapping for "${gap.localKey}". ` +
        `Configure it before this transaction can be posted.`
    );
    this.name = "MappingMissingError";
  }
}

export async function loadMappings(
  supabase: SupabaseClient<Database>,
  connectionId: string
): Promise<AccountMapping[]> {
  const { data, error } = await supabase
    .from("finance_account_mappings")
    .select("id, kind, local_key, local_label, external_id, external_code, external_name, tax_rate, tax_treatment, status")
    .eq("connection_id", connectionId)
    .eq("status", "active");
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as AccountMapping[];
}

/** Index by kind+key for O(1) resolution inside the pipeline. */
export function indexMappings(rows: AccountMapping[]): Map<string, AccountMapping> {
  return new Map(rows.map((r) => [`${r.kind}:${r.local_key}`, r]));
}

/**
 * Resolves one mapping or throws. Deliberately throwing rather than
 * returning null: every call site would otherwise need its own "and what if
 * it is missing" branch, and one of them would eventually pick a default.
 */
export function requireMapping(
  index: Map<string, AccountMapping>,
  kind: MappingKind,
  localKey: string
): AccountMapping {
  const found = index.get(`${kind}:${localKey}`);
  if (!found) throw new MappingMissingError({ kind, localKey });
  return found;
}

export function findMapping(
  index: Map<string, AccountMapping>,
  kind: MappingKind,
  localKey: string
): AccountMapping | undefined {
  return index.get(`${kind}:${localKey}`);
}

/**
 * Pre-flight: can this connection post at all?
 *
 * Answers with the ACTUAL gaps — every distinct `fees.type` and every
 * `payments.method` that live records use and no mapping covers, with a
 * count of how many records each blocks. "Configuration error" with no list
 * is not something an operator can act on (§49).
 *
 * Only live data is considered: a fee head nobody has used in this college
 * is not a gap, and demanding a mapping for it would make activation
 * impossible for no benefit.
 */
export async function validateMappings(
  supabase: SupabaseClient<Database>,
  collegeId: string,
  connectionId: string
): Promise<MappingValidation> {
  const index = indexMappings(await loadMappings(supabase, connectionId));
  const gaps: MappingGap[] = [];

  const { data: feeRows } = await supabase
    .from("fees")
    .select("type")
    .eq("college_id", collegeId);
  const feeCounts = new Map<string, number>();
  for (const row of feeRows ?? []) {
    const key = (row as { type: string }).type;
    feeCounts.set(key, (feeCounts.get(key) ?? 0) + 1);
  }
  for (const [type, count] of feeCounts) {
    if (!index.has(`fee_head:${type}`)) {
      gaps.push({ kind: "fee_head", localKey: type, affectedRecords: count });
    }
  }

  const { data: paymentRows } = await supabase
    .from("payments")
    .select("method")
    .eq("college_id", collegeId);
  const methodCounts = new Map<string, number>();
  for (const row of paymentRows ?? []) {
    const key = (row as { method: string }).method;
    methodCounts.set(key, (methodCounts.get(key) ?? 0) + 1);
  }
  for (const [method, count] of methodCounts) {
    // A payment mode needs BOTH a mode name the provider understands and a
    // bank/cash ledger to land in (§62 and §63 are two different mappings,
    // and a system that conflates them posts UPI receipts into cash).
    if (!index.has(`payment_method:${method}`)) {
      gaps.push({ kind: "payment_method", localKey: method, affectedRecords: count });
    }
    if (!index.has(`bank_account:${method}`)) {
      gaps.push({ kind: "bank_account", localKey: method, affectedRecords: count });
    }
  }

  gaps.sort((a, b) => b.affectedRecords - a.affectedRecords || a.localKey.localeCompare(b.localKey));
  return { ready: gaps.length === 0, gaps };
}

/**
 * Tax treatment for a fee head.
 *
 * FINDING, stated here because this is where someone will look for it:
 * Academic Nexus stores no tax component anywhere. `fees` has amount and
 * nothing else; `payments` has amount and nothing else. There is no taxable
 * base, no tax amount, no HSN/SAC, no place a GST split could be recorded
 * even if one were computed.
 *
 * So this returns the treatment an operator DECLARED for the fee head, and
 * the pipeline sends the gross amount with that treatment attached. It does
 * not invent a split. A college that needs genuine GST accounting on fee
 * income needs a tax model in the fee schema first — a schema change and a
 * business decision, recorded in the register, not something to synthesise
 * inside an integration layer.
 */
export function taxFor(mapping: AccountMapping): { taxExternalId?: string; taxTreatment?: string } {
  if (!mapping.tax_treatment) return {};
  return {
    taxExternalId: mapping.external_id ?? undefined,
    taxTreatment: mapping.tax_treatment,
  };
}
