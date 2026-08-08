import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { actOnGatePassViaRequest } from "@/app/(portal)/warden/gatepasses/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await actOnGatePassViaRequest(request, body.passId, body.action);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
