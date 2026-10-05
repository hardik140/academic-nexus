import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The middleware caches each user's { role, college_id, status } for 20 s
 * (lib/supabase/middleware.ts). A role or status change must take effect on
 * the next request, so every function that writes either column — or
 * activates an invited account — must delete that entry, with the shared
 * (non-build-scoped) options so the delete reaches every running build.
 *
 * The cache is never the security boundary (requireRole() and RLS re-read
 * live), but a stale entry would keep serving a suspended user the portal
 * shell; this pins the invalidation that prevents it.
 */

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

/** Top-level function bodies, by name. */
function functions(src: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /^export (?:default )?async function (\w+)|^async function (\w+)/gm;
  const starts = [...src.matchAll(re)].map((m) => ({ name: m[1] ?? m[2], at: m.index! }));
  starts.forEach((s, i) => out.push({ name: s.name, body: src.slice(s.at, starts[i + 1]?.at ?? src.length) }));
  return out;
}

const WRITES_ROLE_OR_STATUS = /from\("profiles"\)\s*\.update\(\{[^}]*\b(role|status)\b/;
const ACTIVATES_INVITEE = /rpc\("accept_student_invitation"/;
const INVALIDATES = /invalidateCache\(middlewareProfileCacheKey\([^)]*\), MIDDLEWARE_PROFILE_CACHE\)/;

const writers: Array<{ id: string; body: string }> = [];
for (const full of sourceFiles("app")) {
  const src = readFileSync(full, "utf8");
  for (const fn of functions(src)) {
    if (WRITES_ROLE_OR_STATUS.test(fn.body) || ACTIVATES_INVITEE.test(fn.body)) {
      writers.push({ id: `${full.split(String.fromCharCode(92)).join("/")}#${fn.name}`, body: fn.body });
    }
  }
}

describe("every role/status write invalidates the middleware's cached profile", () => {
  it("finds the writers (guards the scan)", () => {
    const ids = writers.map((w) => w.id).join("\n");
    expect(ids).toMatch(/admin\/users\/actions\.ts#updateUserProfile/);
    expect(ids).toMatch(/admin\/users\/actions\.ts#updateUserStatus/);
    expect(ids).toMatch(/director\/placement-cell\/actions\.ts#/);
    expect(ids).toMatch(/auth\/accept-invite\/actions\.ts#/);
  });

  it.each(writers.map((w) => [w.id, w.body] as const))("%s", (_id, body) => {
    expect(body).toMatch(INVALIDATES);
  });
});
