#!/usr/bin/env node
/**
 * Adversarial mutation run for the Redis hardening (brief §22). Each mutation
 * breaks one control on purpose; the named tests must FAIL. Every file is
 * restored byte-for-byte afterwards (checked by hash), whatever happens.
 *
 *   node scripts/redis-mutations.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const T = {
  integration: "tests/redis-integration.test.ts",
  keys: "tests/redis-keys-config.test.ts",
  cacheScope: "tests/cache-key-scope.test.ts",
  registry: "tests/cache-scope-registry.test.ts",
  policy: "tests/rate-limit-policy.test.ts",
  middleware: "tests/middleware-rate-limit.test.ts",
  admission: "tests/middleware-admission-profile.test.ts",
};

const MUTATIONS = [
  ["1. timeout result read as allowed", "lib/rate-limit.ts",
    'if (r.reason === "timeout") return "timeout";', "", [T.integration]],
  // The budget has three independent layers — the client's AbortSignal, the
  // guard's deadline race, and the limiter's own timeout — so "timeout
  // handling removed" removes all three; any one of them alone still bounds
  // the call (checked separately: removing two layers is not detected, by
  // design).
  ["2. timeout handling removed (all three layers)", "lib/redis-guard.ts",
    "const value = await Promise.race([run(redis), deadline]);", "void deadline; const value = await run(redis);", [T.integration],
    [["lib/rate-limit.ts", "timeout: redisTimeoutMs(),", "timeout: 5000,"],
     ["lib/redis.ts", "signal: () => AbortSignal.timeout(redisTimeoutMs()),", ""]]],
  ["3. retry count increased to 5", "lib/redis.ts",
    "export const REDIS_RETRIES = 1;", "export const REDIS_RETRIES = 5;", [T.integration]],
  ["4. environment prefix removed", "lib/redis-guard.ts",
    "return REDIS_NAMESPACE ? `${REDIS_NAMESPACE}:${category}:${rest}` : null;", "return REDIS_NAMESPACE ? `${category}:${rest}` : null;", [T.integration]],
  ["5. role removed from a role-sensitive cache key", "app/(portal)/placement-cell/records/actions.ts",
    "listCacheKey(RECORDS_CACHE_PREFIX, `${actor.collegeId}:${actor.role}`, q, column)", "listCacheKey(RECORDS_CACHE_PREFIX, actor.collegeId, q, column)", [T.registry]],
  ["6. cache version removed from versioned keys", "lib/cache.ts",
    "const versioned = opts?.family !== undefined && opts.scope !== undefined;", "const versioned = false;", [T.integration]],
  ["7. verified sessions spend the shared campus bucket again", "lib/supabase/middleware.ts",
    "? await limitedResponse(`user:${identity.userId}`, USER_LIMIT)", "? await limitedResponse(`ipCredentialed:${ipId}`, CREDENTIALED_IP_LIMIT)", [T.middleware]],
  ["8. search normalization removed (raw search in key)", "lib/cached-list.ts",
    "return `s${keyDigest(search.normalize(\"NFC\"))}`;", "return search;", [T.keys]],
  ["9. key-length limit removed", "lib/cached-list.ts",
    "if (search.length > MAX_CACHED_SEARCH_LENGTH) return null;", "", [T.keys]],
  ["10. unknown action fails open", "lib/rate-limit-policy.ts",
    'return bucketName(key) in FAIL_OPEN ? "allow" : "deny";', 'return "allow";', [T.policy, T.integration]],
  ["11. Redis failure returns success for a payment", "lib/rate-limit.ts",
    "  throw new RateLimiterUnavailableError();\n}", "}", [T.policy, T.integration]],
  ["12. cache shares an entry across users (missing scope accepted)", "lib/cache.ts",
    'const MISSING_SEGMENTS = new Set(["undefined", "null", "NaN", ""]);', "const MISSING_SEGMENTS = new Set<string>();", [T.cacheScope, T.keys]],
  ["13. development may use the production namespace", "lib/redis-config.ts",
    'if (environment === "production" && nodeEnv !== "production") {', "if (false) {", [T.keys]],
  ["14. the middleware ignores the account status admission returns", "lib/supabase/middleware.ts",
    "status: admission.profile_status as UserStatus,", 'status: "active" as UserStatus,', [T.admission]],
];

const sha = (s) => createHash("sha256").update(s).digest("hex");
const originals = new Map();
function snapshot(file) {
  if (!originals.has(file)) originals.set(file, readFileSync(file, "utf8"));
  return originals.get(file);
}
function apply(file, from, to, onlyFirst) {
  const src = snapshot(file);
  // The working copy may use CRLF (core.autocrlf); anchors are written with LF.
  const crlf = (s) => s.split("\n").join("\r\n");
  if (!src.includes(from) && src.includes(crlf(from))) {
    from = crlf(from);
    to = crlf(to);
  }
  if (!src.includes(from)) throw new Error(`${file}: mutation anchor not found: ${from.slice(0, 60)}`);
  writeFileSync(file, onlyFirst ? src.replace(from, to) : src.split(from).join(to));
}
function restoreAll() {
  for (const [file, src] of originals) writeFileSync(file, src);
}

const results = [];
try {
  for (const [name, file, from, to, tests, extra, onlyFirst] of MUTATIONS) {
    apply(file, from, to, onlyFirst === 1);
    if (extra) for (const [f, a, b] of Array.isArray(extra[0]) ? extra : [extra]) apply(f, a, b);
    let detected;
    try {
      execSync(`npx vitest run ${tests.join(" ")}`, { stdio: "pipe", timeout: 600_000 });
      detected = false;
    } catch {
      detected = true;
    }
    restoreAll();
    results.push({ name, detected });
    console.log(`${detected ? "DETECTED" : "SURVIVED"}  ${name}`);
  }
} finally {
  restoreAll();
}
for (const [file, src] of originals) {
  if (sha(readFileSync(file, "utf8")) !== sha(src)) throw new Error(`${file} was not restored`);
}
const survived = results.filter((r) => !r.detected);
console.log(`\n${results.length - survived.length}/${results.length} mutations detected; all files restored (hash-checked).`);
process.exit(survived.length ? 1 : 0);
