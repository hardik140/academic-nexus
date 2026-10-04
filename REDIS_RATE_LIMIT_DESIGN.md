# Redis and rate limiting — design, measurements, and failure policy

Covers Phases 15–23. Every number below was measured against the live
Upstash instance configured in `.env.local`; nothing here is inferred from
source. The probe wrote only keys under a random `rl-audit-<uuid>` prefix and
deleted all of them, so it could never collide with a production `ratelimit:`
key or affect a real caller.

---

## 1. What Redis is used for (Phase 15)

| Use | Module | Authoritative? |
| --- | --- | --- |
| Rate limiting | `lib/rate-limit.ts` | No — an abuse ceiling |
| Read-through cache | `lib/cache.ts` | No — PostgreSQL is re-read on miss |
| Middleware profile cache (20 s) | `lib/supabase/middleware.ts` | No — routing only; `requireRole()` re-reads uncached |

Nothing else. There are no distributed locks, no sessions, no queues, no
idempotency keys and no OTPs in Redis.

**Rule 4 holds.** No business fact lives in Redis. Payments, gate movements,
approvals, students, users, fees and audit history are in PostgreSQL only;
the finance sync queue is a PostgreSQL table (`finance_sync_operations`),
deliberately, so "the queue says posted" and "the journal says failed" cannot
disagree. Concurrency is settled by PostgreSQL row locks and unique indexes
(`tests/realpg-concurrency.test.ts`), never by a Redis lock.

---

## 2. Algorithm and atomicity (Phase 17)

The limiter is `@upstash/ratelimit` `slidingWindow`, keyed per action (v2.0.8
when §4 was measured; v2.2.0 installed at the §10 hardening, same script).

**Rule 5 — atomic — VERIFIED.** Every limiter in that package executes as a
single Lua script through `redis.eval`; the count-and-decide step happens
inside Redis. It is not the `GET` → compute → `SET` sequence Phase 17 warns
about. Confirmed two ways: by reading `node_modules/@upstash/ratelimit/dist/index.js`
(three `redis.eval` sites, `PEXPIRE` inside the scripts), and by the
concurrency measurement in §4 below, which is the property that actually
matters.

`Ratelimit.tokenBucket` is available in the same package and was measured
alongside the sliding window (§4). **The sliding window was kept.** For these
buckets the two are equivalent in what they prevent, and a sliding window
does not admit the full-capacity instantaneous burst that a token bucket
does after an idle period. Switching would have been churn without a defect
to point at.

---

## 3. Bucket design (Phases 18, 19)

Keys are `actionName:${actor.userId}` — the security principal, resolved
server-side by `requireRole()`, never a client-supplied id. The two
exceptions are the middleware's global `ip:` bucket and the academic-period
transitions, which key `${transition}:${table}:${userId}`.

**Rule: never IP alone for authenticated users — HOLDS.** Every one of the
~75 per-action buckets keys on `userId`. IP appears only in the coarse
global bucket.

| Class | Example key | Capacity / window |
| --- | --- | --- |
| Global anti-flood | `ip:{ip}` | 100 / 60 s |
| Gate scanning | `gateScan:{guardId}` | 120 / 60 s |
| Financial mutation | `recordPayment:{userId}` | 15 / 60 s |
| Refund approval | `approveRefund:{userId}` | 30 / 60 s |
| Identity / invitation | `inviteUser:{userId}` | 20 / 60 s |
| Tenant creation | `createCollege:{userId}` | 5 / 60 s |
| Student self-service | `applyForGatePass:{userId}` | 5 / 60 s |
| Low-frequency authoring | `submitDecision:{userId}` | 10 / 3600 s |

Capacities were left as they are. They were not derived from measured
production traffic — there is none yet — and Phase 19 says as much:
"Claude must inspect actual traffic characteristics before finalizing
production values." **Recorded as an open item, not as a PASS.**

### The gate bucket is keyed on the guard, not the gate

Phase 18 suggests `rl:gate-scan:{guardId}:{gateId}`. The implementation uses
`gateScan:{guardId}`. That is the stricter of the two: a guard working two
gates shares one ceiling instead of getting one per gate. No change made.

---

## 4. Measured behaviour (Phase 20)

Live Upstash, 2026-09-19. Each test used a fresh random key.

| Test | Sent | Capacity | Allowed | Result |
| --- | --- | --- | --- | --- |
| Connectivity | `PING` | — | `PONG` in 639 ms (cold) | PASS — TESTED |
| Sequential burst | 25 | 10 | **10** | PASS — TESTED |
| **Concurrent burst** | **50 at once** | **10** | **10** (34 ms wall) | **PASS — TESTED** |
| Distributed, 2 independent clients | 30 | 10 | **10** | PASS — TESTED |
| Refill (2 per 5 s) | 4, then 1, then 1 after 6 s | 2 | 2, denied, **allowed** | PASS — TESTED |
| Token bucket, concurrent | 30 | 10 | **10** | PASS — TESTED |
| Key isolation | exhaust A, then B | 3 | B still allowed | PASS — TESTED |

