# Redis failure behaviour

Phases 16 and 22. What each feature does when Redis is not there.

Redis is used for exactly three things (`REDIS_RATE_LIMIT_DESIGN.md` §1):
rate limiting, a read-through cache, and a 20-second middleware profile
cache. **No business fact lives in it**, so no failure below can lose or
corrupt data — the question is only whether a control silently stops
applying.

---

## 1. Simulated conditions

| Condition | How it was simulated | Tested |
| --- | --- | --- |
| Redis available | live Upstash | Yes — `REDIS_RATE_LIMIT_DESIGN.md` §4 |
| Redis unconfigured (`redis === null`) | module mock | Yes — `tests/rate-limit-policy.test.ts` |
| Redis call throws (outage, reset, quota) | client whose `eval` throws | Yes — `tests/rate-limit-policy.test.ts` |
| Redis returns a stale value | TTL-bounded by construction; versioned families (2026-10-04) | Yes — `tests/redis-integration.test.ts` (family invalidation) |
| Redis slow / timeout | local Upstash emulator answering late (2026-10-04) | Yes — `tests/redis-integration.test.ts`, `e2e-redis/redis.spec.ts` |
| Redis malformed answer / auth failure | emulator (2026-10-04) | Yes — same |
| Redis recovery | emulator back to healthy, circuit probe (2026-10-04) | Yes — same |

The "slow" case was the open item here, and testing it found a defect:
`@upstash/ratelimit` resolves its own timeout as `success: true`, so a slow
Redis ALLOWED every fail-closed action (a payment was allowed after 5,008 ms
on `main`). Fixed on 2026-10-04 — a timeout, a malformed answer and an open
circuit are now "unavailable" and the bucket's class decides; every call is
bounded by `REDIS_TIMEOUT_MS` (default 1000 ms). Full table and evidence:
`REDIS_RATE_LIMIT_DESIGN.md` §10.

---

## 2. Per-feature behaviour

| Feature | Redis down | Classification | Why |
| --- | --- | --- | --- |
| Login | unaffected — never touches Redis, or this app at all | n/a | Design doc §9 |
| Password reset | unaffected, same reason | n/a | Design doc §9 |
| **Payment, refund, invoice, scholarship, dispute** | **refused, 503** | **FAIL CLOSED** | Moves money |
| **Invitations, role/status changes, college creation** | **refused, 503** | **FAIL CLOSED** | Changes identity |
| **Security authorization, gate assignment, credential revocation** | **refused, 503** | **FAIL CLOSED** | Grants authority |
| **Approvals** (gate pass, leave, attendance correction, room transfer) | **refused, 503** | **FAIL CLOSED** | Authorizes something that then happens |
| **Academic structure** (departments, courses, semesters, transitions) | **refused, 503** | **FAIL CLOSED** | Admin mutation |
| Gate scan | allowed, logged | **CONTROLLED FALLBACK** | Signature + DB state machine are the real control; refusing strands people at a barrier |
| Gate credential issue | allowed, logged | **CONTROLLED FALLBACK** | Same |
| Guard movement feed | allowed, logged | FAIL OPEN | Read-only |
| Global ceilings (`ip`, `ipCredentialed`, `user`) | allowed, logged | FAIL OPEN (flood class) | Otherwise a Redis blip is a total site outage |
| First-party data entry (attendance, marks, own applications) | allowed, logged | FAIL OPEN | RLS confines it; approval still required |
| Cached list / dashboard reads | live database read | FAIL OPEN (degraded) | A cache outage must not be a data outage |
| ~~Middleware profile cache~~ | removed in Phase 2.1: session admission returns the role (migration 058) | — | Role and status are read live on every request |

**Every FAIL OPEN is enumerated in `lib/rate-limit-policy.ts` with its
reason, and `tests/rate-limit-policy.test.ts` fails if any entry lacks one.**

"Redis down" here means any of: unconfigured in production, unreachable,
timed out, malformed answer, auth failure, or circuit open (2026-10-04). Each
costs at most one `REDIS_TIMEOUT_MS`; once the circuit is open, nothing.

---

## 3. What changed

Before this pass, **every row above was FAIL OPEN**, including all the bold
ones, and nothing logged it. A missing environment variable on a new
deployment produced an application with no rate limiting at all and no
indication of it.

The default is now DENY: a bucket nobody classified fails closed.

---

## 4. Stale cache (Phase 37)

| Change | Invalidation | Worst case |
| --- | --- | --- |
| Role or status change | none needed since Phase 2.1: the middleware reads both live from session admission (058) | 0 s |
| Invitation accepted (`pending` → `active`) | none needed, same reason | 0 s |
| A list or queue changes (web OR mobile API write) | the family's version counter for that college is bumped (2026-10-04); before, only the editor's own view was deleted and mobile writes deleted nothing | 0 s |

Until Phase 2.1 a role or status change could take up to 20 s to reach
routing if the cache delete failed. That window is gone: the middleware no
longer caches the profile (`tests/middleware-admission-profile.test.ts`
pins a role change and a suspension applying on the next request).

**Classification: PARTIAL — accepted, bounded, documented.**

---

## 5. Not tested

- ~~Timeout and slow-response behaviour~~ — tested 2026-10-04 against a local
  emulator (`REDIS_RATE_LIMIT_DESIGN.md` §10).
- Hosted Upstash latency from the Worker — the 1000 ms budget rests on one
  recorded cold call (639 ms), not on in-region measurement.
- Sustained load against Redis (Phase 44) — see `PERFORMANCE_TEST_REPORT.md`.
- Behaviour during a genuine Upstash incident, as opposed to a simulated one.
