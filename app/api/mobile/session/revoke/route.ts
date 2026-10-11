import { NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateRequest } from "@/lib/rbac";
import { errorResponse } from "@/lib/api-errors";
import { callAccessRpc } from "@/lib/college-access";
import type { Database } from "@/types/database";

const Body = z.object({
  sessionId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Invalid session."),
});

/**
 * POST /api/mobile/session/revoke — sign out one of the user's OWN other
 * devices, including from a session the device limit rejected. The
 * database (revoke_session) decides; it refuses anyone else's session.
 */
export async function POST(request: Request) {
  try {
    const { sessionId } = Body.parse(await request.json());
    const { supabase } = await authenticateRequest(request);
    await callAccessRpc(supabase as unknown as SupabaseClient<Database>, "revoke_session", { p_session_id: sessionId }, "That device couldn't be signed out.");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
