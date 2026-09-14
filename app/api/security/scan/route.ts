import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { scanGatePassViaRequest } from "@/app/(portal)/security/actions";

/**
 * POST /api/security/scan — the same scan, over HTTP.
 *
 * For a handheld scanner or the mobile app, which carry a Bearer token
 * rather than a cookie. It is the SAME code path as the web action:
 * requireRoleFromRequest, the same signature verification, the same
 * record_gate_movement() call. There is no "API mode" that skips a check,
 * because the checks are not in the transport.
 *
 * A refused scan is a 200 with an outcome, not an HTTP error: "this pass is
 * expired" is a successful answer to the question the guard asked, and a
 * client that only reads status codes must not be able to mistake it for a
 * network failure and retry it into a second movement.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await scanGatePassViaRequest(request, {
      payload: String(body?.payload ?? ""),
      gateId: String(body?.gateId ?? ""),
      device: { source: "api", userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? undefined },
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
