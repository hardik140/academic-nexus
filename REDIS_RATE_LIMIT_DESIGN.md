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

The limiter is `@upstash/ratelimit` v2.0.8 `slidingWindow`, keyed per action.

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
