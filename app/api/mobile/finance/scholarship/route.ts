import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { createScholarshipViaRequest } from "@/app/(portal)/finance/scholarships/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await createScholarshipViaRequest(request, {
      studentId: body.studentId,
      name: body.name,
      type: body.type,
      amount: body.amount,
      academicYear: body.academicYear,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
