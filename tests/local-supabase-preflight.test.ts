import { describe, it, expect } from "vitest";
import { checkLocalTarget, PRODUCTION_REF } from "../scripts/local-supabase-preflight.mjs";

/**
 * The guard in front of every database-writing run against local Supabase:
 * only a positively identified loopback target passes; the production
 * project, an unknown host, or a missing setting is refused.
 */
const local = {
  TARGET_ENV: "local",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_DB_URL: "postgresql://postgres:secret@127.0.0.1:54322/postgres",
};

describe("checkLocalTarget", () => {
  it("accepts a local stack and reports host:port only, never credentials", () => {
    const r = checkLocalTarget(local);
    expect(r).toEqual({ ok: true, targets: ["NEXT_PUBLIC_SUPABASE_URL=127.0.0.1:54321", "SUPABASE_DB_URL=127.0.0.1:54322"] });
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(checkLocalTarget({ ...local, NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321", SUPABASE_DB_URL: undefined }).ok).toBe(true);
  });

  it("refuses the production project, by URL or by database URL", () => {
    expect(checkLocalTarget({ ...local, NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co` })).toMatchObject({ ok: false, reason: expect.stringMatching(/production/) });
    expect(checkLocalTarget({ ...local, SUPABASE_DB_URL: `postgresql://postgres:x@db.${PRODUCTION_REF}.supabase.co:5432/postgres` })).toMatchObject({ ok: false, reason: expect.stringMatching(/production/) });
  });

  it("refuses an unknown host even when TARGET_ENV says local", () => {
    expect(checkLocalTarget({ ...local, NEXT_PUBLIC_SUPABASE_URL: "https://other-project.supabase.co" })).toMatchObject({ ok: false, reason: expect.stringMatching(/not a local endpoint/) });
    expect(checkLocalTarget({ ...local, SUPABASE_DB_URL: "postgresql://u:p@10.0.0.5:5432/db" })).toMatchObject({ ok: false });
    expect(checkLocalTarget({ ...local, NEXT_PUBLIC_SUPABASE_URL: "127.0.0.1:54321" })).toMatchObject({ ok: false });
  });

  it("refuses missing or unlabelled configuration", () => {
    expect(checkLocalTarget({})).toMatchObject({ ok: false });
    expect(checkLocalTarget({ ...local, TARGET_ENV: undefined })).toMatchObject({ ok: false, reason: expect.stringMatching(/TARGET_ENV/) });
    expect(checkLocalTarget({ ...local, TARGET_ENV: "staging" })).toMatchObject({ ok: false });
    expect(checkLocalTarget({ ...local, NEXT_PUBLIC_SUPABASE_URL: "" })).toMatchObject({ ok: false, reason: expect.stringMatching(/missing/) });
  });
});
