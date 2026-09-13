import { createHash } from "node:crypto";
import type { RetrySafety, ProviderErrorKind } from "./providers/types";

/**
 * Idempotency and retry classification (§52, §68).
 *
 * THE FAILURE THIS PREVENTS
 *
 *   POST receipt -> network timeout -> retry -> a second receipt in Tally
 *
 * The money moved once and the books say twice. Nothing downstream — not
 * reconciliation, not a trial balance — can tell which of the two is real,
 * because they are identical.
 *
 * Two mechanisms, and they are different:
 *
 *   the KEY makes the same logical operation the same row. Deterministic
 *   from the transaction's own identity, so a retry, a re-queue and a
 *   duplicate click all collide on one unique index
 *   (finance_sync_operations_connection_id_idempotency_key_key).
 *
 *   the LINK makes the same logical operation the same external document.
 *   finance_external_links is checked before any create: an entity that
 *   already has an external id is never sent again, whatever its journal
 *   history says.
 *
 * The key alone is not enough — a row can be deleted, a key can be
 * regenerated with a new version — which is why the link exists and is
 * immutable.
 */

export interface IdempotencyInput {
  collegeId: string;
  connectionId: string;
  entityType: string;
  entityId: string;
  operation: string;
  /**
   * Bumped ONLY when a genuinely new external document is intended for the
   * same entity — a reversal after a voided voucher, say. Never bumped to
   * "get around" a duplicate error: that is exactly the double-post this
   * exists to stop.
   */
  version?: number;
}

export function idempotencyKey(input: IdempotencyInput): string {
  const version = input.version ?? 1;
  const canonical = [
    input.collegeId,
    input.connectionId,
    input.entityType,
    input.entityId,
    input.operation,
    `v${version}`,
  ].join(":");
  // Hashed rather than stored raw: the key goes to some providers as their
  // own idempotency header, and those have length limits.
  return `an_${createHash("sha256").update(canonical).digest("hex").slice(0, 40)}`;
}

/**
 * How a provider failure maps to "may we send this again".
 *
 * The single most important row is `unknown_result`: a request that was
 * written to the socket and never answered may have been applied. That is
 * UNSAFE, and the pipeline routes it to RECONCILIATION_REQUIRED — never to
 * an automatic retry.
 *
 * `network` is safe only in the narrow sense used here: the transport
 * failed before the request was delivered (DNS failure, connection refused).
 * An adapter that cannot distinguish that from a timeout-after-send must
 * report `unknown_result`, and each adapter's comments say which it does.
 */
export function retrySafetyFor(kind: ProviderErrorKind): RetrySafety {
  switch (kind) {
    case "network":
    case "rate_limited":
    case "provider_error":
      return "safe";
    case "auth":
    case "forbidden":
    case "validation":
    case "not_found":
    case "period_closed":
    case "capability":
    case "wrong_company":
      // Not a transport problem: sending it again produces the same refusal.
      // A person must fix the mapping, the period or the credential.
      return "exhausted";
    case "unknown_result":
      return "unsafe";
  }
}

/**
 * Exponential backoff with full jitter, capped. Jitter matters because a
 * provider outage otherwise produces a synchronised retry stampede from
 * every college at once.
 */
export function backoffSeconds(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) return Math.min(retryAfterSeconds, 3600);
  const base = Math.min(2 ** Math.max(attempt, 0) * 15, 1800);
  return Math.floor(base / 2 + Math.random() * (base / 2));
}

export function nextAttemptAt(attempt: number, retryAfterSeconds?: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + backoffSeconds(attempt, retryAfterSeconds) * 1000);
}

/**
 * The financial year a date belongs to, given the connection's start month
 * (§81). Academic Nexus has no financial-year entity — `fees.academic_year`
 * is free text and means the ACADEMIC year — so this is derived rather than
 * read, and the two are never assumed equal.
 */
export function financialYearFor(date: string, startMonth: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const startYear = month >= startMonth ? year : year - 1;
  // A financial year that starts in January is a single calendar year.
  if (startMonth === 1) return `FY ${startYear}`;
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

export function periodKeyFor(date: string): string {
  return date.slice(0, 7); // YYYY-MM
}
