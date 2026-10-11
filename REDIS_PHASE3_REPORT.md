# Redis transformation — Phase 3: business correctness and bounded processing

Branch `feat/redis-phase3-business-correctness`, from `main` at `8b933ea`
(Phase 2 merged) plus `6b10580`, the real-PostgreSQL harness diagnostic fix.

**The defect class.** PostgREST returns at most `max_rows` rows (1,000 by
default on Supabase) to a select with no range, and returns no error. Every
read below fetched rows and then counted, summed, filtered or fanned them out
in the application. Past the cap the business answer was silently wrong, and
Redis then cached the wrong answer.

**The fix pattern.**

```text
PostgreSQL: aggregate, bounded batch or claim
    ↓
small deterministic result
    ↓
application
    ↓
Redis (optional, unchanged keys and invalidation)
```

Migration **059** holds the new functions; **060** makes "Sync now" a durable,
resumable run and pages reconciliation by keyset. No row limit was raised.

## Status labels

| Item | State |
|---|---|
| Implemented | yes, this branch |
| Local verified | yes, at `fe909a1` — see **Verification** below |
| CI verified | see **Verification** below and the pull request checks |
| Preview / production verified | no. Migrations 059 and 060 are not applied to any hosted database, nothing is deployed, and Phase 0 infrastructure is still blocked |

## Verification

All results are LOCAL on Windows 11, at `fe909a1` unless noted. The commit
after it changes only this report and the PR text.

| Gate | Command | Result |
|---|---|---|
| Full unit suite (includes PGlite staging and real-PostgreSQL suites) | `npm run test` | exit 0; **101 / 101 files, 3,064 / 3,064 tests**, 0 skipped (1,372 s) |
| Mutations | `node scripts/redis-mutations.mjs` | **27 / 27 detected**, 0 survived, all files restored (hash-checked) |
| TypeScript | `npx tsc --noEmit` | exit 0 |
| ESLint | `npm run lint` | 0 errors (499 warnings, none new from this change) |
| Production build | `npm run build` | exit 0 |
| No-dev-routes | `npm run verify:no-dev-routes` | OK |
| Worker build | `npm run build:worker` | exit 0, `.open-next/worker.js` written; OpenNext warns it is not fully compatible with Windows, so CI's Linux build is the authoritative one |
| Full E2E | `npm run test:e2e` | **420 / 420** (17.4 min) |
| Redis E2E | `npx playwright test -c playwright.redis.config.ts` | **8 / 8** |

**What E2E does not cover.** Both Playwright configs point Supabase at a
closed loopback port (owner decision D3: no non-production Supabase
project), so no E2E test reaches migrations 059/060 or a real finance flow.
Those are covered by the PGlite and real-PostgreSQL suites only. Running
E2E against them needs an approved non-production Supabase project with
059 and 060 applied.

**Earlier result, superseded.** The first full run after 060 (`e045de7`'s
working tree) had 5 failures. Three were real and fixed in `e045de7`: the
new table lacked 053's tenant gate and the tenant-key inventory entry. Two
(`cache-efficiency` ECONNRESET, `today-contract` timeout) were in code
this change does not touch. All five pass in the full run above.

## Capped-read audit

**Method.**
- **Scan:** a script listed every `.from(...).select(...)` chain in `app/`
  and `lib/` with no `.range`, `.limit`, single-row read or count-only head
  request. It found 243.
- **Explicit caps:** every `DEFAULT_QUERY_LIMIT` use and literal `.limit()`.
- **Manual review:** every chain on a college-wide or platform-wide table,
  for whether its rows feed a total, a decision, a fan-out or a bulk action.

**Most of the 243 are harmless.** They are bounded by their domain: one
student's, teacher's, offering's or department's rows, one row per
department, or the page-scoped lookups of a paginated list. Several are false
positives, where `.range()` is applied in a later statement.

**Classes.**
- **P0:** can corrupt financial, security or authorization state.
- **P1:** wrong business totals or workflows.
- **P2:** scalability; correct today, at risk with growth.
- **P3:** display-only list or pagination.

### Fixed in this branch

