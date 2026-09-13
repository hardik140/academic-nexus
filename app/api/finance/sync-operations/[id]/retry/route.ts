import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { requireRoleFromRequest } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { assertClaimed } from "@/lib/concurrent-claim";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/finance/sync-operations/:id/retry (§77, §68).
 *
 * The same rule the UI enforces, enforced again here because an API caller
 * is not the UI: only a failure the pipeline classified `safe` may be sent
 * again. For an unknown result the answer is 409 with the reason, not a
 * retry — the accounting system may already hold the document, and a second
 * POST is how one payment becomes two receipts.
 *
 * The database refuses the transition independently (049's trigger), so this
 * check is the explanation rather than the protection.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { supabase, ...actor } = await requireRoleFromRequest(request, PERMISSIONS.finance_sync_retry);

    const { data: op } = await supabase
      .from("finance_sync_operations")
      .select("id, status, retry_safety, attempt_number, max_attempts, error_code")
      .eq("id", id)
      .eq("college_id", actor.collegeId)
      .maybeSingle();
    if (!op) return NextResponse.json({ error: "Sync operation not found." }, { status: 404 });

    if (op.status !== "FAILED") {
      return NextResponse.json({ error: `Only a FAILED operation can be retried; this one is ${op.status}.` }, { status: 409 });
    }
    if (op.retry_safety !== "safe") {
      return NextResponse.json(
        {
          error: `This failure (${op.error_code ?? "unknown"}) is not safe to retry — the accounting system may already hold the document. Reconcile first.`,
          retrySafety: op.retry_safety,
        },
        { status: 409 }
      );
    }
    if (op.attempt_number >= op.max_attempts) {
      return NextResponse.json({ error: `All ${op.max_attempts} attempts are used.` }, { status: 409 });
    }

    const { data: claimed, error } = await supabase
      .from("finance_sync_operations")
      .update({ status: "RETRYING", next_attempt_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "FAILED")
      .select("id");
    if (error) throw new Error(error.message);
    assertClaimed(claimed, "sync operation");

    await logAudit(supabase, actor, "finance_sync_retried", "finance_sync_operations", id, {
      oldValue: { status: "FAILED" },
      newValue: { status: "RETRYING", attempt: op.attempt_number + 1 },
    });

    return NextResponse.json({ ok: true, status: "RETRYING" });
  } catch (err) {
    return errorResponse(err);
  }
}
