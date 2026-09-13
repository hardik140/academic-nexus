import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { requireRoleFromRequest } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * GET /api/finance/integrations — the provider-neutral connection list (§77).
 *
 * The point of this endpoint, and of every other one under /api/finance, is
 * that a client NEVER talks to TallyPrime, BUSY or Zoho Books. It asks
 * Academic Nexus, and Academic Nexus decides — with the credential, the
 * mapping, the capability gate and the idempotency key — whether anything
 * leaves the building.
 *
 * Bearer-token authenticated (requireRoleFromRequest), so the caller's own
 * RLS applies to the query below exactly as it would in the browser. No
 * secret is ever included: the credential table is unreadable to every
 * authenticated role by construction.
 */
export async function GET(request: Request) {
  try {
    const { supabase, ...actor } = await requireRoleFromRequest(request, PERMISSIONS.finance_integration_read);
    const { data, error } = await supabase
      .from("finance_integration_connections")
      .select(
        "id, provider, display_name, status, environment, external_company_name, organization_id, capabilities, " +
          "auto_sync_enabled, last_tested_at, last_success_at, last_failure_at, last_error_code, last_error_message, created_at"
      )
      .eq("college_id", actor.collegeId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return NextResponse.json({ connections: data ?? [] });
  } catch (err) {
    return errorResponse(err);
  }
}