| # | Location | Dataset | Old cap | What it computed | Class | Fix |
|---|---|---|---:|---|---|---|
| 1 | `director/attention` getStudentRiskOverview (cached 120 s) | students, fees, failed enrolments | 1,000 each | at-risk and critical per department | P1 | `student_risk_overview()` |
| 2 | `director/faculty` listFaculty (cached 30 s) | offerings, slots, attendance, marks | `DEFAULT_QUERY_LIMIT × 2` and 1,000 | courses, periods, days marked, marks | P1 | `faculty_activity()` |
| 3 | `hod/faculty` listDepartmentFacultyWorkload (cached 60 s) | offerings, slots | 1,000 | courses, weekly periods | P1 | `faculty_activity()` |
| 4 | `finance/reports` page (cached 60 s) | every fee, no college filter | 1,000 | department totals, status counts, overdue outstanding | P1 | `fee_department_breakdown()`, `fee_status_breakdown()` |
| 5 | `finance/exceptions` getFinanceExceptions (cached 30 s) | every fee and payment | 1,000 each | overdue fees, duplicate payments, overpayments | **P0** | `finance_exceptions()`: complete totals, bounded lists |
| 6 | `placement-cell/reports` getPlacementReports (cached 120 s) | placed and joined placements | 1,000 | placement counts and rate | P1 | `placement_report()` |
| 7 | `hod/reports` page (cached 60 s) | failed enrolments of the department | 1,000 | backlog count | P1 | exact count plus a bounded list |
| 8 | `director/hostel` getHostelRollup (cached 60 s) | rooms, pending passes, open complaints | 1,000 each | capacity, occupancy, counts | P1 | `hostel_block_capacity()` plus exact counts |
| 9 | `director/forecast` getForecastBaseline | rooms | 1,000 | hostel capacity | P1 | `hostel_block_capacity()` |
| 10 | `director/goals` hostel_occupancy_pct | rooms | 1,000 | goal metric | P1 | `hostel_block_capacity()` |
| 11 | `director/ask` student_risk | active students | 1,000 | active-student count | P1 | exact count |
| 12 | `director/placements/funnel` | applications of 20 drives | 1,000 | per-drive, per-status counts | P1 | `placement_drive_funnel()` |
| 13 | `director/security` securityOverview | today's movements, open passes, scan refusals | 1,000 each | gate security tiles | **P0** (security monitoring) | `gate_security_counts()` |
| 14 | `warden/gatepasses` getGateOperationsSnapshot (cached 30 s) | warden's students, active and approved passes | 1,000, then a URL `in()` | outside count, late returns | **P0** (security) | exact counts and bounded oldest-first lists, under RLS block scope |
| 15 | `warden/gatepasses` pending and processed lists; `warden/complaints` list | warden scope as a capped id list sent back as `in()` | 1,000, plus URL length | which passes and complaints a warden sees | **P0** (scope fails closed) | rely on the 047/050 RLS block scope already in PostgreSQL |
| 16 | `warden/complaints` updateComplaintStatus | the same capped id list | 1,000 | may this warden act | **P0** (wrongly refused) | exact single-record check |
| 17 | `director/dashboard` sendAnnouncement | every recipient profile | 1,000 | who receives an announcement | P1 | `send_announcement()`: one INSERT … SELECT |
| 18 | same, device tokens | `in(user_id, all recipients)` under owner-only RLS | 1,000, and RLS returned only the sender's own token | push delivery | P1 (push never reached anyone) | `notification_push_tokens()`, keyset pages of 1,000 |
| 19 | `placement-cell/notifications` | every student (eligible: the first 1,000, filtered in JS) | 1,000 | who receives it | P1 | `send_placement_notification()` |
| 20 | same, device tokens | as #18 | as #18 | push delivery | P1 | as #18 |
| 21 | `finance/integrations` syncNow | the window's cleared payments, then one-by-one enqueue | 1,000; a failed read meant "nothing to queue" | what is queued for posting | **P0** | `finance_sync_step()` (060): bounded batches of a durable run whose cursor commits with each batch; a later press resumes it |
| 22 | `lib/finance/reconciliation` loadLocalPayments | the period's cleared payments | 1,000 | local-versus-provider comparison | **P0** (false or hidden discrepancies) | `finance_reconciliation_payments()` (060): keyset pages of 1,000 by `(created_at, id)`, bounded by the run's `started_at`; links read in chunks of 100 |
| 23 | `lib/finance/mapping` validateMappings | every fee and payment | 1,000; a failed read meant "no gaps" | which fee heads and methods need a mapping | **P0** (activation with unmapped heads) | `finance_mapping_usage()`, failing closed |
| 24 | `cron/snapshot-health-score` | students, faculty, flags, decisions, rooms, department rows, platform-wide | 1,000 across ALL colleges | every college's health score | P1 | `college_health_inputs()`, service role only |
| 25 | `cron/detect-risk-flags` hostel signal | every room, platform-wide | 1,000 across all colleges | over-capacity flags | P1 | `hostel_block_capacity_all()`, service role only |
| 26 | `cron/detect-risk-flags` auto-resolve | open system flags, platform-wide | 1,000 | which flags auto-resolve | P2 | keyset pages by id |
| 27 | `student/attendance` page | the student's records | `DEFAULT_QUERY_LIMIT` (500) | attendance percentage per class | P1 | `attendance_summary()`; the list stays the latest 500 |
| 28 | `finance/invoices`, `finance/scholarships`, `director/placements` pickers | every student | 1,000 | who can be invoiced, awarded or recorded | P1 (students past 1,000 cannot be chosen) | `search_students()`, at most 50, under RLS |

