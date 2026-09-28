# PHASE 4 — TEST MATRIX

What was executed in this audit, what it produced, and what was not executed.

Legend — **PASS** reproduced and held · **FAIL** reproduced and broke ·
**PARTIAL** held within stated limits · **UNVERIFIED** not executed ·
**N/A** nothing to test.

---

## A. Part 2 — Phase 3 claims, independently re-derived

Phase 4's rule was not to trust the Phase 3 report. Each claim below was
re-checked against a fresh PostgreSQL 18.4 cluster built from the repository's
own chain, or by re-running the suite independently.

| ID | Claim | Verdict | How it was checked in Phase 4 |
| --- | --- | --- | --- |
| P3-01 | `security_instructions` tenant isolation | **PASS** | included in the 50-table cross-tenant sweep; suite re-run |
| P3-02 | pending-user tenant isolation | **PASS** | `get_my_role()` returns NULL for a non-active account, measured directly; suspended-account probe also NULL |
| P3-03 | finance ledger protection | **PASS** | suite re-run (`realpg-finance-concurrency`, `staging-refund-atomicity`); `fees` cross-tenant rewrite refused by `guard_row_student_tenant` |
| P3-04 | closed-semester protection | **PARTIAL** | new writes refused (measured). **But F-01**: an in-flight write commits into a concurrently-closed semester |
| P3-05 | cross-tenant fee protection | **PASS** | direct attack: `fees: student … is not in college …` |
| P3-06 | cross-tenant hostel protection | **PASS** | direct attack: `hostel_allocations: student/room must belong to college …` |
| P3-07 | cross-tenant invitation protection | **PASS** | seeded `invitations` then attacked — rewrite 0 rows, College-B read 0 rows |
| P3-08 | attendance/marks enrolment binding | **PASS** | `guard_enrolled_student` present and index-backed; suite re-run |
| P3-09 | controlled semester reopening | **PASS** | re-attacked directly: teacher, student, warden, director, HOD all refused; `anon` cannot execute |
| P3-10 | transactional audit durability | **PARTIAL** | true for the 4 tables with triggers; **F-02** — 14 sensitive tables, incl. finance, remain application-audited |
| P3-11 | role transition consistency | **PASS** | suite re-run incl. the SQL↔TypeScript drift test |
| P3-12 | migration 047 backfill | **PASS** | suite re-run; chain applies clean to an empty cluster in 9.2 s |
| P3-13 | database CHECK constraints | **PASS** | 124 CHECK constraints present and surviving a restore |
| P3-14 | composite tenant FKs | **PASS** | 239 FKs; cross-tenant rewrite refused on 50 tables |
| P3-15 | gate security | **PASS** | suite re-run (`realpg-gate-security`); device/camera layer **UNVERIFIED** |
| P3-16 | HOD department isolation | **PASS** | suite re-run; no new attack surface found |
| P3-17 | privilege escalation | **PASS** | no VOLATILE non-trigger definer function callable by `anon`; no search_path gaps |
| P3-18 | permission surface | **PASS** | suite re-run (`authorization-surface.test.ts`) |
| P3-19 | RPC / `SECURITY DEFINER` safety | **PARTIAL** | all 40 pin `search_path`, none writable by `anon` — **but F-03**, 30 carry an unnecessary `anon` EXECUTE grant |

**Two Phase 3 claims are downgraded from PASS to PARTIAL** (P3-04, P3-10), and
one is qualified (P3-19). None was found to be false; each was found to be
narrower than stated.

---

## B. Part 6 — tenant isolation sweep, executed

For each table: as a College-A admin, rewrite `college_id` to College B; then
read the row as a College-B actor. Final state read as owner.

| | |
| --- | --- |
| Tenant tables (carry `college_id`) | **65** |
| Populated by the QA dataset | 26 |
| Empty — **RLS never evidenced before this audit** | 39 |
| Seeded by this audit and then attacked | 24 |
| **Total attacked** | **50** |
| **Breaches** | **0** |
| Resistant to generic seeding | 15 |

Representative refusals, all measured:

```
fees                → fees: student … is not in college …
hostel_allocations  → hostel_allocations: student/room must belong to college …
semesters           → semesters: college_id is immutable
profiles            → A profile cannot be moved between colleges through the API.
gate_passes         → gate_passes: college_id and student_id are immutable
security_personnel  → security_personnel: college_id and profile_id are immutable
students            → new row violates row-level security policy
timetable_slots     → 0 rows (silent denial)
```

See **F-05** for the 15 still unattacked and which of them other suites cover.

---

## C. Parts 14–17 — catalogue audit, executed

| Check | Result |
| --- | --- |
| Public tables | 68 |
| **Tables with RLS enabled** | **68 / 68** |
| Tables with RLS but zero policies | 1 — `finance_integration_credentials` (deny-all; correct for a credential store) |
| RLS policies | 177 (SELECT 96, ALL 34, INSERT 23, UPDATE 20, DELETE 4) |
| UPDATE/ALL policies whose `USING` has a tenant predicate but `WITH CHECK` does not | **0** |
| UPDATE policies with `WITH CHECK (true)` | **0** |
| `SECURITY DEFINER` functions | 40 |
| …without a pinned `search_path` | **0** |
| …EXECUTE-able by `anon` | **30** → **F-03** (17 inert predicates, 13 trigger functions, 0 able to write) |
| CHECK / FK / UNIQUE constraints | 124 / 239 / 47 |

