import { NextResponse } from "next/server";
import { RbacError } from "@/lib/rbac";
import { RateLimitError } from "@/lib/rate-limit";
import { applyForGatePassViaRequest } from "@/app/(portal)/student/gatepass/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await applyForGatePassViaRequest(request, {
      destination: body.destination,
      reason: body.reason,
      exitTime: body.exitTime,
      returnTime: body.returnTime,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof RbacError) {
      const status = err.code === "UNAUTHENTICATED" ? 401 : err.code === "INACTIVE" ? 403 : 403;
      return NextResponse.json({ error: err.message }, { status });
    }
    if (err instanceof RateLimitError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed." }, { status: 400 });
  }
}
