import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  const startedAt = Date.now();

  try {
    // Service-role client here is a narrow, deliberate exception to its
    // usual "only after requireRole()" rule: this endpoint takes no input
    // and returns no row data, only a boolean — there's nothing for an
    // unauthenticated caller to leverage. The point is to prove the
    // Next.js -> Postgres path is actually alive, independent of any
    // caller's RLS visibility.
    const supabase = createAdminClient();
    const { error } = await supabase
      .from("colleges")
      .select("id", { count: "exact", head: true });

    if (error) {
      return NextResponse.json(
        { ok: false, database: false, error: error.message },
        { status: 503 }
      );
    }

    return NextResponse.json({
      ok: true,
      database: true,
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, database: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 503 }
    );
  }
}
