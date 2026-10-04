# Redis transformation — current status

Last updated 2026-10-04. Program: "Academic Nexus — Redis Architecture
Transformation Program", continued by "Phase 0 Blocker Resolution + Safe
Phase 1 Preparation". Audit: `f361b48` (verdict ARCHITECTURALLY MIXED).

Labels: **LOCAL** = measured on this machine (loopback Upstash emulator,
throwaway PostgreSQL); **PREVIEW / PRODUCTION** = measured there (none yet);
**UNVERIFIED** = not measured.

## Pull requests

| PR | Scope | Base | State |
|---|---|---|---|
| #123 | Redis production hardening (baseline) | `main` | open, ready for merge |
| #124 | Phase 0: metrics, credential-source isolation, latency probe | #123 | **draft**: gate blocked on infrastructure |
| #125 | Phase 1A: finance sync, at most one external posting | `main` | open |
| #126 | Phase 1B: rate-limit bucket follows a proven identity | #123 | open |
| #127 | P0 found during Phase 1: six helpers called `supabase.rpc` detached and threw on every call (session admission, academic, gate security, a cron) | `main` | open, CI green |
| #128 | Phase 1 cache truncation: fee totals in PostgreSQL | #123 | open |

Nothing is deployed. No migration (056, 057) is applied to a hosted database.
`bench/audit/finance-sync-race.audit.ts` (this branch) asserts the behaviour BEFORE
#125 (two posts); flip it to one when #125 merges.
No Upstash database was touched by any of this work.

## VERIFIED

All LOCAL. Each branch was run in full on this machine. "Flaky" means a
timing-dependent test outside the change that failed under full-suite load and
passed when re-run alone.

| PR | Unit | TypeScript / ESLint | Builds | E2E | Other |
|---|---|---|---|---|---|
| #124 Phase 0 | 2887 / 2887 | clean / 0 errors | production, Worker, dry run with the metrics binding: pass | 420 / 420; Redis 8 / 8 | probe validated LOCAL |
| #125 finance | 2659 / 2659 | clean / 0 errors | pass | 419 / 420; the one failure, a sidebar-drawer hydration test, passed 90 / 90 when its spec was re-run 3× | 20 real-PostgreSQL tests, 11 of which fail against the old code; CI green |
| #126 rate limit | 2898 / 2899 (1 flaky, passes alone) | clean / 0 errors | pass | 420 / 420; Redis 8 / 8 | mutations 14 / 14; attack matrix 9 / 9, 3 of which fail against the old code |
| #127 rpc binding | 2647 / 2647 | clean / 0 errors | pass | 420 / 420 | 7 of its 8 tests fail against `main`; CI green |
| #128 fee totals | 2878 / 2879 (1 PGlite timeout, 57 / 57 alone) | clean / 0 errors | pass | 420 / 420 | parity over 1,500 fees |

**Finance (Phase 1A).** Root cause: an unconditional claim, plus the 049
guard letting PROCESSING → PROCESSING through. 2, 20 and 100 workers made 2,
20 and 100 documents before, and 1 after. Either layer alone holds: the
compare-and-swap claim under the 049 guard, or the old code with 056.
Ambiguous outcomes: Tally is idempotent by REMOTEID. Zoho has no idempotency
key, so timeouts, unparseable answers and fetch rejections on a POST go to
reconciliation. Before any retry, the receipt is looked up by reference.
Exactly-once is NOT claimed. At most one document is proved for every tested
scenario. Zoho's search consistency is UNVERIFIED.

**Rate limiting (Phase 1B).** Root cause: a shared per-IP bucket charged
before the cookie was checked. New flow: verify the token's signature locally,
then charge that user's bucket; anonymous and forged traffic is charged to the
strict per-IP bucket. Attack results are in `REDIS_RATE_LIMIT_DESIGN.md` §11.

