import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FAIL_OPEN, bucketName, bucketPolicy } from "@/lib/rate-limit-policy";
import { clientIp } from "@/lib/client-ip";

/**
 * R-001 / R-002 — what the rate limiter does when it cannot do its job, and
 * what it keys on.
 *
 * The limiter ALGORITHM is not tested here: @upstash/ratelimit runs its
 * sliding window as a single Lua script inside Redis, and that was measured
 * against real Upstash rather than argued from source — burst, refill,
 * 50-way concurrency, and two independent clients on one bucket. Those runs
 * are recorded in REDIS_RATE_LIMIT_DESIGN.md. They need network and a live
 * Redis, so they are not part of this suite.
 *
 * What IS tested here is everything around it that is ours: the failure
 * policy, the key, and the response.
 */

// ---------------------------------------------------------------------------
// The policy table itself
// ---------------------------------------------------------------------------

describe("the fail-open list is a closed, justified set", () => {
  it("gives every entry a reason", () => {
    for (const [name, reason] of Object.entries(FAIL_OPEN)) {
      expect(reason, `${name} is fail-open with no justification`).toBeTruthy();
      expect(reason.length, `${name}'s justification is too short to be one`).toBeGreaterThan(20);
    }
  });

  it("fails an UNCLASSIFIED bucket closed", () => {
    // The point of the default. A bucket nobody thought about must not run
    // unlimited because nobody thought about it.
    expect(bucketPolicy("someBrandNewAction:user-123")).toBe("deny");
    expect(bucketPolicy("")).toBe("deny");
  });

  it("reads the action name from the key, not the whole key", () => {
    expect(bucketName("recordPayment:abc-def")).toBe("recordPayment");
    expect(bucketName("activate:semesters:abc")).toBe("activate");
    expect(bucketName("ip:1.2.3.4")).toBe("ip");
    expect(bucketName("noColon")).toBe("noColon");
  });
});

/**
 * The load-bearing half. Every one of these moves money, changes who someone
 * is, or grants authority — so none of them may run uncounted. If a future
 * change adds any of these names to FAIL_OPEN, this fails.
 */
const MUST_FAIL_CLOSED = [
  // money
  "recordPayment", "createInvoice", "createScholarship", "requestRefund",
  "approveRefund", "rejectRefund", "submitDispute", "finalizeDispute",
  "financeReconcile", "financeReconcileApi", "financeSyncNow",
  "financeConnection", "financeCredential", "financeVerify", "financeMapping",
  // identity and authority
  "inviteUser", "resendInvitation", "createCollege", "updateCollege",
  "updateUserProfile", "updateUserStatus", "updateStudentAcademicStatus",
  "assignHod", "assignWarden", "authorizeSecurity", "securityStatus",
  "assignGate", "securityInstruction", "revokeGateCredential",
  "promoteToPlacementCell", "revokePlacementCell", "reactivatePlacementCell",
  // approvals — each one authorises something that then happens
  "actOnGatePass", "actOnLeaveRequest", "actOnAttendanceCorrection",
  "approveRoomTransfer", "rejectRoomTransfer", "manualGateMovement",
  // academic structure, admin-only
  "createDepartment", "createCourse", "createAcademicYear", "createSemester",
  "updateSemester", "deleteSemester", "activate", "close",
];

