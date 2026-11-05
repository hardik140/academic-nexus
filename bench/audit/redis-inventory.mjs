#!/usr/bin/env node
/**
 * Redis inventory: every cached read, rate-limit check, invalidation and
 * other Redis-adjacent dependency in app/ and lib/, as JSON
 * (bench/results/redis-inventory.json) plus a summary on stdout.
 *
 * Static analysis of the source, not a runtime trace. Fields that are
 * inferred rather than read are named as such.
 *
 * Usage: node bench/audit/redis-inventory.mjs
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const SEP = String.fromCharCode(92);
function files(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) files(full, acc);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) acc.push(full.split(SEP).join("/"));
  }
  return acc;
}

function skipString(src, i) {
  const q = src[i];
  for (i++; i < src.length && src[i] !== q; i++) if (src[i] === SEP) i++;
  return i;
}

/** Index of the parenthesis closing the one opened at `open`. Skips strings and comments. */
function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); if (i < 0) return src.length; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i); continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return src.length;
}

/** Split a call's argument list at top-level commas. */
function args(text) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(text, i); continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  out.push(text.slice(start).trim());
  return out;
}

function enclosingFunction(src, index) {
  const before = src.slice(0, index);
  const re = /(?:export (?:default )?)?async function (\w+)/g;
  let m, name = "?";
  while ((m = re.exec(before))) name = m[1];
  return name;
}

const lineOf = (src, i) => src.slice(0, i).split("\n").length;
const isComment = (src, i) => {
  const pre = src.slice(src.lastIndexOf("\n", i) + 1, i).trim();
  return pre.startsWith("*") || pre.startsWith("//") || pre.startsWith("/*") || pre.startsWith("import");
};

