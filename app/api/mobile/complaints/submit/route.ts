import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { submitComplaintViaRequest } from "@/app/(portal)/student/complaints/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await submitComplaintViaRequest(request, {
      category: body.category,
      title: body.title,
      description: body.description,
      location: body.location,
      priority: body.priority,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
