import { NextResponse } from "next/server";
import { RbacError } from "@/lib/rbac";
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
    if (err instanceof RbacError) {
      const status = err.code === "UNAUTHENTICATED" ? 401 : err.code === "INACTIVE" ? 403 : 403;
      return NextResponse.json({ error: err.message }, { status });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed." }, { status: 400 });
  }
}
