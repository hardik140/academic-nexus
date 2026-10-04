import { describe, it, expect } from "vitest";
import { planSecretSync, PRODUCTION_ONLY_KEYS } from "../scripts/sync-cf-secrets.mjs";

/**
 * Redis credential isolation (Redis audit finding E2): the production
 * Worker's Upstash credentials come from .env.production.local only, and
 * never name the database development uses.
 */

type Plan = {
  upload: { key: string; from: string }[];
  skipped: { key: string; reason: string }[];
  refused: { key: string; reason: string }[];
};
const plan = (dev: Record<string, string>, prod: Record<string, string> | null) => planSecretSync(dev, prod) as Plan;

const DEV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
  UPSTASH_REDIS_REST_URL: "https://dev-db-11111.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "dev-token",
};

describe("Upstash credentials are production-only keys", () => {
  it("never uploads Upstash credentials from .env.local", () => {
    const p = plan(DEV, null);
    expect(p.upload.map((u) => u.key)).not.toContain("UPSTASH_REDIS_REST_URL");
    expect(p.upload.map((u) => u.key)).not.toContain("UPSTASH_REDIS_REST_TOKEN");
    expect(p.skipped.filter((s) => PRODUCTION_ONLY_KEYS.includes(s.key))).toHaveLength(2);
    expect(p.refused).toEqual([]);
  });

  it("uploads them from .env.production.local when they name a different database", () => {
    const p = plan(DEV, { UPSTASH_REDIS_REST_URL: "https://prod-db-22222.upstash.io", UPSTASH_REDIS_REST_TOKEN: "prod-token" });
    expect(p.upload.filter((u) => u.from === ".env.production.local").map((u) => u.key)).toEqual(PRODUCTION_ONLY_KEYS);
    expect(p.refused).toEqual([]);
  });

  it("refuses the shared database under a new file name", () => {
    const p = plan(DEV, { UPSTASH_REDIS_REST_URL: "https://DEV-DB-11111.upstash.io/", UPSTASH_REDIS_REST_TOKEN: "other-token" });
    expect(p.refused.map((r) => r.key)).toEqual(["UPSTASH_REDIS_REST_URL"]);
    expect(p.upload.some((u) => u.from === ".env.production.local")).toBe(false);
  });

  it("refuses an identical token", () => {
    const p = plan(DEV, { UPSTASH_REDIS_REST_URL: "https://prod-db-22222.upstash.io", UPSTASH_REDIS_REST_TOKEN: "dev-token" });
    expect(p.refused.map((r) => r.key)).toEqual(["UPSTASH_REDIS_REST_TOKEN"]);
  });

  it("skips, rather than half-uploads, when only one of the pair is set", () => {
    const p = plan(DEV, { UPSTASH_REDIS_REST_URL: "https://prod-db-22222.upstash.io" });
    expect(p.upload.some((u) => u.from === ".env.production.local")).toBe(false);
    expect(p.skipped.filter((s) => PRODUCTION_ONLY_KEYS.includes(s.key))).toHaveLength(2);
  });

  it("refuses a production URL that is not a URL", () => {
    const p = plan(DEV, { UPSTASH_REDIS_REST_URL: "not a url", UPSTASH_REDIS_REST_TOKEN: "prod-token" });
    expect(p.refused.map((r) => r.key)).toEqual(["UPSTASH_REDIS_REST_URL"]);
  });

  it("still syncs every other secret from .env.local", () => {
    expect(plan(DEV, null).upload).toEqual([{ key: "NEXT_PUBLIC_SUPABASE_URL", from: ".env.local" }]);
  });

  it("never puts a value in the plan", () => {
    const text = JSON.stringify(plan(DEV, { UPSTASH_REDIS_REST_URL: "https://prod-db-22222.upstash.io", UPSTASH_REDIS_REST_TOKEN: "prod-token" }));
    for (const secret of ["dev-token", "prod-token", "upstash.io", "supabase.co"]) expect(text).not.toContain(secret);
  });
});
