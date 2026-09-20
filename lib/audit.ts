import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthorizedActor } from "@/lib/rbac";
import type { Database, Json } from "@/types/database";

/**
 * `values` is optional and backward-compatible — every pre-existing call
 * site keeps compiling unchanged and keeps writing null old_value/new_value,
 * same as before. New call sites for the Decision Inbox / risk-flag
 * lifecycle / strategic goals MUST pass real before/after state here; that's
 * what makes their audit trail an actual diff instead of just "an action
 * happened."
 */
/**
 * WHY THE RESULT IS INSPECTED AND NOT DISCARDED
 *
 * This used to be a bare `await supabase.from("audit_logs").insert(...)`.
 * The Supabase client does not throw on a failed write — it RESOLVES, with
 * the failure in `error`. So a rejected insert (an RLS denial, a constraint,
 * a dropped connection) produced no exception, no log line and no return
 * value anybody looked at: the mutation completed, the audit record did not,
 * and nothing anywhere recorded that the two had diverged.
 *
 * That is the failure mode an audit trail exists to make impossible. It is
 * now logged at error level with everything needed to reconstruct the entry
 * by hand, and the function reports whether the record was actually written.
 *
 * WHAT THIS STILL IS NOT
 *
 * A guarantee. The audit row is written by the application, in a separate
 * statement from the mutation it describes, so a process that dies between
 * the two still loses the record. Closing that properly means writing the
 * audit row from a database trigger, inside the same transaction as the
 * change — recorded as a finding rather than quietly implemented here,
 * because it is a schema change across every audited table and not a
 * "smallest safe change".
 *
 * Deliberately does NOT throw. The mutation being described has already
 * committed by the time this runs; turning a lost audit row into a thrown
 * error would report a successful operation as failed, and the caller's
 * natural response — retry — would perform it a second time.
 */
export async function logAudit(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  action: string,
  tableName: string,
  recordId: string,
  values?: { oldValue?: Json; newValue?: Json }
): Promise<boolean> {
  const entry = {
    college_id: actor.collegeId,
    user_id: actor.userId,
    action,
    table_name: tableName,
    record_id: recordId,
    old_value: values?.oldValue ?? null,
    new_value: values?.newValue ?? null,
  };

  const { error } = await supabase.from("audit_logs").insert(entry);

  if (error) {
    // Everything needed to reconstruct the missing entry, and nothing that
    // is itself sensitive beyond what the entry already holds.
    console.error("[audit] FAILED TO WRITE AUDIT RECORD — the mutation it describes did happen", {
      action,
      table: tableName,
      recordId,
      actor: actor.userId,
      college: actor.collegeId,
      code: error.code,
      message: error.message,
    });
    return false;
  }

  return true;
}
