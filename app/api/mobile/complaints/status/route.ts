import { NextResponse } from "next/server";
import { RbacError } from "@/lib/rbac";
import { updateComplaintStatusViaRequest } from "@/app/(portal)/warden/complaints/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await updateComplaintStatusViaRequest(request, body.complaintId, body.status);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof RbacError) {
      const status = err.code === "UNAUTHENTICATED" ? 401 : err.code === "INACTIVE" ? 403 : 403;
      return NextResponse.json({ error: err.message }, { status });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed." }, { status: 400 });
  }
}
