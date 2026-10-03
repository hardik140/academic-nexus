import { NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { runOperation } from "@/lib/finance/pipeline";
import { unavailableCollegeIds } from "@/lib/college-access";

/**
 * The finance integration worker (§78).
 *
 * Posting to an accounting system must not depend on a browser request
 * staying open: a receipt half-created because someone closed a tab is the
 * kind of state reconciliation exists to find and nobody wants to find. So
 * the operator action only QUEUES, and this endpoint — driven by QStash on a
 * schedule, the same mechanism refresh-analytics already uses — drains the
 * queue.
 *
 * THE QUEUE IS THE JOURNAL. Rows in finance_sync_operations with status
 * QUEUED or RETRYING and next_attempt_at in the past. No second job store,
 * so there is no way for "the queue says posted" and "the journal says
 * failed" to disagree — they are the same row.
 *
 * SERVICE ROLE, DELIBERATELY. The worker reads decrypted credentials, which
 * no authenticated role can reach. Every tenancy check the RLS would have
 * made is therefore made explicitly inside runOperation().
 *
 * BOUNDED PER INVOCATION. A run takes a fixed slice rather than draining
 * everything: a serverless invocation has a wall clock, and an operation
 * interrupted mid-flight is exactly the unknown result that costs a
 * reconciliation. Whatever is left is picked up on the next tick.
 */

const MAX_PER_RUN = 25;

async function handler() {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  const { data: due, error } = await supabase
    .from("finance_sync_operations")
    .select("id, college_id, status, next_attempt_at")
    .in("status", ["QUEUED", "RETRYING"])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(MAX_PER_RUN);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Lifecycle-blocked (migration 053): a college in MAINTENANCE or
  // SUSPENDED is not synced. Its operations stay QUEUED/RETRYING, untouched,
  // and run after it is reactivated.
  const blocked = await unavailableCollegeIds(supabase);
  const results: Array<{ id: string; status: string; errorCode?: string }> = [];
  for (const row of due ?? []) {
    if (blocked.has(row.college_id)) {
      results.push({ id: row.id, status: "SKIPPED_COLLEGE_UNAVAILABLE" });
      continue;
    }
    try {
      const outcome = await runOperation(supabase, row.id);
      results.push({ id: row.id, status: outcome.status, errorCode: outcome.errorCode });
    } catch (err) {
      // A throw here means the pipeline could not even record an outcome —
      // the operation stays PROCESSING and the next run will not pick it up
      // (it only selects QUEUED/RETRYING), which is correct: a stuck
      // PROCESSING row is visible on the dashboard and must be reconciled
      // rather than silently re-attempted.
      results.push({ id: row.id, status: "ERROR", errorCode: (err as Error).message.slice(0, 200) });
    }
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({ ok: true, processed: results.length, counts, ranAt: nowIso });
}

// Same posture as refresh-analytics: with no signing keys configured there
// is no way to tell a legitimate caller from anyone else, and this endpoint
// runs with the service-role client — so it refuses every request rather
// than running unauthenticated.
const hasQstashKeys = !!(process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY);
const verifiedHandler = hasQstashKeys ? verifySignatureAppRouter(handler) : null;

export async function POST(request: Request) {
  if (!verifiedHandler) {
    return NextResponse.json(
      { ok: false, error: "QStash signing keys are not configured." },
      { status: 503 }
    );
  }
  try {
    return await verifiedHandler(request);
  } catch {
    // Same normalisation refresh-analytics does: verifySignatureAppRouter
    // throws on a malformed signature header rather than returning a
    // response, and a stack trace is not something to hand an unknown caller.
    return NextResponse.json({ ok: false, error: "Invalid signature." }, { status: 401 });
  }
}
