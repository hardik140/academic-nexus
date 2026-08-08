import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { sendAnnouncementViaRequest } from "@/app/(portal)/director/dashboard/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await sendAnnouncementViaRequest(request, {
      title: body.title,
      message: body.message,
      audience: body.audience,
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
