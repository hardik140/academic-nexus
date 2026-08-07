import { NextResponse } from "next/server";
import { requireRoleFromRequest, RbacError } from "@/lib/rbac";

const ALL_ROLES = ["student", "teacher", "hod", "finance", "director", "admin", "warden"] as const;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { token, platform } = body as { token: string; platform: "ios" | "android" };

    if (!token || !platform) {
      return NextResponse.json({ error: "token and platform are required." }, { status: 400 });
    }

    const { supabase, userId, collegeId } = await requireRoleFromRequest(request, [...ALL_ROLES]);

    const { error } = await supabase.from("device_tokens").upsert(
      {
        college_id: collegeId,
        user_id: userId,
        expo_push_token: token,
        platform,
      },
      { onConflict: "expo_push_token" }
    );

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof RbacError) {
      const status = err.code === "UNAUTHENTICATED" ? 401 : 403;
      return NextResponse.json({ error: err.message }, { status });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed." }, { status: 400 });
  }
}
