import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { assertRead } from "@/lib/read-result-server";

/**
 * Calls one of the business-read functions of migration 059 (and later)
 * and returns its rows, or throws the same failed-read error every other read
 * here throws.
 *
 * These functions exist because PostgREST returns at most `max_rows` rows
 * (1,000 by default) to a select with no range, and says nothing: a total
 * computed in JavaScript from that page was silently wrong past it. Each
 * function computes the answer in PostgreSQL and returns a small result.
 *
 * NO FALLBACK, deliberately. Falling back to the old capped computation
 * when a function is missing would bring back the wrong number this exists
 * to remove. Apply 059 before deploying code that calls it; until then the
 * page shows its error state rather than a truncated total.
 *
 * Bound: SupabaseClient.rpc uses `this`, and a detached reference throws on
 * every call (tests/supabase-rpc-binding.test.ts).
 */
export async function businessRpc<Row>(
  supabase: SupabaseClient<Database> | { rpc: SupabaseClient<Database>["rpc"] },
  fn: string,
  args: Record<string, unknown>
): Promise<Row[]> {
  const rpc = (supabase.rpc as unknown as (...a: unknown[]) => unknown).bind(supabase) as (
    name: string,
    params: Record<string, unknown>
  ) => PromiseLike<{ data: Row[] | Row | null; error: { message: string; code?: string } | null }>;
  const { data, error } = await rpc(fn, args);
  assertRead(error);
  if (data === null || data === undefined) return [];
  return Array.isArray(data) ? data : [data];
}

/** A bigint or numeric column as PostgREST sends it (number or string). */
export function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
