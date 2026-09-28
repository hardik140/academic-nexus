# PHASE 4 — INDEPENDENT PRODUCTION-READINESS AUDIT

Academic Nexus College ERP · branch `master` · HEAD `a783c57`
PostgreSQL 18.4 · Node 22.17.1 · Next 16.3.5

Companion documents: `PHASE4_BASELINE.md`, `PHASE4_FINDINGS.md`,
`PHASE4_TEST_MATRIX.md`, `PHASE4_MIGRATION_REPORT.md`,
`PHASE4_CONCURRENCY_REPORT.md`, `PHASE4_BACKUP_RESTORE_REPORT.md`.

**The audit modified nothing.** No migration, policy, trigger, application file
or test was changed. The working tree at the end is identical to the baseline
apart from these six documents. Instrumentation ran entirely on a disposable
local PostgreSQL cluster, which was destroyed afterwards.

---

## 1. What this audit actually did

It did not re-run 1,476 tests and call that verification. It built a real
PostgreSQL 18.4 cluster from the repository's own inputs and attacked it.

- Rewrote `college_id` across **50 tenant tables** as a College-A admin —
  including **24 tables this audit had to seed first**, because the QA dataset
  leaves them empty and an RLS test against an empty table proves nothing.
- Called every one of the **30 `SECURITY DEFINER` functions reachable by
  `anon`** and recorded what each returned.
- Measured trigger cost under concurrent load with `pgbench` at **fsync on** —
  the thing Phase 3 explicitly left UNVERIFIED.
- Raced a semester close against an in-flight academic write using an
  advisory-lock handshake rather than sleeps.
- Backed up, **destroyed**, restored, and then re-attacked the restored
  database to check it still enforces.
- Re-derived all 19 Phase 3 claims independently.

Two Phase 3 claims come back **narrower than stated**, one comes back
**qualified**, and none comes back false.

---

## 2. Final scorecard

| Area | Result | Evidence | Risk |
|------|--------|----------|------|
| Authentication | PARTIAL | Pending/suspended accounts resolve no role (`get_my_role()` → NULL, measured). Full session-lifecycle matrix not driven — no browser | Low |
| Session lifecycle | UNVERIFIED | No browser automation; expiry/refresh/concurrent sessions untested | **Medium** |
| Tenant isolation | PASS | `college_id` rewrite refused on **50/65** tables, 0 breaches; 68/68 RLS; no UPDATE policy drops its tenant predicate | Low |
| HOD isolation | PASS | suite re-run; no new bypass found | Low |
| RBAC | PASS | every exported action gated; surface pinned; re-run | Low |
| Role transitions | PASS | one map, SQL↔TypeScript drift test | Low |
| Pending users | PASS | tenant helpers gated on `status='active'`, measured NULL | Low |
| Semester locking | **PARTIAL** | New writes refused. **F-01**: an in-flight write commits into a concurrently-closed semester | **Medium** |
| Semester reopening | PASS | 6 caller classes refused, `anon` cannot execute, concurrent duplicate is idempotent with exactly one audit row | Low |
| Academic integrity | PASS | guards index-backed; enrolment binding an Index Only Scan | Low |
| Enrollment binding | PASS | `guard_enrolled_student`, 0 heap fetches at 2,000 rows | Low |
| Attendance | PASS | cross-tenant refused; deletion refused | Low |
| Marks | PARTIAL | protected and audited; subject to **F-01** | **Medium** |
| Exams | UNVERIFIED | no exam lifecycle implemented yet (Phase 5 item) | Low |
| Results | UNVERIFIED | as above | Low |
| Finance | PASS | three independent controls; cross-tenant billing refused; concurrency suite re-run | Low |
| Payments | PASS | cleared payments immutable; ledger columns guarded | Low |
| Gate security | PASS (API) / UNVERIFIED (device) | suite re-run; camera and scanning hardware untestable here | **Medium** |
| Audit durability | **PARTIAL** | Trigger-written and atomic for `semesters`, `academic_years`, `marks`, `profiles`. **F-02**: 14 sensitive tables incl. finance still audit after commit | **High** |
| Audit completeness | PARTIAL | 76 application call sites + 4 DB triggers; finance corrections covered but not durably | **Medium** |
| RLS | PASS | 68/68 enabled, 177 policies, no `WITH CHECK (true)`, no tenant predicate dropped on write | Low |
| SECURITY DEFINER | PARTIAL | all 40 pin `search_path`; none writable by `anon`. **F-03**: 30 carry a needless `anon` EXECUTE grant | Low |
| Database constraints | PASS | 124 CHECK, 239 FK, 47 UNIQUE; survive a restore | Low |
| Migrations | PARTIAL | chain rebuilds clean in 9.2 s; 047 fails safely on populated tables. **Interruption/resume UNVERIFIED**; 051+052 uncommitted | **High** |
| Concurrency | PARTIAL | no deadlocks over ~350k transactions; reopen idempotent. **F-01** confirmed | **Medium** |
| Trigger performance | **PASS (measured)** | 4,472 tps, p50 1.59 / p95 2.41 / p99 3.71 ms, full stack, fsync on | Low |
| Backup/restore | PASS (pg_dump) / UNVERIFIED (production mechanism) | identical fingerprint and row counts; restored DB still enforces. Supabase PITR and `auth` schema untested | **High** |
| Storage | N/A | no Supabase Storage usage exists | — |
| APIs | PARTIAL | every action gated; live HTTP testing not possible without a deployment | Medium |
| Cron | PASS | 5 routes, all QStash-signature-verified; `refresh_analytics` idempotent on re-run | Low |
| Secrets | PASS | no committed values; all 8 matches are names or placeholders | Low |
| Dependencies | PASS | `npm audit` 0 at every severity | Low |
| Browser workflows | **UNVERIFIED** | no Playwright/Cypress/Puppeteer/WebDriver installed | **High** |
| Device workflows | **UNVERIFIED** | no device, emulator or camera | **High** |
| Observability | PARTIAL | Sentry configured, PII off. No alerting on authz failures, RLS denials, trigger or cron failures | **Medium** |
| Deployment reproducibility | PARTIAL | tsc clean, lint 0 errors, build 129 pages, chain rebuilds in 9.2 s. Clean-container build not attempted | Medium |

