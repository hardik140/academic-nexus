import { NextResponse } from "next/server";
import { RbacError } from "@/lib/rbac";
import { RateLimitError } from "@/lib/rate-limit";
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
    if (err instanceof RbacError) {
      const status = err.code === "UNAUTHENTICATED" ? 401 : 403;
      return NextResponse.json({ error: err.message }, { status });
    }
    if (err instanceof RateLimitError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed." }, { status: 400 });
  }
}
