import { NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateRequest } from "@/lib/rbac";
import { errorResponse } from "@/lib/api-errors";
import { callAccessRpc } from "@/lib/college-access";
import type { Database } from "@/types/database";

const Body = z.object({ scope: z.enum(["global", "local"]).default("global") });

/**
 * POST /api/mobile/session/end — called by the app just before
 * supabase.auth.signOut(), mirroring its scope in the registry (migration
 * 054). Acts on the caller's own sessions only (end_my_sessions).
 */
export async function POST(request: Request) {
  try {
    const { scope } = Body.parse(await request.json().catch(() => ({})));
    const { supabase } = await authenticateRequest(request);
    await callAccessRpc(supabase as unknown as SupabaseClient<Database>, "end_my_sessions", { p_scope: scope }, "Sign-out could not be recorded.");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
