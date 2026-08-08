import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { updateUserStatusViaRequest } from "@/app/(portal)/admin/users/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await updateUserStatusViaRequest(request, body.targetUserId, body.status);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
