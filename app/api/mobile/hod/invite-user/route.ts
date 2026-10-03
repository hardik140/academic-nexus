import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { inviteUserViaRequest } from "@/app/(portal)/hod/team/actions";

/**
 * A student invitation names a SECTION (migration 055): the department,
 * programme and batch year are resolved by the database from it, so the
 * body carries no department and no batch year. A body that still sends
 * `batchYear` without `sectionId` is refused by the schema rather than
 * silently placed somewhere.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const params =
      body.role === "student"
        ? {
            email: body.email,
            fullName: body.fullName,
            role: "student" as const,
            sectionId: body.sectionId,
            enrollmentNumber: body.enrollmentNumber,
            programmeSemester: body.programmeSemester,
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
