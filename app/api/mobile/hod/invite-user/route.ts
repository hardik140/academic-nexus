import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { inviteUserViaRequest } from "@/app/(portal)/hod/team/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const params =
      body.role === "student"
        ? {
            email: body.email,
            fullName: body.fullName,
            role: "student" as const,
            enrollmentNumber: body.enrollmentNumber,
            batchYear: body.batchYear,
            parentName: body.parentName,
            parentEmail: body.parentEmail,
            parentPhone: body.parentPhone,
          }
        : {
            email: body.email,
            fullName: body.fullName,
            role: "teacher" as const,
          };
    await inviteUserViaRequest(request, params);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
