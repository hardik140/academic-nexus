// Refuses any database-writing test run whose target is not a LOCAL Supabase
// stack. Run it first, or import checkLocalTarget():
//
//   node scripts/local-supabase-preflight.mjs        (reads .env.staging.local)
//
// Positive identification only: TARGET_ENV must say "local" AND every
// configured endpoint must be a loopback host. The production-equivalent
// project (owner decision D3) is named and refused outright. Credentials are
// never printed — only the host and port that were checked.

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const PRODUCTION_REF = "ykcsqqpsfapdsjghzwhq";
export const STAGING_ENV_FILE = ".env.staging.local";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const ENDPOINT_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_DB_URL"];

/** @returns {{ ok: true, targets: string[] } | { ok: false, reason: string }} */
export function checkLocalTarget(env) {
  if (env.TARGET_ENV !== "local") return { ok: false, reason: "TARGET_ENV is not \"local\"" };
  if (!env.NEXT_PUBLIC_SUPABASE_URL) return { ok: false, reason: "NEXT_PUBLIC_SUPABASE_URL is missing" };
  const targets = [];
  for (const key of ENDPOINT_KEYS) {
    const value = env[key];
    if (!value) continue;
    if (value.includes(PRODUCTION_REF)) return { ok: false, reason: `${key} names the production project` };
    let url;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, reason: `${key} is not a URL` };
    }
    if (!LOOPBACK.has(url.hostname)) return { ok: false, reason: `${key} is not a local endpoint (${url.hostname})` };
    targets.push(`${key}=${url.hostname}:${url.port || "default"}`);
  }
  return { ok: true, targets };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (!existsSync(STAGING_ENV_FILE)) {
    console.error(`REFUSED: ${STAGING_ENV_FILE} not found; nothing falls back to .env.local.`);
    process.exit(1);
  }
  const { parse } = await import("dotenv");
  const { readFileSync } = await import("node:fs");
  const result = checkLocalTarget(parse(readFileSync(STAGING_ENV_FILE)));
  if (!result.ok) {
    console.error(`REFUSED: ${result.reason}.`);
    process.exit(1);
  }
  console.log(`OK: local target — ${result.targets.join(", ")}`);
}
