import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateRequest } from "@/lib/rbac";
import { errorResponse } from "@/lib/api-errors";
import {
  AccessFeatureUnavailable,
  listOwnSessions,
  readAccessState,
  registerSession,
} from "@/lib/college-access";
import type { Database } from "@/types/database";

/**
 * POST /api/mobile/session — the mobile app registers its session at sign-in
 * and at every start (migration 054), and learns whether it is admitted:
 *
 *   { state: "active" }
 *   { state: "rejected", maxSessions, sessions }   at the device limit
 *   { state: "college_unavailable", collegeState, collegeName, message, expectedResumeAt }
 *   { state: "revoked" } · { state: "inactive" }
 *
 * Authentication only (see authenticateRequest); register_current_session()
 * acts on the caller's own session and nothing else.
 */
export async function POST(request: Request) {
  try {
    const { supabase: client } = await authenticateRequest(request);
    const supabase = client as unknown as SupabaseClient<Database>;
    const header = (name: string) => request.headers.get(name);

    let admission;
    try {
      admission = await registerSession(supabase, {
        client: header("x-nexus-client") === "mobile-app" ? "mobile" : "mobile-legacy",
        deviceId: header("x-nexus-device-id"),
        deviceLabel: header("x-nexus-device-label"),
        userAgent: header("user-agent"),
      });
    } catch (err) {
      // No registry in this database yet: nothing to refuse.
      if (err instanceof AccessFeatureUnavailable) return NextResponse.json({ state: "active" });
      throw err;
    }

    switch (admission.state) {
      case "active":
        return NextResponse.json({ state: "active" });
      case "no_session_claim":
        return NextResponse.json({ state: admission.enforcement === "register" ? "active" : "revoked" });
      case "rejected":
        return NextResponse.json({
          state: "rejected",
          maxSessions: admission.max_sessions ?? null,
          sessions: await listOwnSessions(supabase),
        });
      case "college_unavailable": {
        const access = await readAccessState(supabase);
        return NextResponse.json({
          state: "college_unavailable",
          collegeState: admission.college_state ?? access?.college_state ?? "SUSPENDED",
          collegeName: access?.college_name ?? null,
          message: access?.message ?? null,
          expectedResumeAt: access?.expected_resume_at ?? null,
        });
      }
      case "inactive":
        return NextResponse.json({ state: "inactive" });
      default:
        return NextResponse.json({ state: "revoked" });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
