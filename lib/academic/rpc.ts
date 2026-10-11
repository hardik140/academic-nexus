import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { dbError } from "@/lib/internal-error";

/**
 * Calls one of migration 055's SECURITY DEFINER functions.
 *
 * types/database.ts declares `Functions: Record<string, never>` (hand-
 * maintained; see lib/gate-security/rpc.ts for why), so the call goes through
 * the same narrow cast, with the caller stating the shape it expects back.
 *
 * Failures go through dbError(): 055 raises its refusals as sentences meant
 * for the person who triggered them ("Only the HOD of this department can
 * start its term.", "Teacher conflict: …"), and those pass through. Anything
 * that describes the database — a constraint name, a permission error — is
 * replaced with a generic message and logged server-side.
 */
type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string | null; hint?: string | null } | null }>;

export async function academicRpc<T>(
  supabase: SupabaseClient<Database>,
  fn: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const call = supabase.rpc.bind(supabase) as unknown as (name: string, params?: Record<string, unknown>) => RpcResult;
  const { data, error } = await call(fn, args);
  if (error) throw dbError(error);
  return data as T;
}
