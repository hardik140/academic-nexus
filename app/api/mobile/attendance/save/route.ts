import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { saveAttendanceViaRequest } from "@/app/(portal)/teacher/attendance/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await saveAttendanceViaRequest(request, {
      courseId: body.courseId,
      date: body.date,
      entries: body.entries,
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
