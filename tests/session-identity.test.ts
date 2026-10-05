import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import {
  accessTokenFrom,
  sessionIdentity,
  verifySessionToken,
  resetSessionIdentity,
  JWKS_TTL_MS,
  FAILURE_BACKOFF_MS,
} from "@/lib/auth/session-identity";
import { makeSigner, claims, hs256Token, sessionCookie, jwksFetch, SUPABASE_URL, type Signer } from "./support/session-tokens";

/**
 * lib/auth/session-identity.ts — the identity the middleware rate-limits by.
 * Real ES256 signatures (WebCrypto), real cookie formats.
 */

const ALICE = "0000000a-0000-4000-8000-000000000001";
let project: Signer;
let attacker: Signer;

beforeAll(async () => {
  project = await makeSigner("project-key");
  attacker = await makeSigner("project-key"); // same kid, different private key
});

let clock = 1_000_000;
const state = { calls: 0, down: false };
const deps = () => ({ fetchImpl: jwksFetch([project], state), supabaseUrl: SUPABASE_URL, apiKey: "anon", now: () => clock });

beforeEach(() => {
  resetSessionIdentity();
  state.calls = 0;
  state.down = false;
  clock = Date.now();
});

const req = (headers: Record<string, string>) => new NextRequest("https://nexus.example/finance", { headers: new Headers(headers) });

