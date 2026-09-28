# PHASE 4 — FINDINGS

Classified per Part 43. Severity is about consequence, not about how hard the
finding was to reach. Confidence is stated separately: **CONFIRMED** means it
was reproduced against a real PostgreSQL 18.4 cluster during this audit.

Nothing in this document was fixed. The audit modified no migration, no policy,
no application file and no test.

| ID | Severity | Confidence | Title |
| --- | --- | --- | --- |
| F-01 | **P3** | CONFIRMED | An academic write commits into a semester closed concurrently (TOCTOU) |
| F-02 | **P2** | CONFIRMED | A-002 is only partly closed — finance corrections still audit at the application layer |
| F-03 | **P4** | CONFIRMED | 30 of 40 `SECURITY DEFINER` functions are EXECUTE-able by `anon` |
| F-04 | **P3** | CONFIRMED | `audit_logs` has six indexes and no retention; growth is unbounded |
| F-05 | **P3** | CONFIRMED | 39 of 65 tenant tables were empty, so their RLS had never been evidenced |
| F-06 | **P4** | CONFIRMED | Content-Security-Policy is Report-Only and enforces nothing |
| F-07 | **P4** | CONFIRMED | A duplicate concurrent `reopen_semester()` returns success without acting |
| F-08 | **P4** | CONFIRMED | A suspended user's in-flight transaction still commits |
| F-09 | **P4** | CONFIRMED | `guard_closed_semester` uses a sequential scan on `semesters` |
| F-10 | — | UNVERIFIED | Browser and device workflows |

---

## F-01 — An academic write commits into a semester closed concurrently

**Severity P3 · CONFIRMED · Part 9 / Part 21**

`guard_closed_semester()` reads `semesters.status` with a plain `SELECT`. It
takes no lock on the semester row, so a close running concurrently with an
in-flight academic write does not serialize against it.

**Reproduction** (two real psql sessions, ordered by advisory lock, not sleeps):

```
writer  BEGIN; INSERT INTO marks …        -- guard reads status='active', passes
closer                                     UPDATE semesters SET status='closed'; COMMIT
writer  COMMIT;
```

**Measured result**

```
semester final status          : closed
marks rows present after close : 1
```

A marks row is committed into a semester that is closed by the time the
transaction lands. The seal is not atomic with respect to writes already in
flight.

**Bounded.** Once the close has committed, a *new* write is refused:

```
ERROR: marks: the semester is closed; its academic records are read-only
```

So the exposure is exactly one in-flight transaction, and the writer was
legitimately authorized at the moment the guard ran. This is a precision
defect in the academic seal, not an authorization bypass — which is why it is
P3 and not P1.

**Why it still matters.** The entire point of closing a semester is that the
record is final from that instant. "Final, except for whatever was in flight"
is a different and weaker guarantee, and it is not the one the Phase 3 report
describes.

**Direction (not applied).** Have the close take `FOR UPDATE` on the semester
row, and have `guard_closed_semester` read the row `FOR SHARE`, so a close and
an academic write cannot overlap. Cost and deadlock implications need their
own measurement before this is adopted.

---

## F-02 — A-002 is only partly closed

**Severity P2 · CONFIRMED · Part 12 / Part 13**

Phase 3 identified A-002: `logAudit()` runs *after* the mutation commits, so a
crash in between keeps the change and loses the record. Migration 052 fixed
that by writing audit rows from triggers, inside the mutation's transaction.

**What is actually covered.** Queried from `pg_trigger` on the real cluster —
four tables:

| Table | Trigger |
| --- | --- |
| `semesters` | `audit_period_status` |
| `academic_years` | `audit_period_status` |
| `marks` | `audit_marks_change` |
| `profiles` | `audit_profile_privilege` |

**What is not.** Fourteen sensitive tables have no database-level audit
trigger and rely entirely on the application's 76 `logAudit()` call sites:

```
attendance   course_enrollments   course_offerings   fees
financial_disputes   gate_movements   gate_pass_credentials
hostel_allocations   invitations   payments   refund_requests
scholarships   security_instructions   students
```

These *are* audited — `payments` through `logAudit(…, "payment_recorded",
"payments", …)`, refunds and disputes likewise — but by the application, after
commit. **They carry the original A-002 durability gap unchanged.**

Phase 3's scorecard row "Academic audit durability — PASS" is accurate for the
four academic/identity tables it names. §30's separate requirement, *"Finance
corrections audited"*, is met only in the weaker sense: the record is written,
but not atomically with the correction it describes.

**Consequence.** A crash between a refund committing and its audit row landing
leaves a financial correction with no trace. That is the exact failure mode
Phase 3 set out to eliminate, still present on the financial tables.

---

## F-03 — 30 of 40 `SECURITY DEFINER` functions are EXECUTE-able by `anon`

