import { NextResponse } from "next/server";
import { RbacError } from "@/lib/rbac";
import { createCourseViaRequest } from "@/app/(portal)/admin/courses/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await createCourseViaRequest(request, {
      name: body.name,
      code: body.code,
      departmentId: body.departmentId,
      credits: body.credits,
      semester: body.semester,
      type: body.type,
      description: body.description,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof RbacError) {
      const status = err.code === "UNAUTHENTICATED" ? 401 : err.code === "INACTIVE" ? 403 : 403;
      return NextResponse.json({ error: err.message }, { status });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed." }, { status: 400 });
  }
}