---

## D. Parts 21–24 — concurrency and load, executed

Full detail in `PHASE4_CONCURRENCY_REPORT.md`.

| Scenario | Verdict |
| --- | --- |
| Trigger load, 8 clients, 20 s, fsync on | **PASS (measured)** — 4,472 tps, p95 2.41 ms, p99 3.71 ms with the full stack |
| Cost of the full trigger stack | 35% throughput, +0.58 ms p95 vs a bare UPDATE |
| Cost attributable to the §15 audit write | ~26% of throughput — the dominant component |
| Semester close vs in-flight academic write | **FAIL → F-01** (bounded to one transaction) |
| Two simultaneous `reopen_semester()` | **PASS** — one transition, exactly one audit row |
| Role revoked mid-transaction | **PASS** (expected isolation); new transactions correctly denied |
| Deadlocks across ~350k transactions | **none detected** (`deadlock_timeout=500ms`, `log_lock_waits=on`) |
| `guard_enrolled_student` plan | Index Only Scan, 0 heap fetches, 0.237 ms |
| `guard_closed_semester` plan | Seq Scan on 7 rows, 0.036 ms → **F-09** |

---

## E. Part 25 — backup/restore, executed

Full detail in `PHASE4_BACKUP_RESTORE_REPORT.md`.

| Check | Result |
| --- | --- |
| Object fingerprint, 11 classes | **identical** source vs restored |
| RLS enabled after restore | **68 / 68** |
| Policies after restore | **177** |
| Row counts, all 68 tables | **identical** |
| Cross-tenant read against the restored DB | **DENIED** |
| Closed-semester reopen against the restored DB | **DENIED** |
| `DELETE FROM audit_logs` against the restored DB | **0 removed** |
| `pg_dump` / `pg_restore` | 482 ms / 2,930 ms, exit 0 |
| Supabase-managed backup / PITR / `auth` schema | **UNVERIFIED** |

---

## F. Other parts

| Part | Verdict | Basis |
| --- | --- | --- |
| 26 — data retention / deletion | **PARTIAL** | `marks` delete refused by the closed-semester guard; `attendance` 0 rows; `audit_logs` immutable. No retention policy exists anywhere → **F-04** |
| 28 — API security | **PARTIAL** | inventory taken; every exported action gated (`authorization-surface.test.ts`, re-run). Live HTTP request testing not performed — no running deployment |
| 30 — cron | **PASS** | 5 routes, all QStash-signature-verified; `refresh_analytics()` run twice, idempotent, no duplicate effect |
| 31 — error disclosure | **PARTIAL** | `reopen_semester` returns one identical message for "does not exist" and "other college", so it is not an existence oracle. `can_write_offering_records` returns `false` for real and fabricated ids alike. Full HTTP error-surface review not performed |
| 32 — rate limiting | **PARTIAL** | limiter verified in Phase 3 with a fail-closed default policy. **Login and password reset cannot be rate-limited in this codebase** — the browser talks to GoTrue directly (Phase 3 R-003). Unchanged and still a gap |
| 33 — secrets | **PASS** | no committed secret values; 8 pattern matches all variable names or placeholders |
| 34 — dependencies | **PASS** | `npm audit`: 0 at every severity |
| 35 — build reproducibility | **PARTIAL** | `tsc` clean, lint 0 errors (593 pre-existing warnings), `next build` compiles 129 static pages, full chain rebuilds in 9.2 s. Clean-container build not attempted |
| 40 — observability | **PARTIAL** | Sentry on client/server/edge, `tracesSampleRate 0.1`, `sendDefaultPii false`. No alerting on authorization failures, RLS denials, trigger failures or cron failures was found → blind spot |
| 41 — security configuration | **PARTIAL** | `X-Frame-Options: DENY`, `nosniff`, HSTS 2 y + preload all enforced. **CSP is Report-Only** → **F-06**. Cookie flags rely on `@supabase/ssr` defaults, not set explicitly |
| 42 — production data safety | **PASS** | semester reopen requires role + reason + audit; refunds go through `approve_refund`; audit rows immutable; `marks` delete refused on a closed semester |
| 3 / 37 / 38 — browser, device | **UNVERIFIED** | no Playwright/Cypress/Puppeteer/WebDriver; no device or camera → **F-10** |
| 27 — storage | **N/A** | no Supabase Storage usage anywhere |
| 29 — webhooks / payment gateway | **NOT IMPLEMENTED** | no webhook route, no gateway integration |
| 36 — performance smoke | **UNVERIFIED** (app) / **PASS** (database) | no running deployment to measure end-to-end latency. Database-layer latency measured — see §D |
| 19 — migration interruption | **UNVERIFIED** | see `PHASE4_MIGRATION_REPORT.md` §5 |

---

## G. Suite re-run

Run independently at the end of the audit, on the unmodified tree:

```
Test Files  52 passed (52)
Tests       1476 passed (1476)
Duration    378.88s
```

The Phase 3 figure is confirmed. Per Part 44 this is **not** treated as
evidence of correctness on its own — it is evidence that the suite as written
passes, which is a different and smaller claim.
