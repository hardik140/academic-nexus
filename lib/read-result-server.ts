import { dbError } from "@/lib/internal-error";
import { NO_ROWS_CODE, type SupabaseErrorLike } from "@/lib/read-result";

/**
 * A Server Component read that must not fail silently (owner decision D5).
 *
 *   const { data: fees, error: feesError } = await supabase.from("fees").select("*");
 *   assertRead(feesError);
 *
 * A failed read throws — logged for operators and reduced to a safe message
 * by dbError() (lib/internal-error.ts) — so the page's error boundary
 * (app/(portal)/error.tsx) shows it with Try again, instead of the page
 * rendering an empty list or zero totals as though they were true. Inside
 * getCached() the throw also keeps the failure out of the cache.
 *
 * .single() finding no row (PGRST116) is not a failure: the read succeeded
 * and found none, which these pages already treat as null.
 */
export function assertRead(error: SupabaseErrorLike | null | undefined): void {
  if (error && error.code !== NO_ROWS_CODE) throw dbError(error);
}
