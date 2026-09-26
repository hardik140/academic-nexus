# PHASE 4 — MIGRATION AUDIT

Parts 18 and 19.

---

## 1. Chain state

| | |
| --- | --- |
| Migration files | **52** (`001` … `052`) |
| Applied to an empty PostgreSQL 18.4 cluster | **clean, exit 0, no errors** |
| Total apply time | **9,224 ms** for the whole chain |

Slowest files:

| ms | file |
| ---: | --- |
| 571 | `047_academic_transactions_on_offerings.sql` |
| 470 | `050_gate_security.sql` |
| 285 | `006_rls_policies.sql` |
| 285 | `033_mv_placement_funnel.sql` |
| 282 | `007_materialized_views.sql` |
| 268 | `024_placement_tables.sql` |

Nine seconds for a full rebuild is a deployment-friendly number: it means a
fresh environment can be stood up from source quickly, and it bounds the
downtime of a rebuild-from-scratch recovery path.

---

## 2. The single most important migration fact

**051 and 052 are untracked and have never been committed.**

```
?? supabase/migrations/051_phase3_hardening.sql
?? supabase/migrations/052_controlled_reopen_and_audit.sql
```

Everything Phase 3 remediated and everything Phase 4 measured lives in two
files that exist only in one working tree. They are in no commit, on no
branch, and in no deployment artefact.

This is recorded as a migration finding rather than a housekeeping note
because it has a direct production consequence: **this audit cannot tell you
what any deployed database currently contains.** No environment was contacted,
by design, and the migration history in git ends at 050. Every Phase 3 and
Phase 4 result describes the chain *as it exists on disk*.

---

## 3. Migration 047 — production safety

§16 of the Phase 3 brief required that 047 be safe against a populated
database. The repository's own suite covers this and was re-run independently
as part of the 1,476: `tests/migration-047-populated.test.ts`, 11 tests in two
groups.

| Scenario | Established behaviour |
| --- | --- |
| 047 alone against populated tables | **REFUSES** — `ADD COLUMN … NOT NULL` with no default cannot apply to a table with rows, so PostgreSQL fails the migration rather than corrupting it. History untouched, nothing invented. |
| `001..046` → legacy rows → `scripts/migrate-047-backfill.sql` → `047` → verify | applies cleanly, **100% mapping**, idempotent, legacy values preserved verbatim, enrolment ids translated user→student |

The important property is the first one: 047 fails **safely**. A deployment
that runs it against populated tables gets an aborted migration, not silent
orphaning — which is exactly what §16 asked for ("migration must fail safely
if mapping cannot be proven; never silently assign arbitrary offerings").

This audit did not re-derive that result from scratch; it re-ran the suite and
confirmed it passes. The evidence is the test file, which builds the real
chain and asserts against actual rows.

---

## 4. Part 18 coverage — what was and was not exercised

| Required scenario | Status | Basis |
| --- | --- | --- |
| A. empty database | **PASS** | full 52-migration chain applied to a fresh cluster, 9.2 s, exit 0 |
| B. realistic populated database | **PASS** | `migration-047-populated.test.ts`; plus this audit built a 2,000-student / 2,000-enrolment / 2,000-marks fixture on the completed chain |
| C. multiple colleges | **PASS** | QA dataset carries College A and College B throughout |
| D. multiple academic years | **PASS** | `QA 2026-27` (active) and `QA 2025-26` (closed) |
| E. multiple semesters | **PASS** | planned / active / closed all present |
| F. existing enrollments | **PASS** | seeded and migrated |
| G. existing attendance | **PASS** | present in the dataset on a historical offering |
| H. existing marks | **PASS** | present on the historical offering |
| I. duplicate legacy records | **PASS** | covered by the 047 populated suite |
| J. missing/ambiguous legacy mappings | **PASS** | covered — the migration refuses rather than guessing |
| K. already-backfilled state | **PASS** | idempotency asserted by the same suite |
| L. partially migrated state | **UNVERIFIED** | see §5 |

---

## 5. Part 19 — interruption and recovery: **UNVERIFIED**

Part 19 asks for interruption at safe points (after the nullable column, after
a partial backfill, before `NOT NULL`, before the FK) and a determination of
whether deployment can resume.

**This was not executed.** Being straight about why: simulating a mid-migration
crash requires killing the backend between specific statements inside a single
migration file, and the repository applies each migration as one `psql -f`
invocation. Constructing that interruption harness is a piece of engineering
in its own right, not a measurement, and the audit's rule is not to build
system changes.

What *can* be said from the structure, and is reasoning rather than evidence,
so it is marked as such:

- Each migration file runs as a single `psql -f` with `ON_ERROR_STOP=1`.
  PostgreSQL DDL is transactional, so a file that fails part-way rolls back to
  the state before that file — **unless** the file contains an explicit
  `COMMIT` or a `CREATE INDEX CONCURRENTLY`. Neither appears in 051 or 052.
- The backfill is a **separate script** (`scripts/migrate-047-backfill.sql`),
  run before 047, and the suite asserts it is idempotent. So the risky window
  is not inside a migration at all: it is between the backfill and 047, and
  re-running the backfill is safe.

**Recommendation before production:** rehearse an interrupted deployment on a
staging copy — kill the connection during 047, confirm the database is at the
pre-047 state, re-run, confirm success. Until someone does that, Part 19
stays UNVERIFIED, and this report will not claim otherwise.

---

## 6. Recommendations (not applied — this is an audit)

1. **Commit 051 and 052.** Nothing else in this list matters until the work
   under audit exists somewhere other than one working tree.
2. **Establish which migration each environment is actually at** before
   deploying 051/052. Both are written to be safe, but "safe" was verified
   against a chain built from `001`, not against whatever a live database
   currently holds.
3. **Rehearse an interrupted 047** on a populated staging copy (§5).
4. **Rehearse the restore path using the production backup mechanism**, not
   `pg_dump` — see `PHASE4_BACKUP_RESTORE_REPORT.md` §7.