The concurrent row is the one that matters. Fifty simultaneous `limit()`
calls on one bucket let exactly ten through, no overshoot, no negative token
state. A non-atomic limiter fails this test loudly. The distributed row
repeats it across two separate `Redis` clients — the serverless case, two
instances sharing one bucket — with the same result.

**500-concurrent was not attempted.** Phase 20 suggests up to 500; that
volume against the production Upstash instance risks consuming request quota
and, if the quota is hit, degrading the limiter for real users. 50-way
concurrency already demonstrates the atomicity property; higher numbers
measure Upstash's throughput, not this application's correctness.
**NOT TESTED — would require a separate Upstash instance.**

---

## 5. Failure policy (Phases 16, 22) — the defect that was fixed

### What it was

```ts
if (!redis) return;                       // unconfigured  -> allow everything
try { ... } catch (err) {
  if (err instanceof RateLimitError) throw err;
  // Redis itself failed — fail open rather than block real traffic.
}                                          // outage       -> allow everything
```

One decision, applied identically to loading a dashboard and to approving a
refund. An Upstash outage — or one missing environment variable on a new
deployment — silently converted **every bucket in the application** to
unlimited, with nothing logged and nothing surfaced.

### What it is now

> **Superseded in part by §10 (2026-10-04).** "Unreachable" now also means a
> timeout, a malformed result and an open circuit — the version described
> below still read a slow Redis as "allowed" (§10.1). The `ip` bucket moved to
> a separate "flood" class with two new middleware buckets.

The decision is per bucket and declared in one reviewable table,
`lib/rate-limit-policy.ts`. **The default is DENY.** A bucket nobody
classified fails closed, so a new action cannot end up unlimited because
someone forgot a flag.

| Classification | Buckets | Behaviour when Redis is unreachable |
| --- | --- | --- |
| **FAIL CLOSED** | everything not listed below — ~63 buckets covering money, identity, authority, approvals and admin mutations | `RateLimiterUnavailableError` → **503** with `Retry-After` |
| **CONTROLLED FALLBACK** | `gateScan`, `gatePassCredential` | allowed, logged |
| **FAIL OPEN** | `ip`, `gateFeed`, `saveAttendance`, `saveMarks`, `applyForGatePass`, `applyForLeave`, `submitComplaint`, `requestRoomTransfer`, `requestAttendanceCorrection`, `applyToDrive` | allowed, logged |

Every fail-open entry carries its justification in the source, and
`tests/rate-limit-policy.test.ts` fails if any is left without one.

### Why each fail-open decision was made (Phase 22 requires this)

- **`ip`** — checked on every request including `/login` and every static
  shell. Failing it closed turns a Redis blip into a total site outage. It is
  an anti-flood ceiling, not an authorization boundary; the per-action
  buckets underneath it are.
- **`gateFeed`** — a read. Changes nothing. A blank screen at a staffed gate
  is an operational hazard with no compensating security gain.
- **`gateScan` / `gatePassCredential`** — what stops a forged or replayed
  crossing is the HMAC signature on the payload and `record_gate_movement()`'s
  state machine in PostgreSQL. Neither touches Redis, and there is nothing to
  brute-force: a payload either verifies or it does not. Refusing these
  strands people at a physical barrier.
- **First-party data entry** (`saveAttendance`, `saveMarks`, `applyForLeave`,
  `submitComplaint`, `requestRoomTransfer`, `requestAttendanceCorrection`,
  `applyToDrive`, `applyForGatePass`) — the actor is writing their own
  records, RLS confines the blast radius to rows they may already write, and
  every one of them still requires an approval to become anything. Abuse here
  is noise in their own list.

**Nothing that moves money, changes identity, grants authority, or approves
anything is in that list.**

### Development is not production

`redis === null` in a non-production `NODE_ENV` allows the request and warns
once. A developer with no Upstash credentials is not blocked from working.
In production, an unconfigured limiter is a deployment fault and a
fail-closed bucket refuses.

### Evidence

`tests/rate-limit-policy.test.ts` — 63 tests. Mutation-checked: reverting
`bucketPolicy()` to the old always-allow behaviour fails 51 of them;
reverting the key to `x-forwarded-for` fails the bypass test.

---

## 6. Bypass resistance (Phase 23) — the second defect that was fixed

### What it was

```ts
const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
await checkRateLimit(`ip:${ip}`, 100, 60);
```

`X-Forwarded-For` is a request header. Proxies **append** to it; nobody
verifies its leftmost entry. A caller sending a fresh value per request got a
fresh empty bucket per request:

```
curl -H 'X-Forwarded-For: 1.2.3.4' …   -> bucket ip:1.2.3.4
curl -H 'X-Forwarded-For: 1.2.3.5' …   -> bucket ip:1.2.3.5
```

The global limit was not a limit.

### What it is now

`lib/client-ip.ts` prefers `CF-Connecting-IP`, which Cloudflare writes at the
edge and overwrites on every request — the one header here a client cannot
choose. This application deploys behind Cloudflare (`wrangler.jsonc`,
`open-next.config.ts`). `X-Real-IP` is the second choice; `X-Forwarded-For`
is demoted to a last resort and reports `trusted: false`.

