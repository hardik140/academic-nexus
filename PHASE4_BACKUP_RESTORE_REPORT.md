# PHASE 4 — BACKUP AND RESTORE REHEARSAL

Part 25. Executed end to end against PostgreSQL 18.4.

The question this answers is **not** "does `pg_dump` exit 0". A dump/restore
can silently lose row-level security, policies, triggers or grants, and the
result looks perfectly healthy right up until someone reads another college's
data. So the rehearsal restores the database and then **re-runs attacks
against the restored copy**.

---

## 1. Procedure

1. Build a source database from the repository's own chain (platform layer +
   52 migrations + QA dataset).
2. Generate real history *through the triggers*, in a session so they fire: close
   a semester, then `reopen_semester()` with a reason. This puts rows in
   `audit_logs` written by 052's trigger, so the backup carries audit history
   rather than an empty table.
3. Fingerprint the source: eleven object classes plus a row census of all 68 tables.
4. `pg_dump -Fc`.
5. **Destroy**: `DROP DATABASE`, then `CREATE DATABASE` empty.
6. `pg_restore --no-owner`.
7. Re-fingerprint, re-census, and **attack the restored database**.

---

## 2. Object fingerprint

| Class | Source | Restored |
| --- | ---: | ---: |
| tables | 68 | 68 |
| tables with RLS enabled | **68** | **68** |
| RLS policies | **177** | **177** |
| triggers (non-internal) | 66 | 66 |
| functions | 56 | 56 |
| `SECURITY DEFINER` functions | 40 | 40 |
| CHECK constraints | 124 | 124 |
| foreign keys | 239 | 239 |
| UNIQUE constraints | 47 | 47 |
| indexes | 245 | 245 |
| materialized views | 6 | 6 |

**Identical on every dimension.**

The two that matter most for a security posture are `rls_on = 68/68` and
`policies = 177`: these are exactly what a careless restore loses, and losing
them produces a database that works fine and enforces nothing.

## 3. Row census

```
tables compared : 68
total rows      : source 192, restored 192
differences     : none — row counts identical across every table
```

## 4. Does the restored database still ENFORCE?

This is the part that distinguishes a rehearsal from a file copy.

| Attack, run against the **restored** database | Result |
| --- | --- |
| College-B actor reads College-A `students` | **0 rows — DENIED** |
| Plain `UPDATE` to reopen a closed semester | **DENIED**, still `closed` |
| `DELETE FROM audit_logs` as College-A admin | **0 removed** — 2 rows before, 2 after |

RLS, the 047/052 period guard and 052's `guard_audit_immutable` are all live in
the restored copy. Nothing had to be re-applied by hand.

## 5. Timings

| Step | Duration |
| --- | --- |
| `pg_dump -Fc` | **482 ms** |
| `pg_restore --no-owner` | **2,930 ms** |
| restore exit code | **0**, no errors on stderr |

These are for the QA dataset (192 rows), so they measure **schema and object
restore cost**, which dominates at this size — 245 indexes and 177 policies
have to be rebuilt regardless of row count. They are not a projection for a
populated college.

---

## 6. Verdict

**PASS**, with evidence: identical object fingerprint, identical row counts,
and the restored database demonstrably still refuses the attacks the original
refused.

## 7. What this rehearsal did NOT establish

Stated plainly, because a backup report that overstates its scope is worse
than none.

| Not covered | Why |
| --- | --- |
| **Supabase-managed backup/PITR** | This exercised `pg_dump`/`pg_restore` against a local cluster. Whatever the production project uses — Supabase's own scheduled backups, WAL archiving, point-in-time recovery — is a different mechanism and was not contacted or tested. |
| **`auth` schema round-trip** | The dump covered the database under audit. In production, `auth.users` is Supabase-managed; whether a restore reunites `public.profiles` with `auth.users` consistently is **UNVERIFIED** here. `profiles.id` references `auth.users(id)`, so this is the single highest-risk untested part of a real restore. |
| **Restore at realistic volume** | 192 rows. Timings do not extrapolate. |
| **Storage objects** | None exist (no buckets — see baseline), so nothing to lose. |
| **Restore under load / partial restore** | Not attempted. |

**Recommended before production** (not applied): rehearse a restore using the
*actual* production backup mechanism, including the `auth` schema, and confirm
that `profiles → auth.users` survives it. That is the failure mode this local
rehearsal cannot see, and it is the one most likely to bite.
