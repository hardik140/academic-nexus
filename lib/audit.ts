import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthorizedActor } from "@/lib/rbac";
import type { Database } from "@/types/database";

export async function logAudit(
  supabase: SupabaseClient<Database>,
  actor: AuthorizedActor,
  action: string,
  tableName: string,
  recordId: string
) {
  await supabase.from("audit_logs").insert({
    college_id: actor.collegeId,
    user_id: actor.userId,
    action,
    table_name: tableName,
    record_id: recordId,
  });
}
