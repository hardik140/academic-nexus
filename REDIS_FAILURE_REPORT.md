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
| Redis returns a stale value | TTL-bounded by construction | Reasoned, not simulated |
| Redis slow / timeout | — | **NOT TESTED** — needs a fault-injecting proxy |

The "slow" case is worth naming honestly: the Upstash client is HTTP, and a
hung request would block the action for as long as the platform's own
timeout allows. No timeout is configured explicitly. **Open item.**

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
| Global per-IP ceiling | allowed, logged | FAIL OPEN | Otherwise a Redis blip is a total site outage |
| First-party data entry (attendance, marks, own applications) | allowed, logged | FAIL OPEN | RLS confines it; approval still required |
| Cached list / dashboard reads | live database read | FAIL OPEN (degraded) | A cache outage must not be a data outage |
| Middleware profile cache | live database read | FAIL OPEN (degraded) | Routing only; `requireRole()` re-reads uncached anyway |

**Every FAIL OPEN is enumerated in `lib/rate-limit-policy.ts` with its
reason, and `tests/rate-limit-policy.test.ts` fails if any entry lacks one.**

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
| Role or status change | explicit `invalidateCache(middlewareProfileCacheKey(userId))` on every write that changes either | 0 s |
| Invitation accepted (`pending` → `active`) | explicit | 0 s |
| Cache delete fails during a Redis fault | none — the key rides out its TTL | **20 s** of stale routing |

That 20-second worst case is bounded and does not grant access: the
middleware profile cache decides **which page shell to serve**, never what
data comes back. `requireRole()` re-reads role and status **uncached** on
every mutation, and RLS is live underneath both. A stale read can at worst
let an already-authenticated browser keep loading a shell it no longer
belongs on, for up to 20 seconds, while every action on it is refused.

**Classification: PARTIAL — accepted, bounded, documented.**

---

## 5. Not tested

- Timeout and slow-response behaviour (no fault-injecting proxy).
- Sustained load against Redis (Phase 44) — see `PERFORMANCE_TEST_REPORT.md`.
- Behaviour during a genuine Upstash incident, as opposed to a simulated one.
