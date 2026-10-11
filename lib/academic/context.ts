import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { dbError } from "@/lib/internal-error";
import type { AcademicContext } from "@/lib/academic/types";

/**
 * The caller's current academic placement — my_academic_context() (055),
 * the one read web and mobile share so they cannot show different classes.
 *
 * A database that predates 055 has no such function (PostgREST PGRST202 /
 * PostgreSQL 42883): that is "the feature is not there yet" and returns
 * null, so the page simply omits the card. Every OTHER failure is an error
 * and throws (owner decision D5: a failed read is never shown as nothing).
 */
export async function readAcademicContext(supabase: SupabaseClient<Database>): Promise<AcademicContext | null> {
  const call = supabase.rpc.bind(supabase) as unknown as (name: string) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
  const { data, error } = await call("my_academic_context");
  if (error && (error.code === "PGRST202" || error.code === "42883")) return null;
  if (error) throw dbError(error);
  return (data as AcademicContext | null) ?? null;
}