/** Query chains in a fetcher body: `.from("t")` up to the next `.from(` / `.rpc(`. */
function queries(body) {
  const out = [];
  const hits = [...body.matchAll(/\.(from|rpc)\(\s*["'`]([\w.]+)["'`]/g)];
  hits.forEach((h, k) => {
    const end = k + 1 < hits.length ? hits[k + 1].index : body.length;
    const chain = body.slice(h.index, end);
    const head = /head:\s*true/.test(chain);
    const bounded = head || /\.(range|limit|single|maybeSingle)\(/.test(chain) || h[1] === "rpc";
    out.push({ kind: h[1], target: h[2], countOnly: head, bounded, exactCount: /count:\s*"exact"/.test(chain) });
  });
  return out;
}

// --- registry scopes (tests/cache-scope-registry.test.ts) -------------------
const registrySrc = readFileSync("tests/cache-scope-registry.test.ts", "utf8");
const registry = {};
for (const m of registrySrc.matchAll(/\[`\$\{P\}([^`]+)`\]:\s*\{\s*scope:\s*"(\w+)",\s*roles:\s*(\[[^\]]*\]|"route")/g)) {
  registry[`app/(portal)/${m[1]}`] = {
    scope: m[2],
    roles: m[3] === '"route"' ? "route" : [...m[3].matchAll(/"(\w+)"/g)].map((x) => x[1]),
  };
}
registry["lib/supabase/middleware.ts#updateSession"] = { scope: "user", roles: "route" };

// --- rate-limit policy (scripts/redis-policy-table.mjs) ---------------------
const policy = {};
for (const line of execSync("node scripts/redis-policy-table.mjs").toString().split("\n")) {
  const m = line.match(/^\| `([^`]+)` \| (\w+) \| (\d+) \/ (\d+) s \|/);
  if (m) policy[m[1]] = { riskClass: m[2], limit: +m[3], windowSeconds: +m[4] };
}

const cacheReads = [], rateLimits = [], invalidations = [];
for (const file of [...files("app"), ...files("lib")]) {
  if (["lib/cache.ts", "lib/rate-limit.ts", "lib/redis-guard.ts"].includes(file)) continue;
  const src = readFileSync(file, "utf8");

  for (const m of src.matchAll(/getCached\(/g)) {
    if (isComment(src, m.index)) continue;
    const close = matchParen(src, m.index + "getCached".length);
    const a = args(src.slice(m.index + "getCached(".length, close));
    const fn = enclosingFunction(src, m.index);
    const qs = queries(a[2] ?? "");
    const id = `${file}#${fn}`;
    const fnStart = src.lastIndexOf(`function ${fn}`, m.index);
    const fnHead = src.slice(Math.max(0, fnStart), m.index);
    const keyExpr = a[0].replace(/\s+/g, " ");
    const keyVar = keyExpr.match(/^(\w+)$/)?.[1];
    const keyDef = keyVar
      ? fnHead.match(new RegExp(`const ${keyVar}\\s*=\\s*([^;]+);`))?.[1]?.replace(/\s+/g, " ")
      : undefined;
    const keyText = keyDef ?? keyExpr;
    const versioned = /versionedKey\(|CacheKey\(|FAMILY/.test(keyText);
    cacheReads.push({
      id,
      file,
      line: lineOf(src, m.index),
      function: fn,
      category: "A. cache (read-through, cache-aside)",
      operations: versioned ? ["MGET value+version", "SET EX on miss"] : ["GET", "SET EX on miss"],
      dataStructure: "string (JSON)",
      keyExpression: keyExpr,
      keyDefinition: keyDef ?? null,
      ttlSeconds: Number(a[1]) || a[1],
      versioned,
      options: a[3] ?? null,
      registryScope: registry[id]?.scope ?? "UNREGISTERED",
      roles: registry[id]?.roles ?? null,
      buildScoped: !/MIDDLEWARE_PROFILE_CACHE|buildScoped:\s*false/.test(a[3] ?? ""),
      environmentScoped: true,
      paginated: /listCacheKey\(|page|q\.page/.test(keyText),
      dbQueriesOnMiss: qs.length,
      unboundedQueries: qs.filter((q) => !q.bounded).map((q) => q.target),
      exactCounts: qs.filter((q) => q.exactCount).length,
      queries: qs,
      failurePolicy: "fail open to the database (cache bypass), bounded by REDIS_TIMEOUT_MS",
      dbFallback: true,
      latencyBudgetMs: 1000,
      stampedeProtection: "none",
    });
  }

  for (const m of src.matchAll(/checkRateLimit\(/g)) {
    if (isComment(src, m.index)) continue;
    if (/function\s+$/.test(src.slice(m.index - 12, m.index))) continue;
    const close = matchParen(src, m.index + "checkRateLimit".length);
    const a = args(src.slice(m.index + "checkRateLimit(".length, close));
    const bucket = a[0].match(/^[`"']([A-Za-z]+)/)?.[1] ?? a[0];
    const identity = /actor\.userId|user\.id|userId|\.id\b/.test(a[0])
      ? "user"
      : /ip/i.test(a[0])
        ? "ip"
        : "other";
    const riskClass = policy[bucket]?.riskClass ?? "see policy table";
    rateLimits.push({
      file,
      line: lineOf(src, m.index),
      function: enclosingFunction(src, m.index),
      category: "B. rate limiting",
      operations: ["EVALSHA sliding-window script (EVAL once on NOSCRIPT)"],
      dataStructure: "2 strings (current + previous window counters)",
      keyExpression: a[0].replace(/\s+/g, " "),
      bucket,
      identity,
      limit: a[1],
      windowSeconds: a[2],
      riskClass,
      failurePolicy: ["flood", "low"].includes(riskClass) ? "fail open (logged)" : "fail closed (503)",
      ttl: "library-managed: window x 2 + 1 s",
      consistency: "atomic per key (one Lua script)",
    });
  }

  for (const m of src.matchAll(/invalidateCache(Family)?\(/g)) {
    if (isComment(src, m.index)) continue;
    if (/function\s+$/.test(src.slice(m.index - 12, m.index))) continue;
    const name = m[1] ? "invalidateCacheFamily" : "invalidateCache";
    const close = matchParen(src, m.index + name.length);
    const a = args(src.slice(m.index + name.length + 1, close));
    invalidations.push({
      file,
      line: lineOf(src, m.index),
      function: enclosingFunction(src, m.index),
      category: "A. cache invalidation",
      operations: m[1] ? ["INCR + EXPIRE 86400 (one pipeline)"] : ["DEL"],
      target: a.join(", ").replace(/\s+/g, " "),
      failurePolicy: "fail open: a failed invalidation leaves the entry until its TTL",
    });
  }
}

const adjacent = [
  { name: "QStash (Upstash scheduler)", category: "I. scheduled background work", where: "app/api/cron/*/route.ts", note: "signed HTTP callbacks; not Redis; at-least-once delivery" },
  { name: "Workers KV NEXT_CACHE_WORKERS_KV", category: "A. cache (OpenNext incremental cache)", where: "wrangler.jsonc", note: "Next data/ISR cache; not Redis" },
  { name: "pg_advisory_xact_lock in register_current_session", category: "C/H. lock + session coordination", where: "supabase/migrations/054_session_registry.sql", note: "device-limit race handled in PostgreSQL" },
  { name: "assertClaimed compare-and-swap", category: "D/E. idempotency + dedup", where: "lib/concurrent-claim.ts", note: "approval races handled in PostgreSQL" },
];

const out = {
  generatedAt: new Date().toISOString(),
  commit: execSync("git rev-parse --short HEAD").toString().trim(),
  method: "static analysis of app/ and lib/ (bench/audit/redis-inventory.mjs)",
  cacheReads,
  rateLimits,
  invalidations,
  adjacent,
};
writeFileSync("bench/results/redis-inventory.json", JSON.stringify(out, null, 2) + "\n");

const ttl = {};
for (const c of cacheReads) ttl[c.ttlSeconds] = (ttl[c.ttlSeconds] ?? 0) + 1;
const byIdentity = {};
for (const r of rateLimits) byIdentity[r.identity] = (byIdentity[r.identity] ?? 0) + 1;
console.log(`cache reads: ${cacheReads.length} (versioned ${cacheReads.filter((c) => c.versioned).length}, unregistered ${cacheReads.filter((c) => c.registryScope === "UNREGISTERED").length})`);
console.log(`  TTL histogram: ${JSON.stringify(ttl)}`);
console.log(`  scopes: ${JSON.stringify(cacheReads.reduce((s, c) => ((s[c.registryScope] = (s[c.registryScope] ?? 0) + 1), s), {}))}`);
console.log(`  with an unbounded query on miss: ${cacheReads.filter((c) => c.unboundedQueries.length).length}`);
console.log(`  DB queries per miss: total ${cacheReads.reduce((s, c) => s + c.dbQueriesOnMiss, 0)}, max ${Math.max(...cacheReads.map((c) => c.dbQueriesOnMiss))}`);
console.log(`rate-limit call sites: ${rateLimits.length}; by identity ${JSON.stringify(byIdentity)}`);
for (const r of rateLimits.filter((r) => r.identity !== "user")) console.log(`  non-user key: ${r.file}:${r.line} ${r.keyExpression}`);
console.log(`invalidation call sites: ${invalidations.length} (family ${invalidations.filter((i) => i.operations[0].startsWith("INCR")).length}, exact DEL ${invalidations.filter((i) => i.operations[0] === "DEL").length})`);
for (const c of cacheReads.filter((c) => c.unboundedQueries.length)) console.log(`  unbounded: ${c.id} ttl=${c.ttlSeconds} -> ${c.unboundedQueries.join(", ")}`);
