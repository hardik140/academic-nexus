# Redis transformation — current status

Last updated 2026-10-05 (checkpoint: merge order, rebase readiness, owner checks). Program: "Academic Nexus — Redis Architecture
Transformation Program", continued by "Phase 0 Blocker Resolution + Safe
Phase 1 Preparation". Audit: `f361b48` (verdict ARCHITECTURALLY MIXED).

Labels: **LOCAL** = measured on this machine (loopback Upstash emulator,
throwaway PostgreSQL); **PREVIEW / PRODUCTION** = measured there (none yet);
**UNVERIFIED** = not measured.

## Pull requests

| PR | Scope | Base | State |
|---|---|---|---|
| #123 | Redis production hardening (baseline) | `main` | open, CI green on `f7e14aa` |
| #124 | Phase 0: metrics, credential-source isolation, latency probe | #123 | **draft**: gate blocked on infrastructure |
| #125 | Phase 1A: finance sync, at most one external posting | `main` | open, CI green on `15f3138` |
| #126 | Phase 1B: rate-limit bucket follows a proven identity | #123 | open, `28b1c46`; CI runs once based on `main` |
| #127 | P0 found during Phase 1: six helpers called `supabase.rpc` detached and threw on every call (session admission, academic, gate security, a cron) | `main` | open, CI green on `dc57072` |
| #128 | Phase 1 cache truncation: fee totals in PostgreSQL | #123 | open, `c118fbc`; CI runs once based on `main` |

## Merge graph

From git history, not PR numbers. #127, #123 and #125 each branch from
`main` (`afd8687`) and share no files, so git needs no order among them.
#124, #126 and #128 contain #123's two commits.

| PR | Git dependency | Runtime dependency | Merge order |
|---|---|---|---|
| #127 | none | none | 1: P0, every signed-in request fails without it |
| #123 | none | none | 2 |
| #125 | none | none | 3, any time after #127 |
| #126 | #123 | #127: until then its branch carries the detached `rpc` | 4: retarget to `main` after #123, rebase, CI |
| #128 | #123 | #127, same reason | 5: same as #126 |
| #124 | #123 | none | last; stays draft until the Phase 0 gate passes |

All five open PRs merged together into `main` locally without a conflict
(verification below). Merging is an owner action: the automated merge of #127
was refused by this environment's permission policy, so nothing is merged.

