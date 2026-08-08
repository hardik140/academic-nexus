import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { updateComplaintStatusViaRequest } from "@/app/(portal)/warden/complaints/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await updateComplaintStatusViaRequest(request, body.complaintId, body.status);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