**Severity P4 · CONFIRMED · Part 14 / Part 15**

Supabase (mirrored by `tests/staging/platform.sql`) sets
`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon`.
Every new function therefore arrives with an **explicit** grant to `anon` that
`REVOKE … FROM PUBLIC` does not remove. Phase 3 discovered this for
`reopen_semester` and revoked `FROM PUBLIC, anon`. The same treatment was not
applied to the rest.

**Measured, as `anon`:**

| Kind | Count | Behaviour when called by `anon` |
| --- | --- | --- |
| STABLE predicates | 17 | `get_my_role()` → NULL, `can_write_offering_records()` → false, `security_has_permission()` → false |
| Trigger functions | 13 | `ERROR: trigger functions can only be called as triggers` |
| VOLATILE non-trigger | **0** | — |

No anon-callable function can write. No existence oracle: a real offering id
and a fabricated one both return `false`.

The ten correctly revoked are the state-changing and data-returning ones:
`record_gate_movement`, `record_manual_gate_movement`,
`revoke_gate_pass_credential`, `issue…`/`log_gate_security_event`,
`my_gate_pass_credential`, `security_scan_feed`, `security_outside_now`,
`refresh_analytics`, `expire_stale_gate_credentials`, `reopen_semester`.

**So this is grant hygiene, not an escalation.** It is recorded as P4 because
the security posture currently depends on each function *happening* to be
inert for an anonymous caller, rather than on it being uncallable. A future
definer function that is neither a trigger nor a pure predicate would inherit
the `anon` grant silently.

---

## F-04 — `audit_logs` has six indexes and no retention

**Severity P3 · CONFIRMED · Part 22 / Part 23 / Part 26**

```
audit_logs_pkey                     (id)
idx_audit_logs_college              (college_id)
idx_audit_logs_user                 (user_id)
idx_audit_logs_created              (created_at DESC)
idx_audit_logs_record               (table_name, record_id, created_at DESC)   ← added by 052
idx_audit_logs_college_action       (college_id, action, created_at DESC)      ← added by 052
```

Every audit insert maintains six index entries. That is measurable: with the
audit trigger enabled the marks-update workload runs at **4,472 tps**;
disabling only that trigger lifts it to **6,062 tps** — the audit write is
**~26% of throughput** and the dominant trigger cost (see
`PHASE4_CONCURRENCY_REPORT.md`).

A search of every migration and of `app/`/`lib/` found **no** retention,
pruning or partitioning for `audit_logs`. At the measured rate the table
accrues one row per marks edit, per role change and per period transition,
forever. `guard_audit_immutable` (052) additionally makes rows undeletable
through any session, so growth cannot be trimmed through the API by design.

**Consequence.** Unbounded growth on a six-index table, with the write path
paying for all six, and no documented operational procedure for trimming it.
This is a capacity and operations gap, not a security one.

---

## F-05 — 39 of 65 tenant tables were empty, so their RLS had never been evidenced

**Severity P3 · CONFIRMED · Part 6**

An RLS test against an empty table proves nothing: "0 rows returned" is what a
correct denial and an empty table look like alike. Phase 3's own §32 lists
*"the database was empty"* as something that must never count as a PASS.

**Measured against the QA dataset: 26 of 65 tenant tables populated, 39 empty.**
The cross-tenant sweep that supports "tenant isolation PASS" could therefore
only ever have covered the 26.

**What this audit did about it.** Seeded a College-A row into the empty tables
from catalogue introspection (FKs resolved to real College-A parents,
CHECK-constrained columns given literals the constraint admits), then ran two
attacks per table as a College-A admin: rewrite `college_id` to College B, and
read the row as a College-B actor.

```
tenant tables                 65
attacked (populated + seeded) 50
BREACHES                       0
still unattacked              15
```

The 15 that resist generic seeding:

```
attendance_correction_requests  command_center_view_state  finance_account_mappings
finance_external_links  finance_integration_credentials  finance_reconciliation_items
finance_sync_operations  gate_movements  gate_pass_credentials  library_issued
payments  placement_applications  refund_requests  strategic_goal_milestones  strategic_goals
```

**In fairness:** `payments`, `refund_requests`, `gate_movements` and
`gate_pass_credentials` *are* exercised by dedicated suites
(`realpg-finance-concurrency`, `realpg-gate-security`,
`staging-refund-atomicity`) which create their own rows. They are not
untested — they are simply outside this generic sweep. The remaining eleven
have no cross-tenant evidence from any phase.

---

## F-06 — Content-Security-Policy is Report-Only

**Severity P4 · CONFIRMED · Part 41**