### Other bypass vectors

| Vector | Outcome |
| --- | --- |
| Rotating `X-Forwarded-For` | **Closed** — `CF-Connecting-IP` wins |
| `X-Real-IP` spoof | Closed behind Cloudflare, which does not forward a client-supplied one |
| Multiple sessions / user ids for one person | **Open by design** — buckets key on the authenticated principal; a second account is a second principal. Mitigated by invitation-only account creation (migration 043), not by the limiter |
| Query-string, URL casing, trailing slash, alternate method | Not applicable — buckets key on action name + user id, never on the URL |
| Parallel connections | Closed — atomicity measured in §4 |
| IPv6 | Same code path; the value is opaque to the limiter |

**Residual, not hidden:** if this is ever deployed with no trusted edge in
front of it, no header is authoritative and the last resort is spoofable
again. That is a property of the deployment, not of this code. `clientIp()`
reports `trusted: false` in that case so it can be alerted on.

---

## 7. Rate-limit response (Phase 21)

| Condition | Status | Headers | Body |
| --- | --- | --- | --- |
| Bucket exhausted | `429` | `Retry-After: <seconds>` | `{ error, retryAfter }` |
| Limiter blind, fail-closed bucket | `503` | `Retry-After: 30` | `{ error }` |

`Retry-After` is computed from the limiter's own `reset` timestamp. 503 is
deliberately distinct from 429: the caller did nothing wrong and the
condition is ours, so it must not be reported as their fault or counted
against them by a retry-limiting client.

No Redis error, connection string, key name or bucket state ever reaches a
caller — asserted in `tests/api-error-disclosure.test.ts`.

---

## 8. Load (Phase 44) — NOT TESTED

Requests/sec, Redis ops/sec, memory, connection count and failure rate under
sustained load were not measured. Doing so means driving real traffic through
the deployed application, and the only Upstash instance available is the
production one. The single latency figure observed is the 639 ms cold `PING`
and ~34 ms for 50 concurrent `limit()` calls, which is a cold-start
measurement from a developer machine in India to Upstash and says nothing
about in-region serverless latency.

**Requires a separate Upstash instance and a deployed environment.**

---

## 9. What is NOT rate-limited by this application at all

**Login and password reset.** `app/login/page.tsx` calls
`supabase.auth.signInWithPassword()` and `resetPasswordForEmail()` **directly
from the browser** to Supabase's GoTrue endpoint. Those requests never reach
Next.js, never reach the middleware, and never reach `checkRateLimit`.

Phase 18's `rl:auth:{ip}:{identifier}` and `rl:password-reset:{ip}:{identifier}`
buckets therefore **cannot be implemented in this codebase** without routing
authentication through a server action or route handler first.

Brute-force protection for login currently rests entirely on **GoTrue's own
built-in rate limits**, configured in the Supabase dashboard, outside this
repository. Their current values were not read and not tested — doing so
means either reading the hosted project's auth settings or firing failed
logins at the production auth endpoint.

**Status: NOT TESTED — CONTROL IS OUTSIDE THIS REPOSITORY.** This is the
single largest remaining gap in the rate-limiting surface and it is a
configuration item for whoever owns the Supabase project, not a code change.

**Re-checked 2026-10-04 (§10): unchanged.** The repository has no
`supabase/config.toml` and no Supabase management token, so the hosted
`auth.rate_limit` settings (sign-in attempts, password-reset emails, token
refresh) were not read. Proxying login through the application only to add a
limiter was not done: it would move password handling onto this server for a
control GoTrue already provides. The owner of the Supabase project should
read and record those values in the dashboard (Authentication → Rate Limits).

---

## 10. Production hardening (2026-10-04, PR #123)

Built and verified locally; **not deployed**. Every measurement in this
section is LOCAL, against `e2e/support/upstash-emulator.mjs` on loopback — a
stand-in for Upstash's REST API with fault modes — never against the
production Upstash database. No production telemetry exists yet.

### 10.1 Defects found

| # | Defect | Where |
|---|---|---|
| 1 | **A slow Redis allowed protected actions.** `@upstash/ratelimit` resolves its own timeout as `{ success: true, reason: "timeout" }` instead of throwing; the limiter read only `success`. Proven on `main` with the emulator: a payment was allowed after **5,008 ms**. | `lib/rate-limit.ts` |
| 2 | **No deadline, 5 retries.** Client defaults: exponential backoff (≈4.3 s) and an unbounded fetch. On `main`, a dropped connection cost ≈4.4 s per rate-limit check and ≈8.8 s per cached read. | `lib/redis.ts` |
| 3 | **One per-IP bucket for everyone**, signed in or not: a campus behind one NAT address shared 100 requests/min. | `lib/supabase/middleware.ts` |
| 4 | **No namespace.** The Worker's secrets are synced from `.env.local` (`scripts/sync-cf-secrets.mjs`), so development and production share ONE Upstash database and wrote identical keys. Raw IPs were stored in keys. | all keys |
| 5 | **Four cached reads crossed a visibility boundary** (§10.5). | warden rooms; placement records, reports, dashboard |
| 6 | **A write cleared only the editor's own list view**; mobile-API writes cleared nothing; an admin acting on an HOD's request left the HOD's list stale; four "goals" invalidations deleted a key that is never written. | list actions |
| 7 | Raw, unbounded search text in keys. | `lib/cached-list.ts` |
| 8 | Console-only diagnostics; the client's error messages embed the full command, payload included. | — |

