import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { assignWardenViaRequest } from "@/app/(portal)/admin/hostel/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await assignWardenViaRequest(request, body.blockId, body.wardenUserId ?? null);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