---

## 3. PRODUCTION BLOCKERS

Four. None is an exploitable vulnerability; all four are about what happens
when something goes wrong.

**B-1 — The system under audit exists in no commit.**
`051_phase3_hardening.sql` and `052_controlled_reopen_and_audit.sql` are
untracked. Every Phase 3 remediation and every Phase 4 measurement describes
two files present in exactly one working tree. There is nothing to deploy and
nothing to roll back to. *(`PHASE4_MIGRATION_REPORT.md` §2)*

**B-2 — The production backup path has never been rehearsed.**
`pg_dump`/`pg_restore` round-trips perfectly, including enforcement. But that
is not the mechanism production will use, and `public.profiles.id` references
`auth.users(id)` in a Supabase-managed schema that this rehearsal never
touched. An untested restore path is not a backup.
*(`PHASE4_BACKUP_RESTORE_REPORT.md` §7)*

**B-3 — Financial corrections are still audited after commit (F-02).**
Phase 3 identified exactly this failure mode, fixed it for four academic and
identity tables, and reported audit durability as PASS. `payments`, `fees`,
`refund_requests` and `financial_disputes` were not among them. A crash between
a refund committing and its audit row landing leaves a financial correction
with no trace.

**B-4 — No browser or device workflow has ever been tested.**
Two consecutive audits have been unable to execute Parts 3, 37 and 38. For a
system whose gate security depends on a camera scanning a QR code at a
physical barrier, and whose academic staff work entirely through a browser,
shipping with zero evidence at that layer is a blocker regardless of how
strong the database is. Part 38 forbids inferring device correctness from API
correctness, and this report does not.

---

## 4. NON-BLOCKING RISKS

| | |
| --- | --- |
| **F-01** | An academic write in flight when a semester closes still commits. Bounded to one transaction; new writes correctly refused. Weakens the seal's precision, not its authorization. |
| **F-04** | `audit_logs` carries six indexes, no retention, and rows that cannot be deleted through any session by design. Growth is unbounded and the write path pays for all six indexes. |
| **F-05** | 15 tenant tables still have no cross-tenant evidence from any phase (4 of them are covered by dedicated suites; 11 are not). |
| **F-03** | 30 definer functions carry a needless `anon` EXECUTE grant. All inert today; the posture depends on that remaining true. |
| **F-06** | CSP is Report-Only and blocks nothing. |
| **F-07 / F-08** | Cosmetic and expected-behaviour respectively; recorded for completeness. |
| Rate limiting | Login and password reset still cannot be rate-limited — the browser talks to GoTrue directly (Phase 3 R-003). Unchanged. |
| Observability | No alerting on authorization failures, RLS denials, trigger failures or cron failures. Operators would not know an attack was underway. |

