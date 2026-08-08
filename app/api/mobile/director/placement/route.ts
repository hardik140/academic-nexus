import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { createPlacementViaRequest } from "@/app/(portal)/director/placements/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await createPlacementViaRequest(request, {
      studentId: body.studentId,
      companyName: body.companyName,
      roleTitle: body.roleTitle,
      packageLpa: body.packageLpa,
      placementDate: body.placementDate,
      offerType: body.offerType,
      status: body.status,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
