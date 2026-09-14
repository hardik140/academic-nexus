/**
 * What a failed database or service call is allowed to tell the caller.
 *
 * THE DEFECT THIS CLOSES (F-002)
 *
 * 102 call sites across the server actions did this:
 *
 *   const { data, error } = await supabase.from("x").select();
 *   if (error) throw new Error(error.message);
 *
 * `error.message` is PostgREST relaying PostgreSQL verbatim — constraint
 * names, function signatures, column names, table names, the shape of the
 * schema. Route handlers pass an unrecognised Error's message straight to
 * the client (lib/api-errors.ts), so roughly thirty mobile API endpoints
 * answered a failure by describing the database to whoever asked.
 *
 * THE CLASSIFICATION, AND WHY IT IS MECHANICAL
 *
 * Every one of those sites takes its text from a Supabase error OBJECT, so
 * all of them are internal faults by construction. A deliberate,
 * human-written business message looks different — `new Error("This gate
 * pass must be approved before an exit can be recorded.")` — and is left
 * alone, because it is meant to be read. That distinction is visible in the
 * source, which is what made the fix safe to apply in bulk:
 *
 *   throw new Error(error.message)   ->  INTERNAL   -> generic + server log
 *   throw new Error("some text")     ->  BUSINESS   -> unchanged
 *
 * No business semantics change. What changes is only who can read the
 * database's own words: operators, in the server log, instead of callers.
 */

/** Deliberately free of any `next/*` import so anything server-side may use it. */
export class InternalOperationError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "The request could not be completed. Try again, and tell your administrator if it keeps happening."
    );
    this.name = "InternalOperationError";
  }
}

/** The shape PostgREST returns, and roughly what other service clients return. */
export interface InternalErrorLike {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/**
 * Log the real fault where operators can correlate it, and hand the caller
 * something that discloses nothing.
 *
 * The call site is recovered from the stack rather than passed in by hand at
 * every site — a `context` argument repeated a hundred times is a hundred
 * chances to paste the wrong one, and the frame below this function is
 * always the thrower.
 */
export function dbError(error: InternalErrorLike | null | undefined): InternalOperationError {
  const wrapped = new InternalOperationError();
  // console.error is what this deployment collects (Workers observability is
  // enabled in wrangler.jsonc). Never the payload, never a credential — a
  // SQLSTATE and a message is enough to find the fault.
  console.error("[internal] database/service call failed", {
    code: error?.code,
    message: error?.message,
    details: error?.details,
    hint: error?.hint,
    at: wrapped.stack?.split("\n")[2]?.trim(),
  });
  return wrapped;
}

/**
 * Last line of defence at the response boundary, for anything that did not
 * come through dbError() — an unexpected runtime fault, or a site this
 * change missed.
 *
 * Heuristic on purpose. It cannot be exhaustive, and it is not the control
 * that closes F-002; the call sites are. It exists so that a message which
 * unmistakably describes the database can never reach a client even if some
 * future code path throws one.
 */
const INTERNAL_MARKERS = [
  /violates (unique|check|foreign key|not-null) constraint/i,
  /permission denied for (table|function|schema|materialized view|column)/i,
  /relation "[^"]+" does not exist/i,
  /column "[^"]+" (does not exist|of relation)/i,
  /function [a-z_.]+\([^)]*\) does not exist/i,
  /duplicate key value/i,
  /invalid input syntax for type/i,
  /could not serialize access/i,
  /deadlock detected/i,
  /\bpg_[a-z_]+\b/i,
  /\bPGRST\d+\b/,
  // A SQL STATEMENT, not merely a sentence that opens with a SQL keyword.
  // The first version of this matched /^(SELECT|INSERT|...)\s/ and redacted
  // "Select a gate before scanning." — a legitimate instruction to a guard,
  // suppressed as though it were a database internal. A rule that hides real
  // business errors is worse than the leak it was written to stop, so each
  // keyword now has to be followed by the clause that actually makes it SQL.
  /\bSELECT\b[\s\S]*\bFROM\b/i,
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\b[\s\S]*\bSET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\b(ALTER|DROP|CREATE)\s+(TABLE|INDEX|POLICY|FUNCTION|SCHEMA|VIEW)\b/i,
  /at .*node_modules/,
];

export function looksInternal(message: string): boolean {
  return INTERNAL_MARKERS.some((re) => re.test(message));
}