### 10.2 Architecture

```text
application ──► lib/redis-guard.ts  redisOp(op, run, validate)
                 │  deadline: REDIS_TIMEOUT_MS (default 1000 ms), three layers:
                 │    1. client AbortSignal — a FUNCTION, called once per command,
                 │       covering every retry (a plain signal makes the client
                 │       return the string "Aborted" as if it were a value)
                 │    2. a deadline race in the guard (backstop)
                 │    3. the limiter's own `timeout` — its result is validated
                 │  one retry, 50 ms, network errors only (never on HTTP errors)
                 │  failures classified by TYPE: timeout | auth | malformed | error
                 │  circuit breaker: 3 consecutive failures → open 10 s →
                 │    one probe → closed on success, re-opened on failure
                 ▼
        returns { ok, value } or { ok: false, reason } — never throws
                 │
   ┌─────────────┴──────────────┐
   ▼                            ▼
lib/rate-limit.ts           lib/cache.ts
 reason → bucket risk class  reason → read from PostgreSQL
```

The limiter result is accepted only when it is well formed: `success` a
boolean, `reset` and `remaining` finite, `reason` not `timeout`. Anything else
is "unavailable".

**Timeout value.** 1000 ms admits the one recorded cold call (639 ms, TLS
handshake included, India → Upstash, §4) with margin and caps a hung Upstash
at one second. Configurable with `REDIS_TIMEOUT_MS`, clamped to 100–5000.
In-region Worker → Upstash latency has not been measured (§10.9).

### 10.3 Failure behaviour

| Failure | High-risk / protected action | Low-risk (11) and flood (3) buckets | Cached read |
|---|---|---|---|
| Unconfigured, in production | refused, 503 | allowed | PostgreSQL |
| Connection error / down | refused, 503, ≤ budget (one retry) | allowed, `fail_open` logged | PostgreSQL |
| Timeout / slow | refused, 503, ≤ ~1 s | allowed | PostgreSQL, ≤ ~1 s |
| Malformed response | refused, 503 | allowed | miss → PostgreSQL |
| Auth failure (revoked token) | refused, 503, not retried | allowed | PostgreSQL |
| Partial (read ok, write fails) | — | — | fresh value served, write error logged |
| Circuit open | refused instantly | allowed instantly | PostgreSQL instantly |
| Recovery | after 10 s one probe; success closes the circuit | | |

### 10.4 Rate limiting

**Risk classes** (`lib/rate-limit-policy.ts`): `flood` and `low` may fail
open; `high` (an explicit list — money, identity, authority, approvals,
academic structure) and `protected` (everything else, including any bucket
added tomorrow) are refused. A high-risk name in the fail-open table stops the
module from loading. The complete table, generated from the call sites by
`node scripts/redis-policy-table.mjs`:

