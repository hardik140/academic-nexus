import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { applyForLeaveViaRequest } from "@/app/(portal)/teacher/leave/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await applyForLeaveViaRequest(request, {
      leaveType: body.leaveType,
      startDate: body.startDate,
      endDate: body.endDate,
      reason: body.reason,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
