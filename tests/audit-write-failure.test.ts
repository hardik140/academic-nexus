import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logAudit } from "@/lib/audit";
import type { AuthorizedActor } from "@/lib/rbac";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * A-001 — a lost audit record used to leave no trace at all.
 *
 * logAudit was a bare `await supabase.from("audit_logs").insert(...)`. The
 * Supabase client does not throw on a rejected write — it RESOLVES, with the
 * failure sitting in `error`. Nobody read it. So an RLS denial, a constraint
 * violation or a dropped connection produced: no exception, no log line, no
 * return value, and a mutation that had already happened with no record that
 * it did.
 *
 * That is precisely the state an audit trail exists to make impossible, and
 * it was silent by construction.
 */

const ACTOR: AuthorizedActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  role: "finance",
  collegeId: "22222222-2222-4222-8222-222222222222",
};

/** Minimal Supabase stand-in: one insert, one recorded call, one outcome. */
function supabaseReturning(outcome: { error: { message: string; code?: string } | null }) {
  const insert = vi.fn(async () => outcome);
  const from = vi.fn(() => ({ insert }));
  return { client: { from } as unknown as SupabaseClient<Database>, from, insert };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a successful audit write", () => {
  it("reports success and writes the full entry", async () => {
    const db = supabaseReturning({ error: null });

    const ok = await logAudit(db.client, ACTOR, "payment_recorded", "payments", "pay-1", {
      oldValue: null,
      newValue: { amount: 5000 },
    });

    expect(ok).toBe(true);
    expect(db.from).toHaveBeenCalledWith("audit_logs");
    expect(db.insert).toHaveBeenCalledWith({
      college_id: ACTOR.collegeId,
      user_id: ACTOR.userId,
      action: "payment_recorded",
      table_name: "payments",
      record_id: "pay-1",
      old_value: null,
      new_value: { amount: 5000 },
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("still defaults old/new value to null when the caller passes none", async () => {
    const db = supabaseReturning({ error: null });
    await logAudit(db.client, ACTOR, "x", "payments", "pay-2");
    expect(db.insert).toHaveBeenCalledWith(expect.objectContaining({ old_value: null, new_value: null }));
  });
});

describe("a FAILED audit write", () => {
  it("reports failure instead of resolving as though it had worked", async () => {
    const db = supabaseReturning({ error: { message: "new row violates row-level security policy", code: "42501" } });
    expect(await logAudit(db.client, ACTOR, "payment_recorded", "payments", "pay-1")).toBe(false);
  });

  it("logs everything needed to reconstruct the missing entry by hand", async () => {
    const db = supabaseReturning({ error: { message: "new row violates row-level security policy", code: "42501" } });
    await logAudit(db.client, ACTOR, "payment_recorded", "payments", "pay-1");

    expect(errorSpy).toHaveBeenCalledOnce();
    const [label, payload] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(label).toMatch(/audit/i);
    // The operator has to be able to tell that the CHANGE still happened —
    // the dangerous reading of this line is "nothing occurred".
    expect(label).toMatch(/did happen/i);
    expect(payload).toMatchObject({
      action: "payment_recorded",
      table: "payments",
      recordId: "pay-1",
      actor: ACTOR.userId,
      college: ACTOR.collegeId,
      code: "42501",
    });
  });

  it("does not throw — the mutation it describes has already committed", async () => {
    // Turning a lost audit row into a thrown error would report a successful
    // operation as failed, and the caller's natural response (retry) would
    // perform it a second time. A duplicated payment is worse than a missing
    // audit line, so this deliberately returns rather than throws.
    const db = supabaseReturning({ error: { message: "connection terminated" } });
    await expect(logAudit(db.client, ACTOR, "payment_recorded", "payments", "pay-1")).resolves.toBe(false);
  });
});
