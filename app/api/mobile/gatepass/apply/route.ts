import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
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
    return errorResponse(err);
  }
}
