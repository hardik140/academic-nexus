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
 *
 * WHAT A FAILED RPC IS ALLOWED TO SAY
 *
 * This used to throw the PostgREST error's own message, and that message is
 * whatever PostgreSQL produced. Route handlers pass an unrecognised Error
 * straight through to the client (lib/api-errors.ts), so POST
 * /api/security/scan would answer a failure with the database's own words:
 * constraint names, function names, column names, the shape of the schema.
 * A guard has no use for any of it and an attacker holding a guard's token
 * has quite a lot of use for it.
 *
 * The rule below is the narrowest one that keeps the useful half. Migration
 * 050 writes its deliberate, reviewed refusals with a `gate security: `
 * prefix — "this account is not an active gate security operator", "a
 * revocation must record a reason" — and those are meant to be read by the
 * person who triggered them. Everything else is an internal fault: it is
 * replaced with a flat message and the real one is logged server-side,
 * where operators can correlate it and the caller cannot see it.
 */

const SAFE_PREFIX = "gate security: ";

export class GateSecurityRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateSecurityRpcError";
  }
}

interface PostgrestError {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

export async function callRpc<T>(
  supabase: SupabaseClient<Database>,
  fn: string,
  args: Record<string, unknown>
): Promise<T[]> {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string,
    params: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: PostgrestError | null }>;
  const { data, error } = await rpc(fn, args);

  if (error) throw gateRpcError(fn, error);
  return (data as T[] | null) ?? [];
}

/**
 * Exported for the regression test, which is the only way to assert that a
 * PostgreSQL message never reaches a caller without standing up PostgREST.
 */
export function gateRpcError(fn: string, error: PostgrestError): GateSecurityRpcError {
  const raw = String(error.message ?? "");

  if (raw.startsWith(SAFE_PREFIX)) {
    return new GateSecurityRpcError(raw.slice(SAFE_PREFIX.length).trim() || "The request was refused.");
  }

  // Server-side only. `console.error` is what this deployment's platform
  // collects (Workers observability is enabled in wrangler.jsonc); the
  // function name and SQLSTATE are enough to find the fault, and neither
  // is ever returned to the caller.
  console.error("[gate-security] rpc failed", {
    fn,
    code: error.code,
    message: raw,
    details: error.details,
  });

  return new GateSecurityRpcError(
    "The request could not be completed. Try again, and tell your administrator if it keeps happening."
  );
}