describe("money, identity and authority never run uncounted", () => {
  it.each(MUST_FAIL_CLOSED)("%s fails closed", (name) => {
    expect(bucketPolicy(`${name}:user-123`)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Drift: the table must describe the code that exists
// ---------------------------------------------------------------------------

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

/** Every bucket name the application actually asks for. */
function bucketsInSource(): Set<string> {
  const CALL = /checkRateLimit\(\s*`([^`]+)`/g;
  const found = new Set<string>();
  for (const file of [...sourceFiles("app"), ...sourceFiles("lib")]) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(CALL)) {
      const name = bucketName(m[1]);
      // `${transition}` is interpolated; its two values are asserted above.
      if (name.startsWith("${")) continue;
      found.add(name);
    }
  }
  return found;
}

describe("the policy table and the codebase agree", () => {
  it("finds the rate-limited actions at all (guards the scan itself)", () => {
    const found = bucketsInSource();
    expect(found.size).toBeGreaterThan(50);
    expect(found.has("recordPayment")).toBe(true);
    expect(found.has("ip")).toBe(true);
  });

  it("has no fail-open entry for a bucket that no longer exists", () => {
    const found = bucketsInSource();
    const dead = Object.keys(FAIL_OPEN).filter((name) => !found.has(name));
    expect(dead, `fail-open entries with no call site: ${dead.join(", ")}`).toEqual([]);
  });

  it("classifies every bucket the code uses", () => {
    for (const name of bucketsInSource()) {
      expect(["allow", "deny"]).toContain(bucketPolicy(`${name}:x`));
    }
  });
});

// ---------------------------------------------------------------------------
// R-002 — the key
// ---------------------------------------------------------------------------

describe("the limiter keys on a header the caller cannot choose", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("prefers Cloudflare's header over a forged X-Forwarded-For", () => {
    // The bypass: an attacker sends a fresh XFF per request to mint a fresh
    // bucket each time. Behind Cloudflare, CF-Connecting-IP is written by
    // the edge and wins.
    const spoofed = h({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4" });
    expect(clientIp(spoofed)).toEqual({ ip: "203.0.113.9", trusted: true });

    const rotating = ["9.9.9.1", "9.9.9.2", "9.9.9.3"].map(
      (forged) => clientIp(h({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": forged })).ip
    );
    expect(new Set(rotating).size, "rotating XFF produced more than one bucket").toBe(1);
  });

  it("accepts x-real-ip from a terminating proxy", () => {
    expect(clientIp(h({ "x-real-ip": "198.51.100.7" }))).toEqual({ ip: "198.51.100.7", trusted: true });
  });

  it("marks a bare X-Forwarded-For as untrusted rather than pretending", () => {
    expect(clientIp(h({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toEqual({ ip: "1.2.3.4", trusted: false });
  });

  it("never returns an empty key", () => {
    expect(clientIp(h({})).ip).toBe("unknown");
    expect(clientIp(h({ "cf-connecting-ip": "   " })).ip).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// R-001 — behaviour when Redis is gone
// ---------------------------------------------------------------------------

async function loadLimiter(redisValue: unknown, nodeEnv: string) {
  vi.resetModules();
  // vi.stubEnv, not Object.defineProperty: Node 22 rejects a non-standard
  // descriptor on process.env, and isDeployed() reads NODE_ENV at call time
  // so a stub is enough.
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.doMock("@/lib/redis", () => ({ redis: redisValue }));
  return import("@/lib/rate-limit");
}

describe("an unreachable limiter", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/redis");
    vi.resetModules();
  });

  it("REFUSES a fail-closed action in production when Redis is not configured", async () => {
    const { checkRateLimit, RateLimiterUnavailableError } = await loadLimiter(null, "production");
    await expect(checkRateLimit("recordPayment:u1", 15, 60)).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });

  it("still allows a fail-open action in production when Redis is not configured", async () => {
    const { checkRateLimit } = await loadLimiter(null, "production");
    await expect(checkRateLimit("ip:203.0.113.9", 100, 60)).resolves.toBeUndefined();
    await expect(checkRateLimit("gateScan:guard-1", 120, 60)).resolves.toBeUndefined();
  });

  it("does not block a developer with no Upstash credentials", async () => {
    const { checkRateLimit } = await loadLimiter(null, "development");
    await expect(checkRateLimit("recordPayment:u1", 15, 60)).resolves.toBeUndefined();
  });

  it("REFUSES a fail-closed action when the Redis call itself throws", async () => {
    // Configured, reachable enough to construct, but failing on use — the
    // Upstash-outage case, which the old code swallowed silently.
    const exploding = {
      eval: () => {
        throw new Error("ECONNRESET");
      },
    };
    const { checkRateLimit, RateLimiterUnavailableError } = await loadLimiter(exploding, "development");
    await expect(checkRateLimit("approveRefund:u1", 30, 60)).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });

  it("lets a fail-open action through when the Redis call throws", async () => {
    const exploding = {
      eval: () => {
        throw new Error("ECONNRESET");
      },
    };
    const { checkRateLimit } = await loadLimiter(exploding, "development");
    await expect(checkRateLimit("saveAttendance:t1", 30, 60)).resolves.toBeUndefined();
  });

  it("logs the refusal so an operator can see the window", async () => {
    const { checkRateLimit } = await loadLimiter(null, "production");
    await checkRateLimit("recordPayment:u1", 15, 60).catch(() => {});
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("fail-closed"),
      expect.objectContaining({ key: "recordPayment:u1" })
    );
  });

  it("never discloses the Redis fault to the caller", async () => {
    const exploding = {
      eval: () => {
        throw new Error("ECONNRESET upstash-abc123.upstash.io:6379");
      },
    };
    const { checkRateLimit, RateLimiterUnavailableError } = await loadLimiter(exploding, "development");
    const err = await checkRateLimit("approveRefund:u1", 30, 60).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimiterUnavailableError);
    expect((err as Error).message).not.toMatch(/ECONNRESET|upstash|6379/i);
  });
});