The seven totals named by the earlier audits are #1, #2, #4, #5, #6, #3
together with the director workload, and #7. All are fixed. The hostel
rollup, announcement fan-out and "Sync now", named separately, are #8,
#17–#21.

### Remaining, classified P2 or P3, and not fixed

| Location | Why it is acceptable now |
|---|---|
| `director/ask` attention_department (open flags per department) | P2. System flags are one per department and type; a college would need more than 1,000 open flags |
| `warden/gatepasses` listPendingGatePasses | P2. The pending queue, newest first; more than 1,000 pending at once is a holiday-surge edge |
| `super-admin` listCollegeAdminSessions | P3. A display list |
| finance disputes, refunds, substitutions, decisions, reconciliation open items (`limit 200`) | P3. Display lists with no total derived from them |
| `lib/offerings` listTeachableOfferings for admin with no semester | P2. Callers pass a semester |
| `lib/college-access` unavailableCollegeIds | P2. One row per college |
| `teacher/*`, `hod/*` department-scoped reads | P2. Bounded by one department's offerings |

**Remaining business-critical (P0/P1) capped reads: none known.**

## Database changes: migrations 059 and 060

**Effective fee status.** `fee_effective_status()` is
`computeEffectiveFeeStatus` in SQL; a test checks every status, payment state
and due date against the TypeScript.

