import { NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Scheduled endpoint — closes gate credentials whose window has passed, and
 * marks approved passes nobody used as expired (migration 050 §15).
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH
 *
 * A pass whose student is still OUTSIDE. That pass is overdue, not expired,
 * and the two mean opposite things to a warden looking at the screen at
 * midnight: expired says "nothing happened", overdue says "someone has not
 * come back". Relabelling the second as the first would erase the only fact
 * that matters. Overdue passes surface on the Director's and the guard's
 * dashboards instead, and stay active until the student returns.
 *
 * Signed by QStash and run with the service-role client, same posture as
 * the other cron routes here: expire_stale_gate_credentials() is REVOKEd
 * from authenticated, so there is no path to it from a session.
 *
 * Suggested schedule: hourly. Nothing breaks if it does not run — an
 * expired credential is refused at scan time by its own expires_at check
 * (050 §12); this only keeps the stored status honest for the screens that
 * read it.
 */
async function handler() {
  const supabase = createAdminClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string,
    params: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

  const { data, error } = await rpc("expire_stale_gate_credentials", {});
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const row = (data as { credentials_expired: number; passes_expired: number }[] | null)?.[0];
  return NextResponse.json({
    ok: true,
    credentialsExpired: row?.credentials_expired ?? 0,
    passesExpired: row?.passes_expired ?? 0,
    ranAt: new Date().toISOString(),
  });
}

const hasQstashKeys = !!(process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY);
const verifiedHandler = hasQstashKeys ? verifySignatureAppRouter(handler) : null;

export async function POST(request: Request) {
  if (!verifiedHandler) {
    return NextResponse.json({ ok: false, error: "QStash signing keys are not configured." }, { status: 503 });
  }
  try {
    return await verifiedHandler(request);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid signature." }, { status: 401 });
  }
}
