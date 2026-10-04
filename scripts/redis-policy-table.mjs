#!/usr/bin/env node
/**
 * Prints the complete rate-limit policy table (brief §23) from the code
 * itself: every bucket the application asks for, its limit and window as
 * written at the call site, its risk class, and what happens when Redis
 * cannot answer. Markdown on stdout.
 *
 *   node scripts/redis-policy-table.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const policySrc = readFileSync("lib/rate-limit-policy.ts", "utf8");
const failOpenBlock = policySrc.slice(policySrc.indexOf("export const FAIL_OPEN"), policySrc.indexOf("};", policySrc.indexOf("export const FAIL_OPEN")));
const FAIL_OPEN = new Set([...failOpenBlock.matchAll(/^\s+([A-Za-z]+):\s*"/gm)].map((m) => m[1]));
const highBlock = policySrc.slice(policySrc.indexOf("export const HIGH_RISK"), policySrc.indexOf("] as const", policySrc.indexOf("export const HIGH_RISK")));
const HIGH = new Set([...highBlock.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]));
const FLOOD = new Set(["ip", "ipCredentialed", "user"]);

function files(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const f = join(dir, e);
    statSync(f).isDirectory() ? files(f, acc) : /\.(ts|tsx)$/.test(e) && acc.push(f);
  }
  return acc;
}

const buckets = new Map();
for (const f of [...files("app"), ...files("lib")]) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/checkRateLimit\(\s*`([^`]+)`\s*,\s*([^,]+),\s*([^)]+)\)/g)) {
    let name = m[1].split(":")[0];
    if (name.startsWith("${")) name = "activate / close (academic period transitions)";
    const entry = buckets.get(name) ?? { limits: new Set(), files: new Set() };
    entry.limits.add(`${m[2].trim()} / ${m[3].trim()} s`);
    entry.files.add(f.split(String.fromCharCode(92)).join("/").replace("app/(portal)/", ""));
    buckets.set(name, entry);
  }
}
const mw = readFileSync("lib/supabase/middleware.ts", "utf8");
const lim = (n) => mw.match(new RegExp(`export const ${n} = (\\d+)`))[1];
buckets.set("ip", { limits: new Set([`${lim("ANONYMOUS_IP_LIMIT")} / 60 s`]), files: new Set(["lib/supabase/middleware.ts"]) });
buckets.set("ipCredentialed", { limits: new Set([`${lim("CREDENTIALED_IP_LIMIT")} / 60 s`]), files: new Set(["lib/supabase/middleware.ts"]) });
buckets.set("user", { limits: new Set([`${lim("USER_LIMIT")} / 60 s`]), files: new Set(["lib/supabase/middleware.ts"]) });

const cls = (n) => (FLOOD.has(n) ? "flood" : FAIL_OPEN.has(n) ? "low" : HIGH.has(n) || n.startsWith("activate") ? "high" : "protected");
const behaviour = (c) => (c === "flood" || c === "low" ? "allowed (logged fail_open)" : "refused, 503 (logged fail_closed)");
const order = { flood: 0, low: 1, high: 2, protected: 3 };
const rows = [...buckets].sort((a, b) => order[cls(a[0])] - order[cls(b[0])] || a[0].localeCompare(b[0]));

console.log("| Bucket | Risk class | Limit / window | Redis unavailable, timeout, malformed, circuit open |");
console.log("|---|---|---|---|");
for (const [name, e] of rows) {
  console.log(`| \`${name}\` | ${cls(name)} | ${[...e.limits].join("; ")} | ${behaviour(cls(name))} |`);
}
const counts = rows.reduce((acc, [n]) => ((acc[cls(n)] = (acc[cls(n)] ?? 0) + 1), acc), {});
console.log(`\n${rows.length} buckets: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}. Unknown buckets are protected (refused).`);