| Function | Security | Used by |
|---|---|---|
| `student_risk_overview`, `faculty_activity`, `fee_department_breakdown`, `fee_status_breakdown`, `finance_exceptions`, `placement_report`, `placement_drive_funnel`, `hostel_block_capacity`, `gate_security_counts`, `attendance_summary`, `finance_mapping_usage`, `search_students` | SECURITY INVOKER: RLS decides which rows count, exactly as for the old select. Each also takes and filters by the caller's college | #1–#14, #23, #27, #28 |
| `send_announcement`, `send_placement_notification` | SECURITY INVOKER, plus an explicit role-and-college gate | #17, #19 |
| `notification_push_tokens` | **SECURITY DEFINER** (see below) | #18, #20 |
| `finance_sync_idempotency_key` | SECURITY INVOKER | #21 |
| `finance_sync_step` (060; replaces 059's `queue_finance_sync_batch`, which 060 drops) | **SECURITY DEFINER**: the only writer of `finance_sync_runs`; enforces fso_enqueue's rules itself | #21 |
| `finance_reconciliation_payments` (060) | SECURITY INVOKER | #22 |
| `college_health_inputs`, `hostel_block_capacity_all` | SECURITY INVOKER, executable by `service_role` only | #24, #25 |

**Explicit gates on the send functions.** They mirror the Server Actions'
`requireRole` (director or admin; placement cell or admin). Authenticated
users can call any granted function over PostgREST directly, and the
existing notification insert policy alone would let a teacher message the
whole college through it.

**Additive schema.** 059: `notifications.announcement_id` (nullable) plus a
partial index. 060: the `finance_sync_runs` table (RLS read policy for
finance/admin, no write policy, 053 tenant gate and write trigger), the
`idx_payments_cleared_keyset` index (see below), and the drop of 059's
`queue_finance_sync_batch`. No data is rewritten. Every function is revoked
from `PUBLIC` and `anon`.

**Why `notification_push_tokens` is SECURITY DEFINER.** `device_tokens_own`
(017) lets a user read only their own tokens, so the sender cannot read
recipients' tokens with invoker rights. That is exactly why push never
worked. The function enforces instead:
- the caller is the sender of that announcement, in their own college, in a
  role allowed to send;
- only recipients of that send, only active profiles, only tokens registered
  in the same college;
- distinct tokens, a keyset page of at most 1,000, and only the token
  returned.

Its `search_path` is fixed and every object is schema-qualified. Tests prove
other users get nothing, even with the announcement id.

**Indexes: none added.** The predicates are covered by existing indexes:
- college id on every table (021);
- `idx_attendance_offering`;
- `UNIQUE (connection_id, idempotency_key)`;
- `UNIQUE (drive_id, student_id)`;
- `idx_device_tokens_user`;
- the new `idx_notifications_announcement`.

Query plans on hosted data are unmeasured.

## Concurrency

**"Sync now" (060).** 059 kept the keyset cursor in the Server Action's
local variables. After its ceiling of 200 batches × 500 it answered
"incomplete", and the next press started again at the window's first
payment: nothing was duplicated, but payments past the first 100,000 were
never queued. Now the window's progress is a `finance_sync_runs` row (one
RUNNING run per connection and window, by a partial unique index), and each
`finance_sync_step` call is one transaction that:
- locks the run row (concurrent presses take turns on the cursor);
- reads up to N payments after the run's cursor `(created_at, id)`, created
  no later than the run's `cutoff_at`;
- inserts their operations as PENDING with `ON CONFLICT (connection_id,
  idempotency_key) DO NOTHING`, and moves this batch's PENDING ones to QUEUED;
- advances the cursor and the run's counts, and marks it COMPLETE on a short
  batch.

A batch that raises is undone to a savepoint, operations and cursor
together; the run records `last_error` and stays RUNNING, and the next call
repeats that batch. A press that stops at its ceiling returns
`complete: false` and the page says to press again; the next press, by
anyone in the college with the role, continues the same run.

**Consistency policy.** A run's set is fixed when it opens: cleared payments
in the window created at or before `cutoff_at`. A payment in that set that is
still cleared when the cursor reaches it is queued by this run. One created
later, or one that becomes cleared behind the cursor, belongs to the next
run of the window, which rescans from the start and skips everything
already queued or posted. "Complete" means every payment eligible at
`cutoff_at` is queued or was already posted.

**Reconciliation (060).** `loadLocalPayments` paged with OFFSET, so a
payment inserted or deleted between pages shifted later rows: one could be
skipped or read twice. It now reads keyset pages in the same
`(created_at, id)` order, with the cursor taken verbatim from the database
(microseconds intact), bounded by the run's `started_at`. Pages are separate
statements, not one snapshot: a payment present for the whole walk is read
once; one that changes is read as it was when its page was read; a change
behind the cursor shows in the next run. A repeated id fails the run rather
than double-count it. A failed page, a failed link read, or a provider still
paging after 200 pages fails the run with a message that says to run it
again; none of them reads as an empty or partial list.

The key is `idempotencyKey()` exactly, so a payment queued here or by
`enqueue()` is one row. Two presses, or a press and a worker, resolve
through the unique index and the guard trigger. Posting is unchanged: the
worker claims with the 056 compare-and-swap, and ambiguous Zoho answers
still go to reconciliation.

**Exactly-once is not claimed.** Zoho has no idempotency key. What is
proved is at most one operation per payment, and at most one claim per
operation.

**Announcements.** One INSERT … SELECT is atomic: all recipients' rows or
none. Concurrent sends are separate announcements.

**Real PostgreSQL** (`tests/realpg-phase3-concurrency.test.ts`):
- **100,500 payments:** the first press stops at 200 × 500 with the run
  RUNNING; a second, separate process finishes the same run (202 batches),
  and payments 100,001–100,500 are queued;
