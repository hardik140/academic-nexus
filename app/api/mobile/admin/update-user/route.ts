import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { updateUserProfileViaRequest } from "@/app/(portal)/admin/users/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await updateUserProfileViaRequest(request, {
      targetUserId: body.targetUserId,
      fullName: body.fullName,
      role: body.role,
      phone: body.phone,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
