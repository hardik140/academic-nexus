import { NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Scheduled endpoint — QStash calls this on a cron schedule (see the setup
 * instructions in Development Log - Redis Caching, Rate Limiting & Scheduled
 * Refresh.md) to keep the analytics materialized views from going stale.
 * refresh_analytics() (migration 011) previously only ever ran once,
 * manually, from a seed script.
 *
 * verifySignatureAppRouter rejects any request not signed by QStash's
 * QSTASH_CURRENT_SIGNING_KEY/QSTASH_NEXT_SIGNING_KEY — this must never be
 * reachable by an unauthenticated caller, since refresh_analytics() runs
 * with the service-role client.
 */
async function handler() {
  const supabase = createAdminClient();
  const { error } = await supabase.rpc("refresh_analytics");

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, refreshedAt: new Date().toISOString() });
}

// verifySignatureAppRouter reads its signing keys at module-load time and
// throws immediately if they're missing — which would otherwise crash the
// build/boot before QStash is provisioned. Guard it: without both keys
// configured, there is no legitimate way to verify a caller, so the route
// just refuses every request instead of running unauthenticated.
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
    // verifySignatureAppRouter throws (rather than returning a response) on
    // malformed input (e.g. a signature header that isn't even a valid JWT)
    // instead of just an invalid-but-well-formed one. Normalize every
    // rejection to a plain 401 rather than leaking an internal stack trace
    // to whoever hit this endpoint.
    return NextResponse.json({ ok: false, error: "Invalid signature." }, { status: 401 });
  }
}
