import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { assignHodViaRequest } from "@/app/(portal)/admin/departments/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await assignHodViaRequest(request, body.departmentId, body.hodUserId ?? null);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
