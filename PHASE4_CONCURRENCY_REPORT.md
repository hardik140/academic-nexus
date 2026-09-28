# PHASE 4 — CONCURRENCY AND TRIGGER LOAD

Covers Parts 21, 22, 23 and 24.

Phase 3 closed its report with trigger behaviour under load marked
**UNVERIFIED**, on the grounds that "indexed single-row lookups should be
cheap" is reasoning rather than measurement. This environment has PostgreSQL
18.4 with `pgbench`, so it is now measured.

---

## 1. Environment

| | |
| --- | --- |
| Engine | PostgreSQL **18.4**, disposable cluster on loopback |
| Durability | **`fsync = on`, `synchronous_commit = on`** |
| Schema | the repository's own chain — `platform.sql` + all 52 migrations + QA dataset, applied unedited |
| Isolation | READ COMMITTED (PostgreSQL default; the application sets nothing else) |
| Also set | `log_lock_waits = on`, `deadlock_timeout = 500ms` |

The test harness in `tests/realpg/harness.ts` deliberately runs with
`fsync=off` for speed. **This audit did not**, because disabling durability
would flatter every latency number in this document.

---

## 2. Trigger load — Part 22

### Workload

`UPDATE public.marks SET obtained_marks = 55 WHERE id = <random of 2,000>`,
with `request.jwt.claim.sub` set to a real teacher so `auth.uid()` resolves and
**every trigger runs in full** rather than taking its no-session early exit.

Fixture: 2,000 students, 2,000 enrolments and 2,000 marks rows on one offering
in an **active** semester, so the write path exercises all three triggers:

| Trigger | Work it does |
| --- | --- |
| `guard_closed_semester` | reads `semesters.status` |
| `guard_enrolled_student` | existence check on `course_enrollments` |
| `audit_marks_change` | `INSERT` into `audit_logs` |

`pgbench`, 8 clients, 4 threads, 20 s per variant. Percentiles are real order
statistics computed from the per-transaction log (`-l`), not from pgbench's
summary average.

### Results

| Variant | tps | p50 | p95 | p99 | max | audit rows written |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **all triggers (production shape)** | **4,472** | 1.59 ms | 2.41 ms | 3.71 ms | 94.5 ms | 88,612 |
| no audit trigger | 6,062 | 1.23 ms | 1.73 ms | 2.47 ms | 77.8 ms | 0 |
| no 051 guards | 4,987 | 1.38 ms | 2.23 ms | 3.42 ms | 142.3 ms | 99,174 |
| no triggers at all | 6,859 | 1.04 ms | 1.83 ms | 2.58 ms | 89.3 ms | 0 |

### What the numbers say

- **The full trigger stack costs ~35% of throughput** (6,859 → 4,472 tps) and
  **+0.58 ms at p95**.
- **The audit write is the dominant cost, not the integrity guards.** Removing
  only `audit_marks_change` recovers 1,590 tps; removing only the two 051
  guards recovers 515 tps. The §15 audit is roughly three times the cost of
  the §13/§11 protections it sits beside.
- **In absolute terms this is comfortable.** 4,472 marks-updates per second at
  p99 3.71 ms is far beyond any plausible college ERP load — a teacher saving
  one class of 60 is 60 rows. The trigger stack is not a throughput concern at
  realistic scale.
- **Tail latency.** Maximum latencies of 78–142 ms appear in every variant
  *including the one with no triggers at all*, so they are checkpoint/WAL
  artefacts of the cluster, not trigger cost.

**Verdict: PASS, measured.** Phase 3's UNVERIFIED is closed, and its guess
("should be small") turns out to have been right — but the audit write, not
the guards, is where the cost actually sits, which the guess did not say.

The operational consequence is in `PHASE4_FINDINGS.md` **F-04**: at this rate
`audit_logs` gains rows fast, carries six indexes, and has no retention policy.

---

## 3. Query plans — Part 23

Taken with `EXPLAIN (ANALYZE, BUFFERS)` against the populated fixture.

### `guard_enrolled_student` — optimal

```
Index Only Scan using course_enrollments_offering_student_key
  Index Cond: ((offering_id = …) AND (student_id = …))
  Heap Fetches: 0
  Buffers: shared hit=3
  Execution Time: 0.237 ms
```

An index-only scan with zero heap fetches at 2,000 enrolments. The composite
unique index `(offering_id, student_id)` exactly matches the predicate.

### `guard_closed_semester` — sequential scan, correctly

```
Seq Scan on semesters
  Filter: (id = …)
  Rows Removed by Filter: 6
  Buffers: shared hit=1
  Execution Time: 0.036 ms
```