| Bucket | Risk class | Limit / window | Redis unavailable, timeout, malformed, circuit open |
|---|---|---|---|
| `ip` | flood | 100 / 60 s | allowed (logged fail_open) |
| `ipCredentialed` | flood | 2000 / 60 s | allowed (logged fail_open) |
| `user` | flood | 300 / 60 s | allowed (logged fail_open) |
| `applyForGatePass` | low | 5 / 60 s | allowed (logged fail_open) |
| `applyForLeave` | low | 10 / 60 s | allowed (logged fail_open) |
| `applyToDrive` | low | 20 / 60 s | allowed (logged fail_open) |
| `gateFeed` | low | 120 / 60 s | allowed (logged fail_open) |
| `gatePassCredential` | low | 60 / 60 s | allowed (logged fail_open) |
| `gateScan` | low | 120 / 60 s | allowed (logged fail_open) |
| `requestAttendanceCorrection` | low | 20 / 60 s | allowed (logged fail_open) |
| `requestRoomTransfer` | low | 5 / 3600 s | allowed (logged fail_open) |
| `saveAttendance` | low | 30 / 60 s | allowed (logged fail_open) |
| `saveMarks` | low | 30 / 60 s | allowed (logged fail_open) |
| `submitComplaint` | low | 5 / 60 s | allowed (logged fail_open) |
| `activate / close (academic period transitions)` | high | 30 / 60 s | refused, 503 (logged fail_closed) |
| `actOnAttendanceCorrection` | high | 30 / 60 s | refused, 503 (logged fail_closed) |
| `actOnGatePass` | high | 30 / 60 s | refused, 503 (logged fail_closed) |
| `actOnLeaveRequest` | high | 30 / 60 s | refused, 503 (logged fail_closed) |
| `approveRefund` | high | 30 / 60 s | refused, 503 (logged fail_closed) |
| `approveRoomTransfer` | high | 30 / 60 s | refused, 503 (logged fail_closed) |
| `assignGate` | high | 40 / 60 s | refused, 503 (logged fail_closed) |
| `assignHod` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `assignWarden` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `authorizeSecurity` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `createAcademicYear` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `createCollege` | high | 5 / 60 s | refused, 503 (logged fail_closed) |
| `createCourse` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `createDepartment` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `createInvoice` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `createScholarship` | high | 15 / 60 s | refused, 503 (logged fail_closed) |
| `createSemester` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `deleteSemester` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `finalizeDispute` | high | 30 / 60 s | refused, 503 (logged fail_closed) |
| `financeConnection` | high | 10 / 60 s | refused, 503 (logged fail_closed) |
| `financeCredential` | high | 10 / 60 s | refused, 503 (logged fail_closed) |
| `financeMapping` | high | 60 / 60 s | refused, 503 (logged fail_closed) |
| `financeReconcile` | high | 10 / 60 s | refused, 503 (logged fail_closed) |
| `financeReconcileApi` | high | 10 / 60 s | refused, 503 (logged fail_closed) |
| `financeSyncNow` | high | 10 / 60 s | refused, 503 (logged fail_closed) |
| `financeVerify` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `inviteUser` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `manualGateMovement` | high | 30 / 60 s | refused, 503 (logged fail_closed) |
| `promoteToPlacementCell` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `reactivatePlacementCell` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `recordPayment` | high | 15 / 60 s | refused, 503 (logged fail_closed) |
| `rejectRefund` | high | 30 / 60 s | refused, 503 (logged fail_closed) |
| `rejectRoomTransfer` | high | 30 / 60 s | refused, 503 (logged fail_closed) |
| `requestRefund` | high | 10 / 3600 s | refused, 503 (logged fail_closed) |
| `resendInvitation` | high | 10 / 60 s | refused, 503 (logged fail_closed) |
| `revokeGateCredential` | high | 30 / 60 s | refused, 503 (logged fail_closed) |
| `revokePlacementCell` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `securityInstruction` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `securityStatus` | high | 30 / 60 s | refused, 503 (logged fail_closed) |
| `submitDispute` | high | 10 / 3600 s | refused, 503 (logged fail_closed) |
| `updateCollege` | high | 10 / 60 s | refused, 503 (logged fail_closed) |
| `updateSemester` | high | 30 / 60 s | refused, 503 (logged fail_closed) |
| `updateStudentAcademicStatus` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `updateUserProfile` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `updateUserStatus` | high | 20 / 60 s | refused, 503 (logged fail_closed) |
| `academicStructure` | protected | 30 / 60 s | refused, 503 (logged fail_closed) |
| `assignClassIncharge` | protected | 30 / 60 s | refused, 503 (logged fail_closed) |
| `assignSubstitute` | protected | 30 / 60 s | refused, 503 (logged fail_closed) |
| `collegeLifecycle` | protected | 20 / 60 s | refused, 503 (logged fail_closed) |
| `createCompany` | protected | 20 / 60 s | refused, 503 (logged fail_closed) |
| `createDrive` | protected | 20 / 60 s | refused, 503 (logged fail_closed) |
| `createGoal` | protected | 20 / 3600 s | refused, 503 (logged fail_closed) |
| `createManualRiskFlag` | protected | 20 / 3600 s | refused, 503 (logged fail_closed) |
| `createPlacement` | protected | 20 / 60 s | refused, 503 (logged fail_closed) |
| `decideOnDecision` | protected | 30 / 3600 s | refused, 503 (logged fail_closed) |
| `endDepartmentTerm` | protected | 10 / 60 s | refused, 503 (logged fail_closed) |
| `externalTeaching` | protected | 20 / 60 s | refused, 503 (logged fail_closed) |
| `inviteStudent` | protected | 20 / 60 s | refused, 503 (logged fail_closed) |
| `offering` | protected | 60 / 60 s | refused, 503 (logged fail_closed) |
| `placeStudent` | protected | 60 / 60 s | refused, 503 (logged fail_closed) |
| `revokeSession` | protected | 30 / 60 s | refused, 503 (logged fail_closed) |
| `saveForecastScenario` | protected | 20 / 3600 s | refused, 503 (logged fail_closed) |
| `sendAnnouncement` | protected | 10 / 3600 s | refused, 503 (logged fail_closed) |
| `sendPlacementNotification` | protected | 10 / 3600 s | refused, 503 (logged fail_closed) |
| `sessionEnforcement` | protected | 5 / 60 s | refused, 503 (logged fail_closed) |
| `setDriveStatus` | protected | 20 / 60 s | refused, 503 (logged fail_closed) |
| `startDepartmentTerm` | protected | 10 / 60 s | refused, 503 (logged fail_closed) |
| `submitDecision` | protected | 10 / 3600 s | refused, 503 (logged fail_closed) |
| `timetable` | protected | 60 / 60 s | refused, 503 (logged fail_closed) |
| `updateApplicationStatus` | protected | 30 / 60 s | refused, 503 (logged fail_closed) |
| `updateCompany` | protected | 20 / 60 s | refused, 503 (logged fail_closed) |
| `updateComplaintStatus` | protected | 30 / 60 s | refused, 503 (logged fail_closed) |
| `updateDrive` | protected | 20 / 60 s | refused, 503 (logged fail_closed) |
| `updateStudentPlacementStatus` | protected | 30 / 60 s | refused, 503 (logged fail_closed) |

