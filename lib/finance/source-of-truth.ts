/**
 * The source-of-truth matrix (§39) and field ownership (§56), as code.
 *
 * WHY THIS IS A MODULE AND NOT A DOCUMENT
 *
 * "Which system owns this value" is the question that decides whether an
 * inbound change may overwrite a local record. Written in a README it
 * becomes a thing people remember differently; written here, the inbound
 * path calls `mayExternalOverwrite()` and cannot forget.
 *
 * The matrix is NOT "the accounting system is authoritative" wholesale. In
 * this product the fee demand, the payment and the receipt number are
 * Academic Nexus's own records — they exist whether or not an accounting
 * integration is ever configured. What the accounting system owns is its own
 * documents, its identifiers, and everything downstream of its ledger.
 */

export type SystemOfRecord = "academic_nexus" | "accounting" | "reconciled" | "not_applicable";

export interface FinancialObjectAuthority {
  object: string;
  academicNexus: SystemOfRecord;
  accounting: SystemOfRecord;
  /** Which direction this object is allowed to move (§54). */
  direction: "outbound" | "inbound" | "bidirectional" | "none";
  note: string;
}

export const SOURCE_OF_TRUTH: readonly FinancialObjectAuthority[] = [
  {
    object: "student_fee_demand",
    academicNexus: "academic_nexus",
    accounting: "not_applicable",
    direction: "outbound",
    note: "fees rows are raised by finance/invoices here; the accounting system holds a mirror invoice at most.",
  },
  {
    object: "student_fee_invoice",
    academicNexus: "academic_nexus",
    accounting: "reconciled",
    direction: "outbound",
    note: "Amount and due date are ours; the external invoice number is theirs.",
  },
  {
    object: "payment_received",
    academicNexus: "academic_nexus",
    accounting: "reconciled",
    direction: "outbound",
    note: "A payment exists in Academic Nexus the moment finance records it (047 §7i credits the fee). The accounting receipt is a consequence, not the origin.",
  },
  {
    object: "receipt_number",
    academicNexus: "academic_nexus",
    accounting: "not_applicable",
    direction: "outbound",
    note: "§58: the external voucher number is stored alongside, never over, payments.receipt_number.",
  },
  {
    object: "refund_request",
    academicNexus: "academic_nexus",
    accounting: "not_applicable",
    direction: "outbound",
    note: "A student raises it here; the accounting system never originates a refund request.",
  },
  {
    object: "refund_completion",
    academicNexus: "academic_nexus",
    accounting: "reconciled",
    direction: "outbound",
    note: "approve_refund() (047 §7o) is the authoritative event; the credit note mirrors it.",
  },
  {
    object: "chart_of_accounts",
    academicNexus: "not_applicable",
    accounting: "accounting",
    direction: "inbound",
    note: "Academic Nexus holds a mapped reference only; it never creates ledgers.",
  },
  {
    object: "tax_rates",
    academicNexus: "not_applicable",
    accounting: "accounting",
    direction: "inbound",
    note: "Academic Nexus stores no tax component on fees or payments — see the tax finding.",
  },
  {
    object: "ledger",
    academicNexus: "not_applicable",
    accounting: "accounting",
    direction: "inbound",
    note: "Derived entirely in the accounting system.",
  },
  {
    object: "trial_balance",
    academicNexus: "not_applicable",
    accounting: "accounting",
    direction: "inbound",
    note: "Read-only mirror if surfaced at all.",
  },
  {
    object: "bank_reconciliation",
    academicNexus: "not_applicable",
    accounting: "accounting",
    direction: "inbound",
    note: "Academic Nexus is never authoritative for bank statements.",
  },
  {
    object: "outstanding_fees",
    academicNexus: "academic_nexus",
    accounting: "reconciled",
    direction: "outbound",
    note: "fees.paid_amount is maintained by the ledger trigger; the accounting balance is compared, not copied in.",
  },
  {
    object: "payment_status",
    academicNexus: "academic_nexus",
    accounting: "reconciled",
    direction: "outbound",
    note: "payments.status is ours; an external reversal raises a reconciliation finding rather than rewriting it.",
  },
  {
    object: "expense",
    academicNexus: "not_applicable",
    accounting: "accounting",
    direction: "none",
    note: "Academic Nexus has no expense module. Nothing to synchronise; listed so the gap is explicit.",
  },
] as const;

/**
 * Field-level ownership for the objects that exist on both sides (§56).
 * Anything not listed is Academic Nexus's by default — an accounting system
 * cannot introduce a field we do not model.
 */
export const FIELD_OWNERSHIP: Readonly<Record<string, SystemOfRecord>> = {
  "payment.amount": "academic_nexus",
  "payment.status": "academic_nexus",
  "payment.method": "academic_nexus",
  "payment.transaction_ref": "academic_nexus",
  "payment.receipt_number": "academic_nexus",
  "payment.external_id": "accounting",
  "payment.external_voucher_number": "accounting",
  "fee.amount": "academic_nexus",
  "fee.due_date": "academic_nexus",
  "fee.paid_amount": "academic_nexus",
  "fee.external_id": "accounting",
  "student.name": "academic_nexus",
  "student.enrollment_number": "academic_nexus",
  "student.external_contact_id": "accounting",
  "account.ledger_name": "accounting",
  "account.ledger_code": "accounting",
  "tax.rate": "accounting",
  "period.status": "accounting",
};

/**
 * The guard the inbound path calls (§55). An external change to a field
 * Academic Nexus owns is never applied — it becomes a reconciliation
 * finding, so a person decides.
 */
export function mayExternalOverwrite(field: string): boolean {
  return FIELD_OWNERSHIP[field] === "accounting";
}

export function authorityFor(object: string): FinancialObjectAuthority | undefined {
  return SOURCE_OF_TRUTH.find((row) => row.object === object);
}

/** Objects this hub will push outward — the only ones the pipeline accepts. */
export function outboundObjects(): string[] {
  return SOURCE_OF_TRUTH.filter((r) => r.direction === "outbound" || r.direction === "bidirectional").map(
    (r) => r.object
  );
}
