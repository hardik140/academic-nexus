import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
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
    return errorResponse(err);
  }
}
