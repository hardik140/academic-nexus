import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api-errors";
import { requireRoleFromRequest } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { reconcile } from "@/lib/finance/reconciliation";

const Body = z.object({
  connectionId: z.string().guid(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * POST /api/finance/reconciliation/run (§77, §98).
 *
 * Compares a window of Academic Nexus payments against the same window at
 * the provider and returns both totals and the count of typed findings —
 * never a bare "mismatch". The findings themselves are rows, readable
 * through the reconciliation screen and resolvable only by a person.
 *
 * Runs on the CALLER's client, so the query is bounded by their RLS. The
 * credential read inside the engine uses the service-role client and nothing
 * of it is returned.
 */
export async function POST(request: Request) {
  try {
    const { supabase, ...actor } = await requireRoleFromRequest(request, PERMISSIONS.finance_reconciliation_execute);
    const body = Body.parse(await request.json());
    await checkRateLimit(`financeReconcileApi:${actor.userId}`, 10, 60);

    const { data: conn } = await supabase
      .from("finance_integration_connections")
      .select("id")
      .eq("id", body.connectionId)
      .eq("college_id", actor.collegeId)
      .maybeSingle();
    if (!conn) return NextResponse.json({ error: "Integration connection not found." }, { status: 404 });

    const outcome = await reconcile(supabase, {
      collegeId: actor.collegeId,
      connectionId: body.connectionId,
      periodStart: body.from,
      periodEnd: body.to,
      createdBy: actor.userId,
    });

    await logAudit(
      supabase,
      actor,
      `finance_reconciliation_${outcome.status.toLowerCase()}`,
      "finance_reconciliation_runs",
      outcome.runId,
      {
        newValue: {
          period: `${body.from}..${body.to}`,
          local: outcome.localAmount,
          external: outcome.externalAmount,
          difference: outcome.differenceAmount,
          issues: outcome.issues,
        },
      }
    );

    return NextResponse.json(outcome, { status: outcome.status === "FAILED" ? 502 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
