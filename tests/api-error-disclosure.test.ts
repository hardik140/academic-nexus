import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ZodError, z } from "zod";
import { errorResponse } from "@/lib/api-errors";
import { RbacError } from "@/lib/rbac";
import { RateLimitError } from "@/lib/rate-limit";
import { dbError, looksInternal, InternalOperationError } from "@/lib/internal-error";

/**
 * F-002 — what a failed request is allowed to tell the caller.
 *
 * Route handlers used to answer an unrecognised Error by returning its
 * message verbatim, and 102 server-action call sites built that message
 * out of a Supabase error object. The result was that roughly thirty
 * mobile endpoints would describe the database — constraint names,
 * function signatures, column names — to anyone holding a valid token.
 *
 * These tests fix the BOUNDARY behaviour in place. They deliberately do
 * not assert on any particular route: routes come and go, and the property
 * that matters is that the one function all of them funnel through cannot
 * be made to emit database internals.
 */

const realError = console.error;
beforeEach(() => { console.error = vi.fn(); });
afterEach(() => { console.error = realError; });

/** The exact strings PostgREST relays from PostgreSQL. */
const POSTGRES_MESSAGES = [
  'duplicate key value violates unique constraint "idx_gm_one_per_direction"',
  'new row for relation "gate_movements" violates check constraint "gm_scan_has_gate"',
  'permission denied for table gate_pass_credentials',
  'permission denied for function expire_stale_gate_credentials',
  'relation "security_personnel" does not exist',
  'column "nonce" does not exist',
  'function public.record_gate_movement(uuid, uuid, jsonb) does not exist',
  'invalid input syntax for type uuid: "not-a-uuid"',
  'could not serialize access due to concurrent update',
  'deadlock detected',
  'insert or update on table "payments" violates foreign key constraint "payments_fee_context_fkey"',
];

/** Nothing recognisable from the schema may appear in any answer. */
const FORBIDDEN = [
  "constraint", "relation", "pg_", "PGRST", "uuid,", "public.",
  "gate_movements", "gate_pass_credentials", "security_personnel",
  "payments", "nonce", "SELECT", "INSERT", "node_modules",
];

async function body(res: Response): Promise<{ error?: string }> {
  return (await res.json()) as { error?: string };
}

describe("an internal database error", () => {
  it("reaches the caller as one flat sentence, whatever PostgreSQL said", async () => {
    for (const message of POSTGRES_MESSAGES) {
      const res = errorResponse(dbError({ message, code: "23505" }));
      const json = await body(res);

      expect(res.status).toBe(500);
      expect(json.error).toBe(new InternalOperationError().message);
      for (const leak of FORBIDDEN) {
        expect(json.error, `"${leak}" leaked from: ${message}`).not.toContain(leak);
      }
    }
  });

  it("is logged server-side in full, with its call site", () => {
    dbError({ message: 'permission denied for table fees', code: "42501", details: "d", hint: "h" });

    expect(console.error).toHaveBeenCalledOnce();
    const [label, payload] = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(label).toMatch(/internal/i);
    // The operator gets everything the caller did not.
    expect(payload.message).toBe("permission denied for table fees");
    expect(payload.code).toBe("42501");
    expect(payload.at).toBeTruthy();
  });

  it("never returns an empty or undefined message", async () => {
    for (const e of [{}, { message: "" }, null, undefined]) {
      const json = await body(errorResponse(dbError(e)));
      expect(json.error).toBeTruthy();
      expect(json.error!.length).toBeGreaterThan(20);
    }
  });
});

