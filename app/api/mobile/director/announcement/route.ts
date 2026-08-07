import { NextResponse } from "next/server";
import { RbacError } from "@/lib/rbac";
import { RateLimitError } from "@/lib/rate-limit";
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
    if (err instanceof RbacError) {
      const status = err.code === "UNAUTHENTICATED" ? 401 : err.code === "INACTIVE" ? 403 : 403;
      return NextResponse.json({ error: err.message }, { status });
    }
    if (err instanceof RateLimitError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed." }, { status: 400 });
  }
}
