import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { createCollegeViaRequest } from "@/app/(portal)/super-admin/colleges/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await createCollegeViaRequest(request, {
      name: body.name,
      code: body.code,
      country: body.country,
      city: body.city,
      state: body.state,
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