A push to `main` runs CI's `deploy` job, which builds and deploys only when
the `CLOUDFLARE_API_TOKEN` repository secret exists. It does not exist today
(checked 2026-10-05), and the last Worker deployment is 2026-09-20, before
#117 to #122 merged. If that secret is ever added, merging to `main` deploys.

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
| **All five combined** (`main` + #127 + #123 + #125 + #126 + #128), 2026-10-05 | **2971 / 2971** | clean / 0 errors | production, dev-routes check, Worker: pass | 419 / 420; the one failure was `net::ERR_NO_BUFFER_SPACE` on this machine, and its spec passed 18 / 18 alone. Redis 8 / 8 | mutations 14 / 14; the 115 Phase 1 tests pass |

**Added 2026-10-05**, each shown to fail against the code it guards:

- **#127:** a signed-in `@supabase/ssr` client sends the user's own access
  token on every helper's RPC, so RLS evaluates as that user. Without the
  session cookie it sends the anon key and the test fails.
- **#126, a fix:** a token signed with a key the project had just rotated to
  was called forged while the isolate's key set was under 60 s old, so every
  signed-in user fell into the strict anonymous bucket. End to end, 400 of
  500 requests from 100 users were refused. An unknown key ID is now forged
  only if a key set fetched for that request lacks it, and a failed refetch
  backs off for 30 s.
- **#128:** parity at 1, 999, 1,000, 1,001, 1,500 and 20,000 fees with mixed
  statuses, and for every role the total equals what that role's RLS lets it
  read. A SECURITY DEFINER version fails 20 of those. College isolation is
  tested both ways. There is no date filter to test: neither old call site
  had one.
- **#123:** the anonymous-limit E2E allowed exactly 100, but the sliding
  window admits a few more across a minute boundary, and it failed once on
  101. It now requires 100 to 110.
- **#125:** the Zoho search-consistency assumption is labelled at the
  pre-flight lookup in the code, not only in the PR.

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
  sign sessions with its ES256 key. Re-read 2026-10-05, the public JWKS holds
  exactly one key, ES256 on P-256. Supabase also publishes a standby key there
  before rotation, so that does not prove it is the current signing key.
  **UNVERIFIED** until the owner reads Supabase → Project Settings → JWT Keys.
  If it shows the legacy HS256 secret as current: **HOSTED CONFIGURATION
  REQUIRES DECISION**. Nothing here changes authentication configuration.

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
| Rate limit: signing-key rotation does not lock users out | yes, fixed 2026-10-05 |
| Regression: existing Redis tests, E2E, TypeScript, ESLint, production and Worker builds | yes, per the table above, with the noted flakes |

**Phase 1: PASS at code and test level, LOCAL, verified combined on the
corrected base.** Nothing is merged or deployed, 056 and 057 are not applied,
and the HS256 versus ES256 owner check is open.

## External-provider assumptions, all UNVERIFIED

- **Zoho Books search is immediately consistent after a create.** The retry
  pre-flight depends on it. If search lags, a retry soon after a 5xx that did
  create the payment can post a second one. UNVERIFIED EXTERNAL PROVIDER
  ASSUMPTION; no Zoho test organisation is available.
- **Tally treats a resent REMOTEID as an alteration**, not a new voucher.
  That is Tally's documented behaviour, not tested against a running Tally.
- **Supabase signs sessions with the ES256 key** the JWKS publishes. Owner
  check above.
- **Supabase Auth's own limits** on sign-in, sign-up and password-reset
  emails. Passwords go from the browser straight to Supabase Auth, so these
  are Supabase's controls, not Academic Nexus's or Redis's. Values not read.
- **PostgREST `max_rows`** on the hosted project is assumed to be the default
  1,000.

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

**Uncached, same defect. Designs only; Phase 3 implements them.** Neither
may be fixed by raising a row limit: an API row cap must never become a
business-process cap.

- **Announcement fan-out** (`sendAnnouncementCore`). BUG, two caps:
  - The recipient select returns at most 1,000 profiles, so an announcement
    to "all" in a 3,000-person college reaches the first 1,000.
  - The device-token lookup sends every recipient id in one `in(...)` filter,
    capped the same way, and with thousands of ids the request URL itself
    can exceed the gateway's limit.

  Design: one database function, `send_announcement(title, message, audience)`.
  It checks the caller's role and college inside, runs one
  `INSERT INTO notifications … SELECT … FROM profiles WHERE college_id = …`
  with the audience filter, and returns the count. No ids cross the wire.
  Push delivery reads device tokens by keyset pages
  (`WHERE id > $last ORDER BY id LIMIT 500`) joined to that announcement's
  rows, and sends Expo batches of 100. If a page fails it is retried; the
  in-app notification rows are already committed.
- **Finance "Sync now"** (`syncNow`). BUG, three problems:
  - The payments select is capped, so a window with more than 1,000 cleared
    payments queues 1,000, silently.
  - A failed payments read is ignored and reported as "nothing to queue".
  - It enqueues one payment at a time, two or three requests each, so a
    large window also runs into the Worker's per-invocation subrequest limit.

  Design: one database function, `queue_finance_sync(connection, from, to)`.
  It runs `INSERT INTO finance_sync_operations … SELECT … FROM payments p
  WHERE … AND NOT EXISTS (link) ON CONFLICT (connection_id, idempotency_key)
  DO NOTHING`. The key must be derived exactly as `lib/finance/idempotency.ts`
  derives it, pinned by a parity test, or a TypeScript enqueue and a SQL one
  could queue the same payment twice. The function returns queued and
  skipped counts. It is one statement, atomic and
  uncapped, and re-running it queues nothing twice. Workers then claim
  queued rows in batches with #125's compare-and-swap claim, which already
  guarantees one claim per operation.

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
- **Feasibility, checked 2026-10-05:** `register_current_session` already
  loads the whole profile row (`SELECT * INTO v_profile`) before deciding,
  and the middleware uses only that row's existence, `status` and `role`.
  Returning `role` and `college_id` in its JSON costs no extra query.
  Inactive accounts already come back as `state: inactive`.
- **Decision: PHASE 2 CANDIDATE**, not a Phase 1 defect. Remove in Phase 2,
  with before and after measurements, once the Phase 0 and Phase 1 gates
  pass.

## Every future Redis change must answer

What problem Redis solves · why PostgreSQL cannot · measured baseline ·
measured improvement · behaviour when Redis fails · behaviour when Redis is
slow · what can go stale · invalidation · memory · command cost · rollback.