88 buckets: 3 flood, 11 low, 45 high, 29 protected. Unknown buckets are protected (refused).

**Anonymous vs authenticated** (middleware, all per 60 s, all `flood`):

| Request | Buckets spent |
|---|---|
| No session cookie, no bearer token | `ip:<digest>` — 100 (unchanged) |
| Session cookie, session verifies | `ipCredentialed:<digest>` — 2000, then `user:<id>` — 300 |
| Session cookie, session does NOT verify (forged, expired) | `ipCredentialed`, then the strict `ip` bucket |
| Bearer token (mobile `/api`) | `ipCredentialed` only; the route verifies the token and applies its per-user, per-action buckets |

The credentialed ceiling and the per-user limit are sized, not measured: there
is no production traffic to derive them from (open item, as in §3).

### 10.5 Keys and cache scope

```text
<env>:nexus:rl:v1:<bucket>:<principal>:<window>     rate limit
<env>:nexus:c:<build>:<key>                          cached value
<env>:nexus:c:shared:mw-profile:v1:<user>            middleware profile (all builds)
<env>:nexus:cv:<family>:<college>                    family version counter
```

- `<env>` — `REDIS_ENV`, or from the build: a built bundle is `production`,
  `next dev` is `development`, vitest is `test`, the E2E servers are `e2e`.
  The production namespace is **refused** outside a production build
  (`NODE_ENV` read through the literal Next inlines, so a Worker always knows
  it is production).
- `<build>` — the commit SHA, inlined at build time by `next.config.ts`
  (read through the literal `process.env.NEXT_PUBLIC_REDIS_BUILD_ID`; read any
  other way it would be `local` on the Worker). Values are build-scoped so an
  old and a new Worker never read each other's shapes; TTLs are 15–300 s.
- Rate-limit keys and version counters are **not** build-scoped: a deploy must
  not reset limits, and counters are plain integers.
- IPs and search text are stored as SHA-256 digests (not secret — an IPv4
  address can be enumerated — but never raw, and never growing with input). A
  search longer than 100 characters, an invalid page or an invalid sort
  direction is not cached at all.
- **First deploy:** every prefix changes, so existing counters and entries are
  abandoned once and expire on their own; limits restart from zero.

**Scope.** Every cached read (46 call sites) is declared in
`tests/cache-scope-registry.test.ts` with its scope — `user`, `split` (admin →
college, the narrower role → user), `role`, `college`, `department`,
`platform` — the exact roles that can reach it, and, for a multi-role college
scope, the RLS policies that make every role see the same rows. The test fails
on a new cached read, on a changed role set, and on a cited policy that no
migration creates. Writing it found four reads that broke the assumption:

| Read | Why one college key was wrong | Now |
|---|---|---|
| `warden/rooms` | admin sees every room; a warden only their blocks | `split` |
| `placement-cell/records` | `students_read_staff` excludes `placement_cell`; a director's student list reached the placement cell | `role` |
| `placement-cell/reports` | same, for per-department counts | `role` |
| `placement-cell/dashboard` | same, plus `student_placement_profiles` excludes `director` | `role` |

The proofs are against the repository's migrations, not the hosted database.

### 10.6 Invalidation

A family is versioned per college: a write calls
`invalidateCacheFamily(family, collegeId)` — one `INCR` — and every page, sort,
search and viewer of that family in that college misses on its next read.
Value and version are read in one `MGET`; an entry carries the version it was
computed under, so a write racing a read leaves the read's entry stale, not
wrong. Counters expire a day after the last write (values live ≤ 300 s).
Writes now invalidate unconditionally, so mobile-API writes clear the web
lists too.

| Family | Written by | Stale window after a write |
|---|---|---|
| `list:courses`, `list:users`, `list:placements`, `list:fees`, `list:payments`, `stats:fees`, `list:scholarships`, `finance-refunds`, `finance-disputes`, `decisions`, `attention`, `hod-approvals`, `hod-corrections`, `hod-substitutions`, `list:companies`, `list:placement_drives`, `list:student_placement_records`, `list:colleges` (scope `platform`), `list:hostel-complaints`, `gatepasses`, `warden-transfers` | the actions in the same file (web and mobile API paths) | 0 s |
| Dashboards, analytics, reports, rooms, faculty, hostel rollup, placement overview / funnel, finance exceptions | no write path of their own | TTL (30–300 s) |
| Middleware profile (role / status) | every role or status write, and invitation acceptance — pinned by `tests/profile-cache-invalidation.test.ts` | 0 s (20 s if the delete itself fails) |

The middleware profile entry is a routing hint, never a security boundary:
`requireRole()` re-reads role and status uncached, RLS is live, and college
lifecycle / session admission (`registerSession`) is read uncached on every
request. A Redis failure on that entry reads PostgreSQL.

### 10.7 Observability and alerts

Events go to Workers Logs (enabled in `wrangler.jsonc`), the existing
channel — server-side Sentry is never initialised. One flat object per event
(`lib/redis-telemetry.ts`):

