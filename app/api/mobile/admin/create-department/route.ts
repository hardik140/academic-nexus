import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { createDepartmentViaRequest } from "@/app/(portal)/admin/departments/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await createDepartmentViaRequest(request, {
      name: body.name,
      code: body.code,
      description: body.description,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
