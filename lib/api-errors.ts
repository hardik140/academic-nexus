import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { RbacError } from "@/lib/rbac";
import { RateLimitError } from "@/lib/rate-limit";
import { InternalOperationError, looksInternal } from "@/lib/internal-error";

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
  // InternalOperationError already carries a message that discloses
  // nothing (lib/internal-error.ts), and dbError() has already logged the
  // real fault with its call site.
  if (err instanceof InternalOperationError) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  // Everything else that reaches here is a deliberate, human-written
  // business message from a server action — "This gate pass must be
  // approved before an exit can be recorded." — and those are meant to be
  // read, so they still pass through.
  //
  // Two exceptions. A non-Error throw has no message worth trusting, and a
  // message that unmistakably describes the database is redacted whatever
  // threw it. That second check is a backstop, not the fix: F-002 is closed
  // at the ~102 call sites that used to throw `error.message`. This is what
  // stops a future one from reopening it silently.
  if (!(err instanceof Error)) {
    console.error("[internal] non-Error thrown to a route handler", err);
    return NextResponse.json({ error: "Request failed." }, { status: 400 });
  }

  if (looksInternal(err.message)) {
    console.error("[internal] redacted an internal message at the response boundary", {
      message: err.message,
      at: err.stack?.split("\n")[1]?.trim(),
    });
    return NextResponse.json({ error: new InternalOperationError().message }, { status: 500 });
  }

  return NextResponse.json({ error: err.message }, { status: 400 });
}