- **ten concurrent presses over 1,200 payments:** they share one run; each
  batch is processed by exactly one press; exactly 1,170 operations;
- **a backend killed in the middle of a batch:** its operations and cursor
  roll back together and the next press redoes exactly that batch;
- **five presses overlapping five claiming workers:** no duplicate
  operation, no operation won twice, no second attempt;
- **college B's finance racing college A:** refused;
- **five concurrent announcements to 1,500 students:** five complete,
  separate sends with no duplicate.

The Phase 1 suites (100 workers on one operation) still pass on this branch.

## Redis

**Unchanged by this phase:** every cache key, TTL, scope and invalidation.
The cached values are now complete and small.
- **Only shapes changed** (finance exceptions totals, gate-ops counts, HOD
  backlog count). Values are build-scoped, so a new build never reads an
  old shape.
- **Write-behind** (Phase 2) still applies only to its pinned
  analytics/catalog list.
- **Nothing authoritative is cached here:** no finance claim, sync
  operation, permission, approval or session.
- **The new functions add no Redis traffic.**

## Rollback

Revert the branch, then drop the 060 objects (`finance_sync_step`,
`finance_reconciliation_payments`, `finance_sync_runs`,
`idx_payments_cleared_keyset`), the 059 functions and the
`notifications.announcement_id` column. Nothing else reads them.

**Deploy order: apply 059, then 060, before deploying this code.** There is
no fallback to the capped computation by design; without them the affected
pages show their error state. Verified locally (`tests/realpg-migration-060.test.ts`):
the real chain 001..058, data, 059 with operations queued through 059's
`queue_finance_sync_batch`, then 060. The old function is gone, the new run
skips what 059 queued, and every payment ends with exactly one operation.

## Migration 060: the payments index build

**The one index on an existing table** is `idx_payments_cleared_keyset` on
`payments (college_id, created_at, id) WHERE status = 'cleared'`. It
serves `finance_sync_step` and `finance_reconciliation_payments`.
- **Existing coverage:** `payments` has only `college_id`, `student_id`
  and `fee_id` indexes, none of which orders by `(created_at, id)`.
- **Purpose:** performance, not correctness. Without it each batch sorts
  the college's payments. LOCAL, real PostgreSQL
  (`bench/phase3-index-build.ts` → `bench/results/phase3-index-build-local.json`):

| Payments | Plain build (writes wait) | One sync batch, no index | With index |
|---:|---:|---:|---:|
| 100,000 | ~0.19 s | 44 ms | 0.5 ms |
| 1,000,000 | ~1.1 s | 159 ms | 0.4 ms |

