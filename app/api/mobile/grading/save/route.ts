import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { saveMarksViaRequest } from "@/app/(portal)/teacher/grading/actions";

/**
 * POST { offeringId, examType, maxMarks, entries: [{ studentDbId, obtainedMarks }] }
 *
 * Takes an OFFERING id, for the same reason attendance/save does: marks
 * belong to a delivery, and under the old course-keyed identity a student
 * retaking a course overwrote their earlier result. See the note there on
 * why a `courseId` is refused rather than reinterpreted.
 */
export async function POST(request: Request) {
  let body: {
    courseId?: string;
    offeringId?: string;
    examType?: string;
    maxMarks?: number;
    entries?: unknown;
  } | null = null;
  try {
    body = await request.json();
    const result = await saveMarksViaRequest(request, {
      offeringId: body!.offeringId as string,
      examType: body!.examType as never,
      maxMarks: body!.maxMarks as number,
      entries: body!.entries as never,
    });
    return NextResponse.json(result);
  } catch (err) {
    const res = errorResponse(err);

    // Only a 400 is replaced. An unauthenticated or forbidden caller must
    // still receive 401/403 — authentication is decided before the payload
    // shape matters, and a helpful message about our request format is not
    // something to hand out before knowing who is asking.
    //
    // A missing offeringId already fails validation on its own; this just
    // makes the reason legible to a stale app build. It never reinterprets
    // courseId as offeringId.
    if (res.status === 400 && body?.courseId && !body?.offeringId) {
      return NextResponse.json(
        {
          error:
            "This endpoint now takes offeringId (a course_offerings id), not courseId. " +
            "Marks belong to a specific section in a specific semester. Update the app.",
        },
        { status: 400 }
      );
    }
    return res;
  }
}
