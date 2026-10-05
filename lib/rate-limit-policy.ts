/**
 * What happens to each rate-limit bucket when the limiter cannot reach Redis.
 *
 * WHY THIS IS A TABLE AND NOT A FLAG AT EACH CALL SITE
 *
 * There are ~75 rate-limited actions in this repository. A per-call-site
 * boolean would be 75 independent decisions made by whoever happened to be
 * writing that action, reviewed one diff at a time, with no way to ask "what
 * currently happens to money if Upstash goes down". Here it is one list, it
 * is reviewable in one sitting, and the test in tests/rate-limit-policy.test.ts
 * fails when a new bucket appears in the codebase without an entry.
 *
 * THE DEFAULT IS DENY
 *
 * A bucket nobody classified fails closed. That is the safe direction: a new
 * action is refused while the limiter is blind, rather than silently running
 * unlimited because someone forgot a flag. FAIL_OPEN below is therefore the
 * complete, exhaustive list of places where this application will knowingly
 * accept an uncounted request, and every one of them carries the reason.
 *
 * WHAT "FAIL OPEN" IS NOT
 *
 * It is not "unauthenticated". Every one of these actions still goes through
 * requireRole() and still lands on an RLS-enforced statement. Neither depends
 * on Redis. What is lost during an outage is the ABUSE ceiling, not the
 * authorization decision — that distinction is the whole basis on which the
 * list below is drawn.
 */

export type UnavailablePolicy = "allow" | "deny";

/**
 * Buckets that may run uncounted when Redis is unreachable, each with the
 * reason refusing would be worse than allowing.
 *
 * The test is always the same: if this action is refused for the duration of
 * an Upstash outage, what breaks — and is that worse than the abuse the
 * bucket was there to cap?
 */
export const FAIL_OPEN: Record<string, string> = {
  // Middleware's coarse per-IP bucket, checked on EVERY request including
  // /login and every static page shell. Failing it closed converts a Redis
  // blip into a total site outage. It is an anti-flood ceiling, not an
  // authorization boundary — the per-action buckets underneath it are.
  ip: "global anti-flood ceiling in middleware; refusing it takes the whole site down",
  // The same, for a request that carries a session cookie or a bearer token
  // — checked before the session is verified, so it cannot be per-user yet.
  // Generous on purpose: a whole campus can sit behind one public IP.
  ipCredentialed: "pre-auth flood ceiling for credentialed requests; refusing it takes the whole site down",
  // Per-user ceiling on every authenticated request, applied after the
  // session is verified. Same reasoning as `ip`: an abuse ceiling, not an
  // authorization boundary, and failing it closed is a site-wide outage.
  user: "per-user anti-flood ceiling in middleware; refusing it takes the whole site down",

  // A guard's movement feed. Read-only, changes nothing. A blank screen at a
  // staffed gate is an operational hazard with no compensating security gain.
  gateFeed: "read-only guard dashboard feed; no state change",

  // Physical gates. The control that stops a forged or replayed crossing is
  // the HMAC signature on the payload and record_gate_movement()'s state
  // machine in PostgreSQL — neither touches Redis. The bucket caps scanner
  // abuse, and there is nothing to brute-force: a payload either verifies or
  // it does not. Refusing this strands people at a physical barrier.
  gateScan: "authorization is the payload signature + record_gate_movement(); refusing strands people at a barrier",

  // Minting the QR for a pass the student already owns and a warden already
  // approved. The credential's authority comes from the signature and the
  // approved pass, not from this bucket. Refusing strands a student at a gate.
  gatePassCredential: "credential authority is the signature + an already-approved pass; refusing strands a student at a gate",

  // First-party data entry by the person whose work it is. Abuse here is
  // noise in their own records, and RLS already confines the blast radius to
  // rows they are entitled to write.
  saveAttendance: "teacher entering their own class's attendance; RLS confines it to their offerings",
  saveMarks: "teacher entering their own class's marks; RLS confines it to their offerings",
  applyForGatePass: "student applying on their own behalf; still requires warden approval to become anything",
  applyForLeave: "applicant's own leave request; still requires approval",
  submitComplaint: "student's own complaint; worst case is duplicate rows in their own list",
  requestRoomTransfer: "student's own request; still requires warden approval",
  requestAttendanceCorrection: "teacher's own correction request; still requires HOD approval",
  applyToDrive: "student applying to a placement drive on their own behalf",
};

/**
 * HIGH-RISK buckets: money, identity, authority and approvals. These are the
 * actions where a missing rate limit is itself the damage, so they may NEVER
 * appear in FAIL_OPEN — the module refuses to load if one does (below), and
 * tests/rate-limit-policy.test.ts pins it. Every other unlisted bucket is
 * "protected": also fail-closed, by the deny default.
 */
export const HIGH_RISK = [
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
] as const;

for (const name of HIGH_RISK) {
  if (name in FAIL_OPEN) {
    throw new Error(`rate-limit policy: high-risk bucket "${name}" may not fail open`);
  }
}

/**
 * The risk class of a bucket, which is the whole of its failure policy:
 *
 * | class     | Redis unavailable / timeout / malformed / circuit open |
 * |-----------|--------------------------------------------------------|
 * | flood     | allowed (global anti-flood ceilings in middleware)     |
 * | low       | allowed (first-party, low-impact actions; see reasons) |
 * | high      | REFUSED — 503                                          |
 * | protected | REFUSED — 503 (everything unlisted, new buckets too)   |
 *
 * A timeout is never a "pass": it is one of the unavailable cases.
 */
export type RiskClass = "flood" | "low" | "high" | "protected";

const FLOOD = new Set(["ip", "ipCredentialed", "user"]);

export function riskClass(key: string): RiskClass {
  const name = bucketName(key);
  if (FLOOD.has(name)) return "flood";
  if (name in FAIL_OPEN) return "low";
  if ((HIGH_RISK as readonly string[]).includes(name)) return "high";
  return "protected";
}

/**
 * Prefix of a bucket key. Keys are `actionName:...` everywhere in this repo
 * (usually `actionName:${actor.userId}`), so the action name is the segment
 * before the first colon.
 */
export function bucketName(key: string): string {
  const colon = key.indexOf(":");
  return colon === -1 ? key : key.slice(0, colon);
}

export function bucketPolicy(key: string): UnavailablePolicy {
  return bucketName(key) in FAIL_OPEN ? "allow" : "deny";
}