| Event | Fields |
|---|---|
| `redis.op` | `op` (`ratelimit`, `cache.read`, `cache.write`, `cache.delete`, `cache.version`), `outcome` (`ok`, `timeout`, `auth`, `malformed`, `error`, `circuit_open`), `ms` |
| `redis.ratelimit` | `bucket`, `outcome` (`allowed`, `denied`, `fail_open`, `fail_closed`), `reason`, `ms` |
| `redis.cache` | `family`, `outcome` (`hit`, `miss`, `stale_version`, `bypass`, `error`, `invalidated`), `reason`, `ms` |
| `redis.retry` | one per client retry |
| `redis.circuit` | `state` (`open`, `closed`) |

Never logged: keys, user / college ids, values, the client's error messages,
credentials, URLs. Successes are sampled (`REDIS_LOG_SAMPLE_RATE`, default
1 %); failures are always written, but an identical failure repeated within
5 s is coalesced into one line carrying `count` (sum `count`, absent = 1).

Suggested alert thresholds (Workers Observability queries; not configured —
creating them is a production change for the owner):

| Alert | Condition | Why not noisier |
|---|---|---|
| Redis down | `redis.circuit` `state=open` sustained > 2 min | one blip opens and closes within 10 s |
| Timeouts rising | `redis.op` `outcome=timeout`, sum(count) > 50 in 5 min | isolated timeouts are expected |
| Protected actions refused | `redis.ratelimit` `outcome=fail_closed`, sum(count) > 10 in 5 min | each is a user-visible 503 |
| Fail-open volume | `outcome=fail_open`, sum(count) > 500 in 5 min | flood buckets fail open on every request in an outage |
| Denial spike | `outcome=denied` per `bucket`, > 5× its 7-day baseline | needs a baseline before it is meaningful |
| Auth failure | any `outcome=auth` | a revoked or rotated token never heals itself |
| Latency | p95 of sampled `redis.op` `ms` > 300 for 15 min | sampled, so a short window is noise |

### 10.8 Tests

| Suite | Count | What |
|---|---|---|
| `tests/redis-integration.test.ts` | 18 | the real client, limiter, guard and cache against the emulator: healthy, slow, down, malformed, auth, circuit, recovery, namespaces, build scope, family invalidation, no secrets in logs |
| `tests/redis-keys-config.test.ts` | 34 | environment resolution (production refused outside a production build), timeout clamp, build id, list keys (empty, long, Unicode, special characters, colleges, scopes), scope guard, E2E isolation |
| `tests/middleware-rate-limit.test.ts` | 13 | anonymous / credentialed / forged / bearer / campus bucket selection, digests |
| `tests/cache-scope-registry.test.ts` | 95 | every cached read's scope, roles and proof |
| `tests/profile-cache-invalidation.test.ts` | 8 | every role/status write invalidates the profile entry |
| `tests/redis-telemetry.test.ts` | 5 | coalescing, sampling |
| `tests/rate-limit-policy.test.ts` | 120 | risk classes, high-risk list, table ↔ code drift |
| `e2e-redis/redis.spec.ts` (`playwright.redis.config.ts`) | 8 | the real app over HTTP: 101st anonymous request → 429, forged cookie still limited, `e2e:nexus:` keys with no raw IP, slow / down / malformed / auth pages still load fast, recovery |
| `scripts/redis-mutations.mjs` | 14 / 14 detected | the brief's adversarial mutations, files hash-restored |

The slow-Redis test was run against `main` and fails there (payment allowed
after 5,008 ms). Removing any ONE of the three timeout layers is not detected
by design — each alone bounds the call; removing all three is.

### 10.9 Performance — LOCAL, loopback emulator

In-process (`npx vitest run -c vitest.bench.config.ts`;
`bench/results/redis-latency-*.json`), p50 / p95 ms:

| | `main` | hardened |
|---|---|---|
| healthy — protected rate limit (n=300) | 2.8 / 5.3 | 3.0 / 5.0 |
| healthy — cached read (n=300) | 2.2 / 2.9 | 2.4 / 3.2 |
| Redis 3 s slow — protected rate limit (n=15) | 3039 / 3066, **allowed** | 0.1 / 1025, refused |
| Redis down — protected rate limit (n=15) | 4464 / 4537 | 0.1 / 76 |
| Redis down — cached read (n=15) | 8752 / 9009 | 0 / 0.2 |

`GET /login` over HTTP (`bench/http-latency.mjs`, `next dev` with webpack for
both), p50 / p95 ms:

| | `main` | hardened |
|---|---|---|
| healthy (n=100) | 74 / 126 | 58 / 78 |
| Redis 3 s slow (n=20) | 3061 / 3114 | 48 / 1064 (first request only) |
| Redis down (n=20) | 4386 / 4410 | 46 / 119 |

**Not measured:** in-region Worker → Upstash latency, timeout and retry rates
in production, and sustained load (still §8).

### 10.10 Known limitations

- Supabase Auth's own limits remain outside this repository and unread (§9).
- Bucket capacities — including the 2000/min credentialed ceiling and the
  300/min per-user limit — are not derived from traffic.
