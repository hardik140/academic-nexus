import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { requireRoleFromRequest } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import type { Database } from "@/types/database";
import { dbError } from "@/lib/internal-error";

type SyncStatus = Database["public"]["Tables"]["finance_sync_operations"]["Row"]["status"];

const STATUSES: SyncStatus[] = [
  "PENDING", "QUEUED", "PROCESSING", "SYNCED", "PARTIALLY_SYNCED",
  "FAILED", "RETRYING", "RECONCILIATION_REQUIRED", "BLOCKED", "CANCELLED",
];

/**
 * GET /api/finance/sync-operations — the journal, filtered (§67, §77).
 *
 * This is the endpoint that answers §101's questions for a headless caller:
 * what was attempted, what came back, which external document resulted, and
 * why not when there is none. It returns hashes rather than payloads, so a
 * monitoring integration can prove a retry sent the same request without the
 * journal handing out bank references.
 */
export async function GET(request: Request) {
  try {
    const { supabase, ...actor } = await requireRoleFromRequest(request, PERMISSIONS.finance_sync_read);
    const url = new URL(request.url);

    const statusParam = url.searchParams.get("status");
    if (statusParam && !STATUSES.includes(statusParam as SyncStatus)) {
      return NextResponse.json({ error: `Unknown status "${statusParam}".` }, { status: 400 });
    }
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 250);

    let query = supabase
      .from("finance_sync_operations")
      .select(
        "id, connection_id, provider, entity_type, entity_id, operation, direction, status, attempt_number, " +
          "max_attempts, external_id, external_number, financial_year, period_key, request_hash, response_hash, " +
          "error_code, error_message, retry_safety, next_attempt_at, started_at, completed_at, created_at"
      )
      .eq("college_id", actor.collegeId)
      .order("created_at", { ascending: false })
      .limit(limit);

    const connectionId = url.searchParams.get("connectionId");
    if (connectionId) query = query.eq("connection_id", connectionId);
    if (statusParam) query = query.eq("status", statusParam as SyncStatus);

    const { data, error } = await query;
    if (error) throw dbError(error);
    return NextResponse.json({ operations: data ?? [] });
  } catch (err) {
    return errorResponse(err);
  }
}
