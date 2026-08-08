import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { resendInvitationViaRequest } from "@/app/(portal)/admin/users/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await resendInvitationViaRequest(request, body.invitationId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