Seven rows; the planner is right to skip the index. One buffer, 0.036 ms.
Recorded as **F-09** only because it runs on every academic write and the plan
will change by itself as the table grows. No action recommended.

### `audit_logs` — six indexes on the insert path

```
audit_logs_pkey (id)
idx_audit_logs_college (college_id)
idx_audit_logs_user (user_id)
idx_audit_logs_created (created_at DESC)
idx_audit_logs_record (table_name, record_id, created_at DESC)        ← 052
idx_audit_logs_college_action (college_id, action, created_at DESC)   ← 052
```

This is the mechanical explanation for the audit trigger being the dominant
cost in §2: every insert maintains six index entries.

**Recommended (not applied — this is an audit):** before adding any further
index to `audit_logs`, confirm each existing one has a reader. `created_at
DESC` alone and `college_id` alone both look subsumed by the two composite
indexes added in 052.

---

## 4. Race conditions — Part 21

Each scenario is two genuine `psql` processes started together and ordered by
an **advisory-lock handshake**, not `pg_sleep`, so the interleaving under test
is the one that actually happens rather than a timing accident. Final state is
read as owner with RLS bypassed.

### E. Semester close racing an in-flight academic write — **DEFECT CONFIRMED**

```
writer  BEGIN; INSERT INTO marks …     -- guard reads status='active', passes
closer                                  UPDATE semesters SET status='closed'; COMMIT
writer  COMMIT;

semester final status          : closed
marks rows present after close : 1
```

A marks row committed into a semester that is closed by the time it lands.
`guard_closed_semester` takes no lock on the semester row, so the close does
not serialize against writes already in flight.

**Bounded**: a *new* write after the close commits is refused
(`marks: the semester is closed; its academic records are read-only`). Exposure
is one in-flight transaction by an actor who was authorized when the guard ran.

Full write-up and suggested direction: **F-01**.

### F. Two simultaneous `reopen_semester()` — **SAFE**

```
exit codes         : 0, 0
final status       : reopened
reopen audit rows  : 1   (exactly one — no duplicate transition)
```

Both callers pass the `status='closed'` pre-check before either commits; the
second then blocks on the row lock and, re-reading under READ COMMITTED,
writes `reopened → reopened`. The `AFTER` trigger's
`WHEN (OLD.status IS DISTINCT FROM NEW.status)` does not fire, so no second
audit row appears.

End state is correct and the function is effectively idempotent. The only
oddity — the losing caller is told it succeeded — is **F-07**.

### G. Role revoked mid-transaction — **EXPECTED BEHAVIOUR**

```
teacher profile status        : suspended
write landed after suspension : 1
```

The in-flight write commits. Once the suspension has committed, the account is
fully shut out:

```
get_my_role() when suspended : NULL
new write while suspended    : ERROR: new row violates row-level security policy for table "marks"
```

Ordinary transactional isolation. Recorded as **F-08** because Part 4 asks the
question directly and it deserved a measurement rather than an assumption.

### Scenarios covered by existing suites, not re-run here

`tests/realpg-concurrency.test.ts`, `tests/realpg-finance-concurrency.test.ts`
and `tests/realpg-gate-security.test.ts` already drive concurrent gate scans,
concurrent payments/refunds and duplicate movement recording against the same
real-PostgreSQL harness, and all pass in the independent re-run (52 files,
1,476 tests, 0 failures). Part 21's items A, B, H, I and J are covered there;
this audit added the semester/role scenarios that had no coverage.

---

## 5. Deadlocks — Part 24

`deadlock_timeout` was lowered to 500 ms and `log_lock_waits` enabled for every
scenario above. **No deadlock was detected and no lock wait was logged** across
the four pgbench variants (roughly 350,000 transactions at 8-way concurrency)
or the three race scenarios.

**Lock-order analysis.** The trigger stack touches rows in a consistent order
on every academic write — `semesters` (read) → `course_enrollments` (read) →
`marks` (write) → `audit_logs` (insert) — and `audit_logs` is insert-only with
no updates, so it cannot participate in a cycle. The inversion Part 24 asks
about (one transaction taking `semester → offering → audit`, another taking
`audit → offering → semester`) does not arise, because nothing takes
`audit_logs` before the row it describes.

**Scope limit.** This is absence of evidence over ~350k transactions on one
workload shape, not proof of deadlock freedom across all interleavings. A
mixed workload — concurrent finance, hostel and academic writes in one run —
was not constructed. Reported as measured, not as a guarantee.