describe("verification", () => {
  it("a token signed by the project's key is verified, and names its user", async () => {
    const r = await verifySessionToken(await project.sign(claims(ALICE)), deps());
    expect(r).toEqual({ kind: "verified", userId: ALICE, expired: false });
  });

  it("an expired but correctly signed token still names its user (marked expired)", async () => {
    const r = await verifySessionToken(await project.sign(claims(ALICE, { expiredSecondsAgo: 7200 })), deps());
    expect(r).toEqual({ kind: "verified", userId: ALICE, expired: true });
  });

  it("a token signed with any other key is invalid — even under the project's kid", async () => {
    expect(await verifySessionToken(await attacker.sign(claims(ALICE)), deps())).toEqual({ kind: "invalid" });
  });

  it("a tampered payload is invalid", async () => {
    const [h, , s] = (await project.sign(claims(ALICE))).split(".");
    const forgedPayload = Buffer.from(JSON.stringify(claims("0000000b-0000-4000-8000-000000000002"))).toString("base64url");
    expect(await verifySessionToken(`${h}.${forgedPayload}.${s}`, deps())).toEqual({ kind: "invalid" });
  });

  it("an unknown kid is invalid (after one refetch for rotation)", async () => {
    await verifySessionToken(await project.sign(claims(ALICE)), deps()); // prime the cache
    clock += 120_000;
    const stranger = await makeSigner("other-key");
    expect(await verifySessionToken(await stranger.sign(claims(ALICE)), deps())).toEqual({ kind: "invalid" });
    expect(state.calls).toBe(2);
  });

  it("garbage, a non-UUID subject, alg none, and missing parts are invalid", async () => {
    for (const t of ["", "abc", "a.b", "a.b.c", "x.y.z.w"]) expect((await verifySessionToken(t, deps())).kind).toBe("invalid");
    expect((await verifySessionToken(await project.sign({ ...claims(ALICE), sub: "admin" }), deps())).kind).toBe("invalid");
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims(ALICE))).toString("base64url")}.x`;
    expect((await verifySessionToken(none, deps())).kind).toBe("invalid");
  });

  it("an HS256 token cannot be checked here and is 'unverifiable', not 'invalid'", async () => {
    expect(await verifySessionToken(hs256Token(ALICE), deps())).toEqual({ kind: "unverifiable" });
  });

  it("an unreachable key set makes a real token 'unverifiable', never 'invalid'", async () => {
    state.down = true;
    expect(await verifySessionToken(await project.sign(claims(ALICE)), deps())).toEqual({ kind: "unverifiable" });
  });
});

describe("the key set is cached per isolate", () => {
  it("is fetched once for many verifications, and again after the TTL", async () => {
    for (let i = 0; i < 50; i++) await verifySessionToken(await project.sign(claims(ALICE)), deps());
    expect(state.calls).toBe(1);
    clock += JWKS_TTL_MS + 1;
    await verifySessionToken(await project.sign(claims(ALICE)), deps());
    expect(state.calls).toBe(2);
  });

  it("concurrent first verifications share one fetch", async () => {
    const t = await project.sign(claims(ALICE));
    await Promise.all(Array.from({ length: 20 }, () => verifySessionToken(t, deps())));
    expect(state.calls).toBe(1);
  });

  it("after a failed fetch it backs off instead of hammering the endpoint", async () => {
    state.down = true;
    const t = await project.sign(claims(ALICE));
    for (let i = 0; i < 10; i++) await verifySessionToken(t, deps());
    expect(state.calls).toBe(1);
    state.down = false;
    clock += FAILURE_BACKOFF_MS + 1;
    expect((await verifySessionToken(t, deps())).kind).toBe("verified");
  });
});

describe("reading the token from a request", () => {
  it("a Bearer header wins", async () => {
    expect(await accessTokenFrom(req({ authorization: "Bearer abc.def.ghi" }))).toBe("abc.def.ghi");
  });

  it("the session cookie: base64-encoded, raw JSON, and chunked", async () => {
    const t = await project.sign(claims(ALICE));
    expect(await accessTokenFrom(req({ cookie: sessionCookie(t) }))).toBe(t);
    expect(await accessTokenFrom(req({ cookie: sessionCookie(t, { encoding: "raw" }) }))).toBe(t);
    const chunked = sessionCookie(t, { chunkSize: 120 });
    expect(chunked).toContain(".1=");
    expect(await accessTokenFrom(req({ cookie: chunked }))).toBe(t);
  });

  it("no credentials -> null; unreadable credentials -> empty string", async () => {
    expect(await accessTokenFrom(req({}))).toBeNull();
    expect(await accessTokenFrom(req({ cookie: "sb-qa-project-auth-token=not-json" }))).toBe("");
    expect(await accessTokenFrom(req({ cookie: "sb-qa-project-auth-token=base64-@@@" }))).toBe("");
  });

  it("sessionIdentity classifies end to end", async () => {
    const t = await project.sign(claims(ALICE));
    expect(await sessionIdentity(req({}), deps())).toEqual({ kind: "none" });
    expect(await sessionIdentity(req({ cookie: "sb-qa-project-auth-token=forged" }), deps())).toEqual({ kind: "invalid" });
    expect(await sessionIdentity(req({ cookie: sessionCookie(t) }), deps())).toEqual({ kind: "verified", userId: ALICE, expired: false });
    expect(await sessionIdentity(req({ authorization: `Bearer ${t}` }), deps())).toEqual({ kind: "verified", userId: ALICE, expired: false });
  });
});

describe("key rotation", () => {
  it("a key the project rotated to inside the refetch window is 'unverifiable', not forged; after the window it verifies", async () => {
    const published = [project];
    const d = () => ({ fetchImpl: jwksFetch(published, state), supabaseUrl: SUPABASE_URL, apiKey: "anon", now: () => clock });
    expect((await verifySessionToken(await project.sign(claims(ALICE)), d())).kind).toBe("verified"); // cache: old key only
    const rotated = await makeSigner("rotated-key");
    published.push(rotated);
    const token = await rotated.sign(claims(ALICE));

    clock += 10_000; // inside the window: no refetch allowed yet
    expect(await verifySessionToken(token, d())).toEqual({ kind: "unverifiable" });
    expect(state.calls).toBe(1);

    clock += 60_000; // window passed: one refetch finds the new key
    expect(await verifySessionToken(token, d())).toEqual({ kind: "verified", userId: ALICE, expired: false });
    expect(state.calls).toBe(2);
    // And the old key still verifies (sessions issued before the rotation).
    expect((await verifySessionToken(await project.sign(claims(ALICE)), d())).kind).toBe("verified");
    expect(state.calls).toBe(2);
  });

  it("an unknown kid is only called forged by a key set fetched for that request", async () => {
    const stranger = await makeSigner("other-key");
    // Cold isolate: the set is fetched for this request and lacks the kid.
    expect(await verifySessionToken(await stranger.sign(claims(ALICE)), deps())).toEqual({ kind: "invalid" });
    expect(state.calls).toBe(1);
    // Warm, inside the window: not provable either way, no refetch.
    clock += 5_000;
    expect(await verifySessionToken(await stranger.sign(claims(ALICE)), deps())).toEqual({ kind: "unverifiable" });
    expect(state.calls).toBe(1);
  });

  it("a failed rotation refetch is 'unverifiable' and backs off instead of refetching per request", async () => {
    await verifySessionToken(await project.sign(claims(ALICE)), deps());
    const stranger = await makeSigner("other-key");
    clock += 120_000;
    state.down = true;
    expect(await verifySessionToken(await stranger.sign(claims(ALICE)), deps())).toEqual({ kind: "unverifiable" });
    expect(state.calls).toBe(2);
    for (let i = 0; i < 20; i++) {
      clock += 100;
      expect((await verifySessionToken(await stranger.sign(claims(ALICE)), deps())).kind).toBe("unverifiable");
    }
    expect(state.calls).toBe(2);
    // The project's own, known key keeps verifying from the cached set meanwhile.
    expect((await verifySessionToken(await project.sign(claims(ALICE)), deps())).kind).toBe("verified");
    clock += FAILURE_BACKOFF_MS;
    state.down = false;
    expect(await verifySessionToken(await stranger.sign(claims(ALICE)), deps())).toEqual({ kind: "invalid" });
    expect(state.calls).toBe(3);
  });
});