**Why not `CONCURRENTLY` in the migration.** Migrations here run as whole
files (`supabase db push`, README, or the SQL editor, 047's notes). PostgreSQL
refuses `CREATE INDEX CONCURRENTLY` inside a transaction block, and no
migration in this repository uses it. The CLI's exact wrapping could not be
checked here (no Supabase CLI installed), so the migration does not depend
on it either way.

**Mitigation in 060:**
- **`lock_timeout = '5s'`** for the build. The real risk was the wait BEFORE
  the build: queued behind a long transaction, every payment write would
  queue behind the migration. Now the build gives up after 5 s, and the
  file is re-runnable.
- **A guard** drops an INVALID index of this name (a failed `CONCURRENTLY`
  build leaves one), or one with a different definition, before
  `CREATE INDEX IF NOT EXISTS`.

Tested on real PostgreSQL: behind a 20 s uncommitted payment write, applying
060 in one transaction fails with "lock timeout" in about 6 s and changes
nothing; a payment write queued behind it proceeds at that point, not after
20 s; the re-run succeeds. The invalid and wrong-definition cases are
replaced, and a valid pre-built index is kept with the same oid.
Mutation 27 (lock_timeout removed) is detected.

**Deployment procedure for 060** (owner; not performed):
1. Apply 059 first.
2. Check the size: `SELECT count(*) FROM public.payments;` At up to about
   1M rows the plain build is a ~1–5 s write pause on hosted hardware (an
   estimate from the LOCAL figures, not measured).
3. Optional, for a large table or no quiet window: from psql, outside any
   transaction, run
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_cleared_keyset ON public.payments (college_id, created_at, id) WHERE status = 'cleared';`
   060 then keeps it. If that build fails, 060 drops the invalid leftover
   and builds it plainly.
4. Apply 060 in a low-traffic window. If it stops with `lock timeout`, a
   long transaction held `payments`: find it in `pg_stat_activity`, wait,
   and re-run 060.
5. Verify: `SELECT indisvalid FROM pg_index WHERE indexrelid = 'public.idx_payments_cleared_keyset'::regclass;`
   returns `true`, and `SELECT count(*) FROM pg_proc WHERE proname = 'queue_finance_sync_batch';` returns 0.

## Known limitations

- **Reconciliation's period end** stays `<= end 23:59:59Z`, as before this
  phase. A payment in the last fraction of a second of the end day is
  outside every period. Correcting it changes a business rule, so it needs
  a separate, approved change.
- **A sync run continues only when someone presses Sync Now again.** No
  worker resumes it. The page says "NOT FINISHED — press Sync Now again
  with the same dates".
- **Push delivery is best-effort.** In-app notifications are always
  complete (one statement). Push stops at 500 pages × 1,000 tokens, with a
  `notifications.push outcome: truncated` warning logged.
- **Failed sync batches** record the raw SQL error text on the run and in
  the audit log (visible to finance/admin).
- **A run's consistency is per batch, not a snapshot.** See Concurrency.

## Performance

**Labels.** Everything here is **LOCAL**. Nothing is **PREVIEW** or
**PRODUCTION**: migrations 059 and 060 are applied nowhere hosted, and Phase 0's
telemetry is blocked. Nothing is **MODELLED**.

### Rows to the application, and queries

These are exact counts, from `bench/phase3.bench.ts` at 20,000 students,
fees and payments.

| Path | Before | After |
|---|---|---|
| Risk overview | 3 queries, 2,000 rows, counted 1,000 of 20,006 students | 1 query, 1 row per department, counts all 20,006 |
| Fee status breakdown | 1 query, 1,000 rows, counted 1,000 of 20,002 fees | 1 query, 1 row per status, counts all 20,002 |
| Finance exceptions | 4 queries, 2,000 rows, saw 1,000 of 20,000 payments | 1 query, at most 5 × 200 rows, complete totals |
| Sync Now, requests | 2 + (2 to 3) × min(payments, 1,000) | ceil(payments ÷ 500) + 1, at most 200 per press; later presses resume |
| Announcement fan-out | recipients read (capped) + one insert carrying them | one statement, one row back |

### Time

Real PostgreSQL 18 (`tests/realpg` harness), best of 3, called as the
named role through RLS. Full table: `bench/results/phase3-realpg-local.tsv`.

| Rows | Risk overview | Same, as owner (no RLS) | Fee status breakdown | Finance exceptions | Old capped read |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 173 ms | 9 ms | 115 ms | 115 ms | 70 ms |
| 5,000 | 747 ms | 42 ms | 435 ms | 445 ms | 70 ms |
| 20,000 | 3,442 ms | 170 ms | 1,765 ms | 1,887 ms | 75 ms |

**A defect found and fixed while measuring.** The first version of the
risk overview took 16.6 s at 20,000 students. Under RLS the planner chose a
nested loop that re-scanned the overdue fees once per student. Both it and
finance exceptions now avoid that join, and every function is linear.

**The old read was fast because it was wrong.** It stopped at 1,000 rows.
The comparison that matters is a complete answer against an incomplete
one.

### Known limitation: per-row RLS cost

**What the gap is.** The difference between the RLS and owner columns,
about 85 µs per row, is the existing policies. Each calls
`get_my_college_id()` and `get_my_role()` for every row they check. The
old reads paid this too, but only for 1,000 rows. A complete answer pays
it for every row.

**What it means at a typical size.** A 3,000-student college with 12,000
fees reads in roughly 0.3–1 s. Those results sit behind the existing 30–120 s
caches.

**Recommended follow-up, as its own security-reviewed PR.** Wrap those
helper calls as `(SELECT public.get_my_role())` in the policies on the hot
tables (students, fees, payments, placements, profiles), the standard
Supabase pattern. That makes PostgreSQL evaluate them once per statement,
not once per row. It should bring the RLS figures close to the owner
figures. It changes existing security policies, so it is deliberately not
part of this phase.
