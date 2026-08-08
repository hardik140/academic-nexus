import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { inviteUserViaRequest } from "@/app/(portal)/admin/users/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await inviteUserViaRequest(request, {
      email: body.email,
      fullName: body.fullName,
      role: body.role,
      departmentId: body.departmentId,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