describe("a message the DATABASE wrote on purpose still reaches the caller", () => {
  // Migration triggers RAISE EXCEPTION with prose meant to be read by the
  // person who tripped them, and it arrives through exactly the same
  // `error.message` channel as a PostgreSQL internal. Flattening these
  // would hide legitimate authorization refusals — caught by
  // tests/privileged-writes.test.ts when the first version of dbError()
  // replaced every message unconditionally.
  const TRIGGER_MESSAGES = [
    "You cannot change your own role, status or department.",
    "gate_movements is an immutable ledger and cannot be deleted",
    "security_personnel: activation must record who authorized it",
    "A refund cannot exceed the outstanding balance.",
  ];

  it("passes through dbError unchanged, and is still logged", async () => {
    for (const message of TRIGGER_MESSAGES) {
      const err = dbError({ message, code: "P0001" });
      expect(err.message, `flattened a deliberate message: ${message}`).toBe(message);
      expect((await body(errorResponse(err))).error).toBe(message);
    }
    // every one of them still reached the operator log
    expect(console.error).toHaveBeenCalledTimes(TRIGGER_MESSAGES.length);
  });

  it("is still distinguished from an internal message on the same channel", () => {
    expect(dbError({ message: "permission denied for table fees" }).message).not.toContain("fees");
    expect(dbError({ message: "You cannot change your own role, status or department." }).message)
      .toContain("your own role");
  });
});

describe("a deliberate business error still reaches the person who caused it", () => {
  // The whole point of classifying rather than blanket-replacing: these are
  // written to be read, and hiding them would be a regression in its own
  // right.
  const BUSINESS = [
    "This gate pass must be approved before an exit can be recorded.",
    "This student is not in your hostel block.",
    "A refund cannot exceed the outstanding balance.",
    "Gate pass not found.",
  ];

  it("passes through unchanged", async () => {
    for (const message of BUSINESS) {
      const res = errorResponse(new Error(message));
      expect(res.status).toBe(400);
      expect((await body(res)).error).toBe(message);
    }
  });
});

describe("authorization and validation outcomes are unchanged", () => {
  it("keeps RbacError status codes and messages", async () => {
    const unauth = errorResponse(new RbacError("UNAUTHENTICATED", "No authenticated session."));
    expect(unauth.status).toBe(401);
    expect((await body(unauth)).error).toBe("No authenticated session.");

    const forbidden = errorResponse(new RbacError("FORBIDDEN", "Role 'student' is not permitted to perform this action."));
    expect(forbidden.status).toBe(403);
    expect((await body(forbidden)).error).toMatch(/not permitted/);
  });

  it("keeps rate limiting at 429", async () => {
    const res = errorResponse(new RateLimitError());
    expect(res.status).toBe(429);
    expect((await body(res)).error).toMatch(/too many requests/i);
  });

  it("keeps Zod validation at 400 with the field message", async () => {
    let zerr: ZodError | null = null;
    try { z.object({ gateId: z.string().uuid() }).parse({ gateId: "nope" }); }
    catch (e) { zerr = e as ZodError; }
    const res = errorResponse(zerr!);
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBeTruthy();
  });
});

describe("the response-boundary backstop", () => {
  // Not the control that closes F-002 — the call sites are. This is what
  // stops a future call site from reopening it silently.
  it("redacts a raw PostgreSQL message even when thrown as a plain Error", async () => {
    for (const message of POSTGRES_MESSAGES) {
      const res = errorResponse(new Error(message));
      const json = await body(res);
      expect(json.error, `not redacted: ${message}`).toBe(new InternalOperationError().message);
      expect(res.status).toBe(500);
    }
  });

  it("redacts anything carrying a stack trace", async () => {
    const withStack = new Error("boom\n    at Object.<anonymous> (/app/node_modules/pg/lib/client.js:1:1)");
    expect((await body(errorResponse(withStack))).error).toBe(new InternalOperationError().message);
  });

  it("does not mistake ordinary business prose for a database message", () => {
    for (const ok of [
      "This gate pass must be approved before an exit can be recorded.",
      "Only a warden or an administrator may record a manual movement.",
      "Select a gate before scanning.",
      "A revocation must record a reason.",
    ]) {
      expect(looksInternal(ok), `false positive: ${ok}`).toBe(false);
    }
  });

  it("refuses to trust a non-Error throw", async () => {
    for (const thrown of ["a bare string", 42, { message: "permission denied for table fees" }, null]) {
      const res = errorResponse(thrown);
      const json = await body(res);
      expect(json.error).toBe("Request failed.");
      for (const leak of FORBIDDEN) expect(json.error).not.toContain(leak);
    }
  });
});
