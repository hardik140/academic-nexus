import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { actOnLeaveRequestViaRequest } from "@/app/(portal)/hod/approvals/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await actOnLeaveRequestViaRequest(request, body.requestId, body.action);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
