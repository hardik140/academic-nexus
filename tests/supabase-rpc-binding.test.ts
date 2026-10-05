import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { registerSession, readAccessState, listOwnSessions, callAccessRpc } from "@/lib/college-access";
import { academicRpc } from "@/lib/academic/rpc";
import { readAcademicContext } from "@/lib/academic/context";
import { callRpc } from "@/lib/gate-security/rpc";

/**
 * `supabase.rpc` must be CALLED ON ITS CLIENT.
 *
 * SupabaseClient.rpc is a prototype method whose body is
 * `return this.rest.rpc(...)`. Several helpers took it off the client to cast
 * away the hand-written types:
 *
 *   const rpc = supabase.rpc as unknown as (name: string) => ...;
 *   await rpc("register_current_session", ...);   // this === undefined
 *
 * which throws "Cannot read properties of undefined (reading 'rest')" on every
 * call. Unit tests never saw it — their fake clients' rpc is a plain function
 * — and no E2E test signs in against a real Supabase. On a real deployment it
 * meant: session admission threw on every signed-in request (the middleware
 * fails closed to /unavailable, every Server Action's requireRole() failed),
 * every academic and gate-security RPC failed, and the gate-credential expiry
 * cron failed.
 *
 * These tests use REAL clients (supabase-js and @supabase/ssr) with only the
 * network replaced, so a detached call fails here exactly as it would in
 * production.
 */

const URL_ = "https://qa-project.supabase.co";
const calls: string[] = [];
const fetchStub = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const fn = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
  if (fn) calls.push(fn);
  const body = fn === "register_current_session" ? { state: "active" } : fn === "my_access_state" ? { allowed: true } : fn === "list_my_sessions" ? [] : [];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const clients: Array<[string, () => SupabaseClient<Database>]> = [
  ["supabase-js createClient", () => createClient<Database>(URL_, "anon-key", { global: { fetch: fetchStub } })],
  [
    "@supabase/ssr createServerClient (what the app's server code uses)",
    () =>
      createServerClient<Database>(URL_, "anon-key", {
        cookies: { getAll: () => [], setAll: () => {} },
        global: { fetch: fetchStub },
      }) as unknown as SupabaseClient<Database>,
  ],
];

describe.each(clients)("every RPC helper works on a real client: %s", (_label, make) => {
  it("session admission and access state (lib/college-access.ts)", async () => {
    calls.length = 0;
    const c = make();
    expect((await registerSession(c, { client: "web" })).state).toBe("active");
    await readAccessState(c);
    await listOwnSessions(c);
    await callAccessRpc(c, "revoke_my_session", { p_session_id: "s" }, "x");
    expect(calls).toEqual(["register_current_session", "my_access_state", "list_my_sessions", "revoke_my_session"]);
  });

  it("academic RPCs (lib/academic/rpc.ts, lib/academic/context.ts)", async () => {
    calls.length = 0;
    const c = make();
    await academicRpc(c, "start_department_term", { p_department_id: "d" });
    await readAcademicContext(c);
    expect(calls).toEqual(["start_department_term", "my_academic_context"]);
  });

  it("gate-security RPCs (lib/gate-security/rpc.ts)", async () => {
    calls.length = 0;
    await callRpc(make(), "scan_gate_credential", { p_token: "t" });
    expect(calls).toEqual(["scan_gate_credential"]);
  });
});

describe("the defect itself, on the real client", () => {
  it("a detached rpc throws; a bound one does not", () => {
    const c = createClient(URL_, "anon-key", { global: { fetch: fetchStub } });
    const detached = c.rpc as unknown as (fn: string) => unknown;
    expect(() => detached("x")).toThrow(/reading 'rest'/);
    expect(() => c.rpc.bind(c)("x")).not.toThrow();
  });
});

describe("no code takes rpc off its client", () => {
  function sources(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) sources(full, acc);
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) acc.push(full);
    }
    return acc;
  }

  it("every `x.rpc as unknown as …` is either bound or called in place as `(x.rpc as …)(…)`", () => {
    const offenders: string[] = [];
    for (const file of [...sources("app"), ...sources("lib")]) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/(.)\s*(\w+)\.rpc as unknown as/g)) {
        // `(supabase.rpc as unknown as T)(...)` keeps `this`; anything else detaches it.
        if (m[1] !== "(") offenders.push(`${file}: ${m[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("a bound rpc runs as the signed-in user, so RLS sees that user", () => {
  it("every helper sends the session's own access token, not the anon key", async () => {
    const b64url = (s: string) => Buffer.from(s).toString("base64url");
    const accessToken = `${b64url('{"alg":"ES256","typ":"JWT"}')}.${b64url(
      JSON.stringify({ sub: "user-1", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })
    )}.sig`;
    const session = {
      access_token: accessToken,
      refresh_token: "r",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: "user-1", aud: "authenticated", role: "authenticated" },
    };
    const auth: Array<[string, string | null]> = [];
    const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const fn = String(input).match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
      if (fn) auth.push([fn, new Headers(init?.headers).get("authorization")]);
      return fetchStub(input, init);
    }) as typeof fetch;
    const c = createServerClient<Database>(URL_, "anon-key", {
      cookies: { getAll: () => [{ name: "sb-qa-project-auth-token", value: `base64-${b64url(JSON.stringify(session))}` }], setAll: () => {} },
      global: { fetch: recording },
    }) as unknown as SupabaseClient<Database>;

    await registerSession(c, { client: "web" });
    await readAccessState(c);
    await academicRpc(c, "start_department_term", { p_department_id: "d" });
    await callRpc(c, "scan_gate_credential", { p_token: "t" });

    expect(auth.map(([fn]) => fn)).toEqual(["register_current_session", "my_access_state", "start_department_term", "scan_gate_credential"]);
    for (const [, header] of auth) expect(header).toBe(`Bearer ${accessToken}`);
  });
});
