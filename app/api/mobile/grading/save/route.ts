import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { saveMarksViaRequest } from "@/app/(portal)/teacher/grading/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await saveMarksViaRequest(request, {
      courseId: body.courseId,
      examType: body.examType,
      maxMarks: body.maxMarks,
      entries: body.entries,
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
