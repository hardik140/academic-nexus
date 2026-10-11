/**
 * Reading a Supabase result without discarding its error (owner decision D5).
 *
 * The pattern these replace —
 *
 *   const { data } = await supabase.from("gate_passes").select("*");
 *   setPasses(data || []);
 *
 * — turns a failed read into an empty list, so a queue that could not be
 * loaded looks like a queue with nothing in it. With these, a failed read
 * throws, and the screen shows it as an error (StateView, ErrorState).
 *
 * The thrown ReadError carries the Supabase error's `code` (so
 * lib/feedback-error.ts can tell an expired session, PGRST301/PGRST303, or a
 * permission refusal, 42501, from any other failure) but never its message:
 * PostgREST relays PostgreSQL's own words, which describe the schema.
 *
 * Client-side only. A Server Component page throws dbError(error)
 * (lib/internal-error.ts) instead, which also logs the fault for operators.
 */

export interface SupabaseErrorLike {
  code?: string;
  message?: string;
}

export class ReadError extends Error {
  readonly code?: string;
  constructor(error: SupabaseErrorLike) {
    super("The data could not be loaded.");
    this.name = "ReadError";
    this.code = error.code;
  }
}

// Typed by the whole result rather than its data, so Supabase's response
// unions ({ data: T; error: null } | { data: null; error: E }) keep their
// row type.
type ListResult = { data: readonly unknown[] | null; error: SupabaseErrorLike | null };
type ValueResult = { data: unknown; error: SupabaseErrorLike | null };

/** Rows from a list read: [] only when the read succeeded and found nothing. */
export function requireRows<R extends ListResult>(result: R): NonNullable<R["data"]> {
  if (result.error) throw new ReadError(result.error);
  return (result.data ?? []) as NonNullable<R["data"]>;
}

/**
 * PostgREST's answer to `.single()` when no row matched. Not a failure: the
 * read succeeded and found none, which callers already treat as null.
 */
export const NO_ROWS_CODE = "PGRST116";

/** The value of a single-row or scalar read; null only when the read succeeded and found none. */
export function requireData<R extends ValueResult>(result: R): R["data"] | null {
  if (result.error && result.error.code !== NO_ROWS_CODE) throw new ReadError(result.error);
  return result.error ? null : result.data;
}

/**
 * The id to filter by when the row it would come from does not exist (a
 * profile with no student record yet, a HOD with no department): a valid
 * UUID that no row has, so the read succeeds and finds nothing. An empty
 * string is not a UUID — PostgREST rejects it (22P02) — which would turn
 * "nothing here yet" into a failed read.
 */
export const NO_MATCH_ID = "00000000-0000-0000-0000-000000000000";

/** A count read (`{ count: "exact", head: true }`): 0 only when the read succeeded. */
export function requireCount(result: { count: number | null; error: SupabaseErrorLike | null }): number {
  if (result.error) throw new ReadError(result.error);
  return result.count ?? 0;
}
