# Redis transformation — Phase 2: Redis efficiency

Branch `feat/redis-phase2`, built on the five Phase 1 pull requests merged
together locally (#127, #123, #125, #126, #128). None of those is merged on
`main` yet, so this branch carries them until they are.

**Labels.** LOCAL means measured on this machine. The Redis round trips,
Redis commands, database queries and Auth calls below are **exact counts**:
the Upstash emulator and a counting Supabase fake record every one. The
**latency is modelled**: each Redis answer waits 4 ms, each database query
10 ms and each Auth call 15 ms. Worker → Upstash and Worker → Supabase
latency are still unmeasured, which is the open Phase 0 gate. Numbers are
the median of three alternating before/after runs
(`bench/results/phase2-summary.json`, produced by `bench/phase2.bench.ts`).

## Results

| Path | Before | After |
|---|---|---|
| Signed-in request, warm: Redis round trips | 2 | **1** |
| Signed-in request, cold (first in 20 s): Redis round trips | 3 | **1** |
| Signed-in request, warm: database queries | 1 | 1 |
| Signed-in request, cold: database queries | 2 | **1** |
| Signed-in request, warm: p50 / p95 / p99 | 40.9 / 43.2 / 48.9 ms | **33.9 / 36.1 / 41.3 ms** |
| Signed-in request, cold: p50 / p95 / p99 | 59.4 / 68.9 / 74.9 ms | **34.5 / 41.3 / 43.3 ms** |
| Cache miss, analytics read (write-behind): p50 / p95 / p99 | 23.1 / 24.3 / 31.9 ms | **16.5 / 17.5 / 22.5 ms** |
| Cache miss, other reads | 23.1 ms p50 | 23.3 ms p50 (unchanged by design) |
| Cache hit p50 | 6.5 ms | 6.6 ms (unchanged) |
| 10 / 50 / 100 concurrent identical misses: database queries | 10 / 50 / 100 | **1 / 1 / 1** |
| 100 concurrent identical misses: Redis round trips / wall time | 101 / 297 ms | **2 / 30 ms** |
| Recording a payment: invalidation round trips / time | 3 / 22.2 ms | **1 / 8.2 ms** |

Hit and miss ratios do not change in the benchmark (it reads each key once
cold and once warm, 0.5 by construction). In production the profile entry's
misses disappear entirely, because the entry does. Real ratios need the
Phase 0 metrics binding.

**Before migration 058 is applied**, the new middleware reads the profile
itself, uncached: 1 Redis round trip and 2 database queries per signed-in
request, warm p50 43.9 ms (`bench/results/phase2-after-without-058.json`).
That is slightly worse than today on database load. **Apply 058 first,
then deploy the code.** 058 only adds fields to the JSON, and the current
code ignores fields it does not read.

## 2.1 Profile cache: removed, on evidence

**Evidence.**
- `register_current_session()` (054) runs `SELECT * INTO v_profile FROM
  profiles WHERE id = auth.uid()` on every signed-in request, uncached,
  before it decides anything.
- The middleware then read `role, college_id, status` of the same row
  again, through a 20 s Redis entry: one GET per request, or a GET, a
  database read and a SET on a miss.
- That entry had eight invalidation sites.
- Its only reader was the middleware, which uses existence, `status` and
  `role`.

**Change.**
- Migration 058 returns `role`, `college_id` and `profile_status` from the
  row admission already loaded. An inactive profile answers
  `{ state: inactive, profile_status }`, and a missing profile answers a
  bare `{ state: inactive }`, so the middleware can still tell them apart.
- The middleware routes on those fields.
- Removed: the entry's read, write and eight invalidations, its key helpers,
  the exact-key delete and the build-scoping option that only it used, and
  the tests that pinned them.

**Behaviour.**
- A role or status change now applies on the next request. Before, it took
  up to 20 s if the delete failed.
- Redirects are unchanged: suspended goes to `account_suspended`, no profile
  to `no_profile`, an admission refusal to `/unavailable`.
- One ordering change. Admission now runs before the status check, because
  it is where the status comes from. For an inactive profile it answers
  before registering anything. If admission itself errors for a suspended
  account, the user lands on `/unavailable?reason=error` instead of the
  suspended-account login message. Both deny access.

**Security.** 058 returns only the caller's own row, data the caller can
already read through `profiles_read_self`. A real-PostgreSQL test checks
another user's call answers with that user's facts, not the caller's.

## 2.2 Redis round trips

| Path | Before | After | Decision |
|---|---|---|---|
| Signed-in middleware request | limiter script + profile GET (+ SET on a miss) | limiter script | profile entry removed (2.1) |
| Limiter check | one script call | unchanged | already one atomic command |
| Versioned cache read | one MGET of value and version | unchanged | already batched |
| Cache miss | read, then SET before responding | 19 analytics, catalog and count reads: SET after the response | 2.4 |
| One family invalidation | INCR + EXPIRE in one pipeline | unchanged | already one round trip |
| Recording a payment | 3 family invalidations, 3 round trips | 1 pipeline | `invalidateCacheFamilies` |
| Role or status change (admin users) | profile DEL + family INCR | family INCR | profile entry removed |
| Placement-cell promote, revoke, reactivate; invitation accepted | profile DEL | none | profile entry removed |

**Kept separate, on purpose.**
- **Pre-auth and post-auth limiter charges.** They hit different buckets,
  and the second runs only when the first could not settle the identity.
  Merging them would charge the wrong bucket.
- **A Server Action's limiter check, then its cache read.** The limiter
  decides whether the read happens at all, and the two have different
  failure policies: high-risk actions fail closed, reads fail open. One
  pipeline would tie them together.
- **Several cache reads on one page.** They already run in parallel with
  `Promise.all`, so latency is the slowest one, not the sum. An MGET across
  them would need a different cache API for a small gain.

## 2.3 Stampede protection

**Reproduced.** 100 concurrent identical misses made 100 database queries.

**Fix.** In-isolate single flight in `getCached`. The first miss runs the
fetcher, and the rest await its promise.
- **The flight key** is the full Redis value key plus the version read.
  Callers therefore share only what Redis would have given them anyway.
  A read after an invalidation never joins a fill that started before it.
- **A failure** is shared by the callers waiting on it and never kept. The
  next request tries again.
- **Uncacheable and unscoped keys** are never coalesced.

**Per isolate, deliberately.** A Worker isolate serves many requests at
once, so this removes the stampede inside each isolate. Across isolates a
miss costs at most one read per isolate. Coordinating that would need a
distributed lock, which this phase does not introduce.

**Tests** (`tests/cache-efficiency.test.ts`):
- 10, 50 and 100 concurrent misses each make 1 read, and the next wave is
  all hits;
- different college, viewer or page never share a flight;
- a read after an invalidation does not join an older fill;
- leader failure: every waiter gets the error, nothing is cached, and the
  next request recovers;
- a hung read holds only its own waiters;
- with Redis down, and with Redis timing out, the database is still read
  once.

Mutations removing the coalescing, or the version from the flight key, are
detected.

## 2.4 Write-behind cache fills

`getCachedWriteBehind` stores the fresh value with Next's `after()`, which
OpenNext runs on the Worker's `waitUntil`, instead of before responding.
Outside a request there is nowhere to defer to, so it writes first. A late
write of a versioned entry that lands after an invalidation carries the old
version and is never served (tested).

**Used by 19 reads.** These are analytics, catalogs and counts, where a
missing or late entry costs only a repeat database read:
- director analytics, department performance, faculty, dashboard counts;
- placement overview, funnel and placements list;
- HOD dashboard, faculty and reports;
- admin dashboard counts and course catalog;
- placement-cell dashboard, reports, companies, drives and records;
- warden dashboard and rooms.

**Not used** for anything in finance, approvals, decisions, risk flags,
gate passes, transfers, complaints, the hostel rollup (it carries
pending-gate-pass counts), audit, roles, users, college lifecycle or
substitutions. A test pins the exact list of files and fails if any
excluded area starts using it.

## 2.5 Cache key audit

Every key now has this shape:

```text
<env>:nexus:c:<build>:<key>        value
<env>:nexus:cv:<family>:<college>  family version counter
<env>:nexus:rl:v1:<bucket>:<id>    limiter window
```

- **Environment** keeps development and production apart in the shared
  database. **Build** keeps old and new Workers from reading each other's
  value shapes.
- **College** is in every tenant key. **Role** or **user** is added exactly
  where RLS gives roles or users different rows.
  `tests/cache-scope-registry.test.ts` declares each of the cached reads
  with its scope and the RLS policies that justify it, and fails when a
  read is added, its roles change, or a cited policy disappears. It had
  silently stopped seeing the 19 write-behind reads until its scan was
  widened (55 tests became 93).
- **Lists** carry page, sort column and direction, and a digest of the
  normalised search. Pages above a bound and searches over 100 characters
  are not cached. Keys over 200 characters are refused, and a key with an
  `undefined`, `null` or empty segment bypasses the cache.

**Findings.**
- **Removed:** the highest-cardinality family, one profile entry per
  signed-in user every 20 s, and the `shared` build segment that only it
  used.
- **No dimension was removed elsewhere.** Every user and role dimension is
  backed by a real RLS difference in the registry. Removing one would merge
  answers that RLS keeps apart.
- **Key explosion is bounded.** List variants per college are pages × sorts
  × searches, each living 30 s and retired together by a version bump.

## 2.6 Invalidation

| Changed cache | Mutation → database → invalidation → next read | Test |
|---|---|---|
| Profile (removed) | role or status write → `profiles` → none needed → admission reads the row live | role change and suspension apply on the next request; a role matrix for every role in `ROLE_ROUTES` |
| Write-behind reads | write → table → family version bump (unchanged) → a late fill is never served | `cache-efficiency`: late write after invalidation |
| Payment families | payment → fees, payments → one pipeline bumps all three → all three miss | `cache-efficiency`: all three invalidated, college B untouched |
| Coalesced fills | invalidation during a fill → new version → new reader runs its own fill | `cache-efficiency` |

**Cross-college.** Keys are unchanged. Different colleges never share a
flight or an invalidation (tested), and 058 returns only the caller's row
(real PostgreSQL).

**Roles.** Every portal role is routed from admission's answer (tested).
`requireRole()` and RLS are untouched.

**Mobile.** The mobile session route never used the profile cache.

**Not tested here.** Browser flows per role against a real Supabase. Owner
decision D3 rules out authenticated flows against the production-equivalent
project.

## Release gate

| Item | Status |
|---|---|
| Profile cache decision made from evidence | done |
| Redundant profile cache removed if justified | done (058 + middleware) |
| Redis round trips reduced where beneficial | done |
| Stampede protection where needed | done (per isolate) |
| Concurrent stampede test passes | done |
| Background writes only where safe | done (19 reads, pinned) |
| Cache keys audited | done |
| Invalidation verified | done (unit and emulator level) |
| Cross-college isolation verified | done |
| Role isolation verified | done |
| Existing tests, TypeScript, ESLint, builds | see the pull request |
| Performance comparison recorded | done, LOCAL with modelled latency |

**Still open.**
- Real latency on Workers, and real hit ratios. Both need the Phase 0
  infrastructure: a non-production Upstash database and the metrics
  binding.
- Applying 058, before this code deploys.

## Rollback

- **Code:** revert the branch. With 058 applied, the old middleware ignores
  the extra fields.
- **Database:** re-run 054's definition of `register_current_session`.