`next.config.ts` sets `Content-Security-Policy-Report-Only`, with a comment
saying this is deliberate pending violation review. A report-only policy
blocks nothing. `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and
a two-year HSTS with `preload` are all correctly enforced.

Recorded because "a CSP is configured" and "a CSP is enforced" are different
claims, and only the first is currently true.

---

## F-07 — A duplicate concurrent `reopen_semester()` returns success without acting

**Severity P4 · CONFIRMED · Part 21**

Two simultaneous `reopen_semester()` calls on the same closed semester: both
exit 0, final status `reopened`, and **exactly one** audit row.

The second call's pre-check reads `status='closed'` before the first commits,
so it passes; its `UPDATE` then blocks on the row lock, re-reads under READ
COMMITTED, and writes `reopened → reopened`. The `AFTER` trigger's
`WHEN (OLD.status IS DISTINCT FROM NEW.status)` does not fire, so no duplicate
audit row is written.

**The end state is correct** — one reopen, one audit record, no duplicate
transition. The only wart is that the losing caller is told it succeeded at
something it did not do. Effectively idempotent; recorded for completeness
rather than as a defect.

---

## F-08 — A suspended user's in-flight transaction still commits

**Severity P4 · CONFIRMED · Part 4 / Part 21**

A teacher suspended mid-transaction still commits the write that was already
in flight. Once the suspension has committed, the account is fully shut out:

```
get_my_role() when suspended : NULL
new write while suspended    : ERROR: new row violates row-level security policy for table "marks"
```

This is ordinary transactional isolation, not a flaw, and the exposure is one
in-flight transaction. Recorded because Part 4 asks specifically about
"deactivated user with an existing session", and the answer deserves to be
measured rather than assumed.

---

## F-09 — `guard_closed_semester` sequentially scans `semesters`

**Severity P4 · CONFIRMED · Part 23**

```
Seq Scan on semesters (actual time=0.036..0.036 rows=1 loops=1)
  Filter: (id = '…'::uuid)
  Rows Removed by Filter: 6
  Buffers: shared hit=1
```

The planner is right — seven rows, one buffer, 0.036 ms. Flagged only because
this runs on *every* academic write, and the choice will change on its own as
the table grows. No action recommended now.

By contrast `guard_enrolled_student` is already optimal at 2,000 enrolments:

```
Index Only Scan using course_enrollments_offering_student_key
  Heap Fetches: 0   Buffers: shared hit=3   Execution Time: 0.237 ms
```

---

## F-10 — Browser and device workflows

**UNVERIFIED · Part 3 / Part 37 / Part 38**

No Playwright, Cypress, Puppeteer or WebDriver is installed; there is no
device, emulator or camera. Nothing in Parts 3, 37 or 38 was executed.

Per Part 44 these are reported UNVERIFIED. They are **not** inferred from API
correctness, which Part 38 explicitly forbids. This repeats Phase 3's
limitation unchanged: two consecutive audits have now been unable to test the
browser and device surface at all.

The specific scenario Part 37 raises — a mark-entry form submitted after the
semester has closed — is *partially* answered by F-01: the database refuses a
new write against a closed semester, so the submission fails server-side. What
is unverified is whether the browser surfaces that as a safe, comprehensible
error state rather than a stack trace or a silent failure.

---

## Not applicable / not implemented

| Part | Status | Basis |
| --- | --- | --- |
| 27 — Storage / file security | **NOT APPLICABLE** | No Supabase Storage usage anywhere in `app/` or `lib/`: no `storage.from(`, no buckets, no signed URLs. There is nothing to audit. |
| 29 — Webhook / payment security | **NOT IMPLEMENTED** | No webhook route exists; no payment gateway is integrated. `app/api/` holds only `cron`, `finance`, `health`, `mobile`, `security`. |

---

## Clean results worth recording

These were attacked and held.

| Check | Result |
| --- | --- |
| RLS coverage | **68 of 68** public tables have RLS enabled. Zero gaps. |
| UPDATE policies dropping their tenant predicate on the write side | **none** |
| UPDATE policies with `WITH CHECK (true)` | **none** |
| Cross-tenant `college_id` rewrite, 50 tenant tables | **0 breaches** |
| `finance_integration_credentials` | RLS on, **zero policies** — deny-all by construction. Correct for a credential store. |
| Committed secrets | **none** — all 8 pattern matches are variable names or placeholders |
| `npm audit` | **0** vulnerabilities at every severity |
| Backup → destroy → restore | object fingerprint identical across 11 dimensions; row counts identical across all 68 tables; **restored database still enforces** |
| Cron idempotency (`refresh_analytics` twice) | no error, no duplicate effect |
| Historical deletion (`marks` via authorised teacher) | refused by the closed-semester guard |
| `SECURITY DEFINER` functions without a pinned `search_path` | **none** — all 40 pin it |
| Full test suite, re-run independently | **52 files, 1,476 tests, 0 failures** |