- The circuit is per isolate: each Worker isolate discovers an outage on its
  own (three bounded calls).
- A coalesced failure count still pending in an isolate that is recycled is
  lost; alert totals are approximate by that margin.
- 052/F-01 and D7 are unrelated and unchanged.

## 11. Admission order: the bucket follows a proven identity (2026-10-04, Phase 1B)

**The defect (Redis audit E1, reproduced).** The middleware charged every
request that *carried* a session cookie to one per-campus-IP bucket
(`ipCredentialed`, 2,000/min) **before** the cookie was checked. 2,000
requests with random cookie values from one device made every signed-in user
on that campus IP — and every anonymous visitor — get 429.

**The fix.** `lib/auth/session-identity.ts` verifies the access token's
signature locally, against the project's published keys (JWKS, fetched at
most once per 10 min per isolate; no network on the request path), and the
middleware picks the bucket by what was proven:

| Request | Pre-auth bucket | After `getUser()` |
|---|---|---|
| no credentials | `ip:<campus>` 100/min (shared) | — |
| forged / garbled cookie or bearer | `ip:<campus>` 100/min (shared) | — |
| correctly signed token, valid or expired | `user:<id>` 300/min (that person only) | — |
| correctly signed, but the session is dead | `user:<id>` | also `ip:<campus>` |
| unverifiable: an HS256 token, JWKS unreachable, or a key ID not in this isolate's cached set that it may not refetch for yet (≤ 60 s since the last fetch) | `ipCredentialed:<campus>` 2,000/min (shared) | `user:<id>`, or `ip:<campus>` when Supabase rejects it |

Nothing here authorizes anything: `getUser()`, session admission,
`requireRole()` and RLS are unchanged. The identity only chooses a bucket.

**Attack results** (`tests/middleware-campus-isolation.test.ts`: the real
middleware and limiter against the Upstash emulator, real ES256 tokens):

| Attack | Result |
|---|---|
| one user, 400 requests | held to 300; a neighbour on the same IP gets 200 |
| 2,000 forged-cookie requests | held to the anonymous 100; every signed-in campus user gets 200 |
| forged tokens naming a real user (wrong key) | cannot touch that user's bucket |
| dead session, signed, replayed 150 times | held to the anonymous 100 |
| 5 attacker accounts × 400 | held to 5 × 300; nobody else affected |
| 20 IPs × 120 forged requests | held to 100 per IP; campus users unaffected |
| 10 and 100 signed-in users × 50 requests, one IP | nobody refused (the old 2,000/min shared bucket would refuse 3,000 of 5,000) |
| key rotation: 100 users on a newly rotated key, inside the refetch window | nobody refused (calling them forged would put 500 requests in the 100/min anonymous bucket) |

Against the previous middleware, the forged-flood, account-rotation and
100-user tests fail.

A key ID is called forged only by a key set fetched for that request. Calling
it "unverifiable" otherwise gives an attacker nothing: any HS256 header
already reaches that path, and a token Supabase rejects is still charged to
the strict per-IP bucket. A failed rotation refetch backs off for 30 s.

**Trade-offs, stated.**

- *Anonymous traffic on one NAT still shares one bucket.* Without an identity
  there is nothing else to count by. One device flooding anonymously (or with
  forged cookies) can make the login page answer 429 for other not-yet-signed-in
  people on that IP; signed-in people are unaffected. Edge rules (Cloudflare
  WAF / rate limiting) are the layer for this; none is configured by this repo.
- *IP rotation* defeats any per-IP limit, by definition. Each address is held
  to 100/min.
- *Account rotation* is bounded by accounts held: accounts are invite-only and
  each is held to 300/min, attributable and revocable. There is deliberately no
  shared ceiling for verified users — a shared ceiling is exactly what one
  campus can exhaust.
- *A stolen token* (correctly signed) can spend its owner's bucket. That
  presupposes the account is already compromised.
- **Residual risk — owner check.** The project's JWKS publishes an ES256 key
  (read 2026-10-04 and again 2026-10-05 from the public endpoint: one key, ES256 on P-256), but whether it is the CURRENT
  signing key — or a standby while sessions are still signed HS256 with the
  legacy secret — is hosted state this repository cannot read. If sessions are
  HS256, every token is "unverifiable" and the shared 2,000/min ceiling applies
  again (the last test in the file shows it). Check Supabase dashboard →
  Project Settings → JWT Keys: the current key should be ECC (P-256).

**What each layer controls.**

| Control | Academic Nexus | Redis | Supabase Auth (GoTrue) |
|---|---|---|---|
| password attempts, sign-in, password-reset emails | no — the browser calls GoTrue directly (§9) | no | yes, its own limits (dashboard; values unread) |
| page and API request floods | yes, the middleware | holds the counters | — |
| per-action limits (payments, approvals, …) | yes, every action | holds the counters | — |
| session validity, revocation, device limits | yes, `register_current_session` (PostgreSQL) | no | issues and refreshes tokens |
| who a token belongs to (for rate limiting) | yes, signature check against GoTrue's public keys | no | signs the tokens |
