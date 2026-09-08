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
export async function logAudit(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  action: string,
  tableName: string,
  recordId: string,
  values?: { oldValue?: Json; newValue?: Json }
) {
  await supabase.from("audit_logs").insert({
    college_id: actor.collegeId,
    user_id: actor.userId,
    action,
    table_name: tableName,
    record_id: recordId,
    old_value: values?.oldValue ?? null,
    new_value: values?.newValue ?? null,
  });
}
