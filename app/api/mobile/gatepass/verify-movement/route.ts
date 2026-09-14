import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { recordManualGateMovementViaRequest } from "@/app/(portal)/warden/gatepasses/actions";

/**
 * POST /api/mobile/gatepass/verify-movement — the warden's manual override.
 *
 * Named "verify-movement" because that is what it was called when the
 * warden was the only person who could record a crossing. It now requires a
 * reason and writes an is_override row in the movement ledger, same as the
 * web action. The ordinary path is /api/security/scan.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await recordManualGateMovementViaRequest(request, {
      passId: String(body?.passId ?? ""),
      action: body?.action === "return" ? "return" : "exit",
      gateId: body?.gateId ? String(body.gateId) : null,
      reason: String(body?.reason ?? ""),
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