---

## 5. UNVERIFIED AREAS

Listed so nobody mistakes silence for a pass.

- Browser workflows, session lifecycle, stale forms, back-button-after-logout,
  duplicate submission (Parts 3, 37).
- Device and camera workflows for gate scanning (Part 38).
- Migration interruption and resume (Part 19).
- Supabase-managed backup, PITR, and `auth` schema restore (Part 25).
- End-to-end application latency (Part 36) — database latency *was* measured.
- Live HTTP API behaviour: malformed input, expired auth, duplicate requests
  (Part 28) — static gating was verified instead.
- Exam and result lifecycle — not implemented yet.

---

## 6. RECOMMENDED REMEDIATIONS, in order

1. **Commit 051 and 052.** Nothing else is actionable until the work exists.
2. **Extend trigger-written audit to the financial tables** — `payments`,
   `fees`, `refund_requests`, `financial_disputes` — using the pattern 052
   already establishes. Closes B-3.
3. **Rehearse a restore using the production backup mechanism**, including the
   `auth` schema, and confirm `profiles → auth.users` survives it. Closes B-2.
4. **Install Playwright and cover the critical journeys**: login, mark entry,
   a stale form submitted after a semester closes, gate scan, payment. Closes
   the browser half of B-4. The device half needs hardware.
5. **Add a retention/partitioning strategy for `audit_logs`**, and review
   whether all six indexes have readers (F-04).
6. **Decide on F-01**: either accept that "closed" means "no new writes" and
   document it, or make the close take `FOR UPDATE` and have the guard read
   `FOR SHARE`. Measure the cost before adopting.
7. **Revoke `anon` EXECUTE** from the remaining 30 definer functions (F-03),
   matching what 052 already does for `reopen_semester`.
8. **Add alerting** for authorization failures, RLS denials and cron failures.
9. **Enforce the CSP** once violations have been reviewed (F-06).
10. **Rehearse an interrupted 047** on a populated staging copy (Part 19).

---

## 7. REQUIRED BEFORE PRODUCTION

Items 1, 2, 3 and 4 above — B-1 through B-4. Items 5–10 are hardening and can
follow a first deployment.

---

## 8. FINAL DECISION

### SAFE TO PROCEED TO UAT: **YES**

The security core is genuinely strong, and that conclusion is based on attacks
that were executed, not on the test count. 68/68 tables enforce RLS; 50 tenant
tables refused a `college_id` rewrite with zero breaches; no `SECURITY DEFINER`
function reachable by `anon` can write; 124 CHECK and 239 foreign-key
constraints survive a restore; the restored database still refuses the attacks
the original refused; and the trigger stack costs 0.58 ms at p95 while serving
4,472 writes per second.

The four blockers are about **operational readiness** — deployability,
recoverability, audit durability on the financial path, and an untested user
interface — not about an attacker getting in. UAT is precisely the environment
in which the browser and device gaps (B-4) start to close, and running it will
generate the evidence Parts 3, 37 and 38 could not.

**Condition:** UAT must run against a database that is **not** production and
holds **no real student or financial data**, because B-2 means a bad restore
cannot yet be recovered from.

### SAFE TO DEPLOY TO PRODUCTION: **NO**

Not because the system is insecure — on the evidence gathered here, it is
unusually well defended at the database layer for an application of this size.
It is **NO** for four specific and fixable reasons:

1. The remediated system exists in no commit (B-1).
2. The backup path has never been rehearsed, and the one schema a restore is
   most likely to break is the one that was never tested (B-2).
3. Financial corrections can still be lost by a crash, which is the exact
   defect Phase 3 set out to eliminate (B-3).
4. Not one browser or device workflow has ever been executed, across two
   consecutive audits (B-4).

A college deployment handling real fee payments and real academic records
should not go live while any of those four is open. All four are
straightforward to close, and none requires redesigning anything that exists.

---

## 9. A note on how to read this report

Per Part 44, none of the following was accepted as evidence anywhere above:
"looks correct", "should work", "middleware prevents it", "the trigger is
lightweight", or "1,476 tests pass". Every PASS names a statement that was
executed and a postcondition that was read back. Everything that could not be
reproduced in this environment is marked UNVERIFIED and appears in §5 rather
than being quietly omitted.

The audit found no P0 and no P1. That is a real result, and it is also the
result most likely to be misread: it means the attacks that were run did not
get through, on 50 of 65 tenant tables, with a browser layer nobody has ever
tested. It does not mean there is nothing left to find.
