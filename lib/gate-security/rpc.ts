import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * Calling a SECURITY DEFINER function through the typed client.
 *
 * types/database.ts declares `Functions: Record<string, never>` — the
 * Database type here is hand-maintained, and an earlier attempt to list
 * functions in it surfaced an unrelated pre-existing cast failure in the
 * placements module. The same narrow escape hatch the refund approval path
 * uses is collected here instead of repeated at each of the six gate
 * security call sites, with the row shape stated by the caller so it still
 * has to match the RETURNS TABLE it is naming.
 */
export async function callRpc<T>(
  supabase: SupabaseClient<Database>,
  fn: string,
  args: Record<string, unknown>
): Promise<T[]> {
  const rpc = supabase.rpc as unknown as (
    name: string,
    params: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(error.message);
  return (data as T[] | null) ?? [];
}
