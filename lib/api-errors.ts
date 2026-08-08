import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { RbacError } from "@/lib/rbac";
import { RateLimitError } from "@/lib/rate-limit";

/**
 * Shared catch-block handler for every app/api/mobile/* Route Handler.
 * Same error → status mapping every route already implemented individually;
 * consolidated here once Zod validation added a fourth case (bad request
 * shape) that every route needed identically.
 */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof RbacError) {
    const status = err.code === "UNAUTHENTICATED" ? 401 : err.code === "INACTIVE" ? 403 : 403;
    return NextResponse.json({ error: err.message }, { status });
  }
  if (err instanceof RateLimitError) {
    return NextResponse.json({ error: err.message }, { status: 429 });
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: err.issues[0]?.message || "Invalid request." },
      { status: 400 }
    );
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Request failed." },
    { status: 400 }
  );
}
