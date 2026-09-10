import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { saveAttendanceViaRequest } from "@/app/(portal)/teacher/attendance/actions";

/**
 * POST { offeringId, date, entries: [{ studentDbId, status }] }
 *
 * Takes an OFFERING id — one course, one section, one semester, one
 * instructor. It previously took `courseId`, which could not say which
 * section's register was being written.
 *
 * There is no compatibility shim: a course id is never reinterpreted as an
 * offering id. Both are UUIDs, so accepting one as the other would either
 * fail an authority check for a confusing reason or, worse, match a real
 * but unrelated offering. Two identifiers meaning "which class" is exactly
 * the ambiguity this migration removes.
 */
export async function POST(request: Request) {
  let body: { courseId?: string; offeringId?: string; date?: string; entries?: unknown } | null = null;
  try {
    body = await request.json();
    const result = await saveAttendanceViaRequest(request, {
      offeringId: body!.offeringId as string,
      date: body!.date as string,
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
            "Attendance belongs to a specific section in a specific semester. Update the app.",
        },
        { status: 400 }
      );
    }
    return res;
  }
}