**Found on the way (P0, #127).** `supabase.rpc` was called detached in six
places, which throws on every call. That breaks session admission for every
signed-in request, plus academic RPCs, gate-security RPCs and a cron, on any
deployment of `main`.

## CODE-VERIFIED BUT INFRASTRUCTURE-BLOCKED

- **Redis metrics** (#124, `lib/redis-metrics.ts`). One unsampled Analytics
  Engine data point per Redis event, tested for layout and for never carrying
  a key, id or value. The binding is in `wrangler.jsonc`, and a dry run
  recognises it. No data exists until a deploy you approve.
- **Production-only Upstash credentials** (#124, `scripts/sync-cf-secrets.mjs`).
  Refusals are tested for the development host, the development token, a
  malformed URL and a half-set pair. Not run against Cloudflare.
- **Upstash latency probe** (#124, `bench/upstash-probe/`). Works LOCAL under
  `wrangler dev`, refuses production and non-preview environments, and leaves
  no keys. Not deployed.
- **Failure decisions** (#123): every risk class against down, slow,
  malformed, auth failure and circuit open. LOCAL, emulator.
- **Campus isolation** (#126). Its full effect requires the hosted project to
  sign sessions with its ES256 key. The JWKS publishes one; whether it is the
  current signing key is hosted state (owner check: Supabase → Project
  Settings → JWT Keys).

## INFRASTRUCTURE-BLOCKED

- Worker → Upstash latency (p50/p95/p99, cold vs warm): needs a
  non-production Upstash database and a probe deploy.
- Real cache hit ratios, command rates and payload sizes: need the metrics
  binding deployed.
- Real Redis saturation and memory behaviour.
- Supabase Auth's own sign-in and password-reset limits: no management token.
- PostgREST `max_rows` on the hosted project: the truncation findings below
  assume Supabase's default of 1,000.

Owner steps: `REDIS_TRANSFORMATION_PHASE0.md` §4.

## NOT STARTED (gated)

- Phase 2: stampede protection, profile-cache removal, round-trip reduction,
  background cache writes, key reassessment.
- Phase 3: the remaining PostgreSQL aggregations (below), stale-while-revalidate,
  the classification of all 46 cached reads into keep / remove / rewrite.
- Phase 4: idempotency acceleration, deduplication, queues, counters.
- Performance certification at 10× / 50× / 100×.

## Phase 1 gate

| Item | Status |
|---|---|
| Finance: duplicate race reproduced | yes: real PostgreSQL, real pipeline code |
| Finance: PostgreSQL fix implemented | yes: compare-and-swap claim plus 056 |
| Finance: concurrent and retry tests pass | yes: 20 / 20 |
| Finance: ambiguous external response analysed | yes, per provider |
| Finance: idempotency guarantees documented | yes: #125, and the pipeline and adapter comments |
| Rate limit: campus lockout reproduced, root cause identified | yes |
| Rate limit: admission flow corrected | yes |
| Rate limit: anonymous protection preserved | yes: strict per-IP bucket unchanged |
| Rate limit: authenticated user isolation proven | yes, LOCAL. Full effect needs the ES256 signing key current (owner check) |
| Rate limit: forged cookie, NAT, account rotation and IP rotation tested | yes |
| Regression: existing Redis tests, E2E, TypeScript, ESLint, production and Worker builds | yes, per the table above, with the noted flakes |

**Phase 1: PASS at code and test level, LOCAL.** Nothing is merged or
deployed, 056 and 057 are not applied, and the HS256 versus ES256 owner check
is open.

## Cache truncation: every cached read with an unbounded query

PostgREST returns at most `max_rows` rows (Supabase default 1,000) to a select
with no range, without an error. Hosted value: UNVERIFIED. Expected sizes are
for a college of about 3,000 students.

| Read | Unbounded query | Expected rows | Classification | Status |
|---|---|---|---|---|
| finance dashboard fee totals | all fees | ~12,000 | BUG → POSTGRES AGGREGATION | **fixed** (#128, 057) |
| `getFeeStats` | all fees of the college | ~12,000 | BUG → POSTGRES AGGREGATION | **fixed** (#128, 057) |
| `getStudentRiskOverview` | students, fees, failed enrolments | 3,000 / 12,000 / varies | BUG → POSTGRES AGGREGATION | open |
| `listFaculty` (attendance and marks counts per teacher) | attendance rows for 25 teachers | ~75,000 | BUG → POSTGRES AGGREGATION | open |
| finance reports | all fees with department | ~12,000 | BUG → POSTGRES AGGREGATION (`mv_fee_summary` covers part) | open |
| `getFinanceExceptions` | all fees and all payments | ~12,000 each | BUG → filter and aggregate in SQL | open |
| `getPlacementReports` | placed and joined placements | grows by about 1,000 a year | BUG over time → POSTGRES AGGREGATION | open |
| `listDepartmentFacultyWorkload` (director scope) | offerings, timetable slots | slots ≈ 5 × offerings, > 1,000 | BUG at college scope → POSTGRES AGGREGATION | open |
| HOD reports | enrolments of the department | ~3,600 | BUG → POSTGRES AGGREGATION | open |
| `getHostelRollup` | rooms, pending gate passes, open complaints | rooms can pass 1,000 | NEEDS POSTGRES AGGREGATION (counts) | open |
| `listFinancialDisputes` | every dispute of the college | low, grows | NEEDS PAGINATION | open |
| `listSubstitutionNeeds` | assigned substitutions (history) | grows over a term | NEEDS EXPLICIT LIMIT or PAGINATION | open |
| `listDepartmentHealth` | open risk flags | low | SAFE (bounded by the detector) | — |
| admin roles matrix | permissions, role_permissions | ≤ a few hundred, global | SAFE (NEEDS HOSTED VERIFICATION of row count) | — |
| director analytics | per-department views | departments | SAFE | — |
| placement funnel | per-department view | departments | SAFE | — |
| `listMyRiskFlagAssignments` | flags assigned to one person | small | SAFE | — |
| `listHodApprovals` | staff of one department | < 100 | SAFE | — |
| `listCorrectionApprovals` | offerings of one department | < 1,000 | SAFE | — |
| HOD dashboard | teachers and courses of one department | < 200 | SAFE | — |
| `listStudentPlacementRecords` | placements for one page of students | ≤ page size × few | SAFE | — |
| warden dashboard | rooms of the warden's blocks | < 1,000 | SAFE | — |
| `listPendingGatePasses` | pending passes | small | SAFE | — |
| `getGateOperationsSnapshot` | active and approved passes | hundreds | SAFE | — |

**Uncached, same defect.**

- **Announcement fan-out** (`sendAnnouncementCore`) selects every recipient
  profile, so an announcement to "all" in a 3,000-person college reaches the
  first 1,000. BUG → one `INSERT … SELECT` RPC. Open.
- **Finance "Sync now"** selects cleared payments in a date window, so a month
  with more than 1,000 queues only 1,000, silently. BUG → NEEDS PAGINATION. Open.

Open items are Phase 3 work. None of them crosses a tenant or role boundary:
they are incomplete answers, not leaks.

## Profile cache: analysed, not removed

- **Readers:** one, the middleware. It uses `status` and `role`.
- **Invalidations:** eight sites (user admin, placement-cell promotion and
  revocation, invitation acceptance).
- **Overlap with session admission:** `register_current_session` (054) reads
  the same profile row on every request, uncached, and already refuses an
  inactive account. So the status check is redundant.
- **Not redundant yet:** admission returns only `{ state }`, and the middleware
  still needs `role` to route. Removing the cache needs the RPC to return the
  role and status it already reads, which means a migration and a middleware
  change.
- **Cost today:** one Redis GET per signed-in request, warm, or a GET, a
  database read and a SET, cold. The audit's race test showed a deleted entry
  can be re-written with the pre-change value for up to 20 s. That affects
  routing only, because admission and `requireRole()` are uncached.
- **Decision:** remove in Phase 2, with before and after measurements. The
  brief defers profile-cache removal until the Phase 0 and Phase 1 gates pass.

## Every future Redis change must answer

What problem Redis solves · why PostgreSQL cannot · measured baseline ·
measured improvement · behaviour when Redis fails · behaviour when Redis is
slow · what can go stale · invalidation · memory · command cost · rollback.
