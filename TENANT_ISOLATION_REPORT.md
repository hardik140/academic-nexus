# Multi-tenant isolation report

Phases 5, 6, 36. Can College A reach College B?

---

## 1. How the boundary is built

Three independent mechanisms, in order of how deep they sit:

**1. Application.** Every `*Core` function derives `collegeId` from the
authenticated profile and compares it to the object it loaded. Never from the
request body.

**2. RLS.** Every tenant table carries `college_id` and a policy comparing it
to `public.get_my_college_id()`, a `SECURITY DEFINER` function reading the
caller's own profile. This is the layer that holds when the application is
bypassed entirely — a leaked anon key talking straight to PostgREST still
gets nothing.

**3. Structural.** On the finance integration hub, tenancy is a **foreign
key**, not a filter:

```sql
ALTER TABLE finance_integration_connections
  ADD CONSTRAINT fic_tenant_key UNIQUE (id, college_id);

CONSTRAINT fel_connection_tenant_fkey
  FOREIGN KEY (connection_id, college_id)
  REFERENCES finance_integration_connections (id, college_id)
```

A row naming a College A connection while carrying `college_id = B` cannot be
inserted **at all** — not because a policy rejects it, but because no such
parent exists. That holds against the service-role client, against `psql`,
and against any future code path that forgets to filter.

---

## 2. Test setup

The PGlite harness applies `tests/staging/platform.sql` (the Supabase
platform layer: `auth` schema, `auth.uid()`, the three PostgREST roles,
default privileges) and then every migration 001→050 **unedited**, then seeds
two colleges with a full cast in each:

```
College A                          College B
  admin, director, finance           admin, director, finance
  hod, teacher, warden, guard        hod, teacher, warden, guard
  students A1, A2                    students B1, B2
  fees, payments, gate passes,       the same, independently
  offerings, connections
```

Every assertion below runs as the actual PostgreSQL role with the actual
`request.jwt.claim.sub` set — not as the owner, and not through a mock.

---

## 3. Results

| Attempt (as a College A principal) | Expected | Result |
| --- | --- | --- |
| `SELECT` any College B row, every tenant table | 0 rows | **0 rows** |
| `INSERT` a row carrying `college_id = B` | Refused | Refused |
| `UPDATE` a College B row | 0 rows affected | 0 rows |
| `DELETE` a College B row | 0 rows affected | 0 rows |
| Read College B's fees, payments, refunds | 0 rows | 0 rows |
| Act on College B's gate pass | Refused | Refused |
| Scan a College B credential | Refused, reason withheld | Refused |
| Assign a College A guard to a College B gate | Refused | Refused |
| Use a College B integration connection | Refused | Refused |
| **Straddle two colleges from the console, RLS out of the picture** | Refused | **Refused by the composite FK** |
| Read College B's materialized-view aggregates | 0 rows | 0 rows |
| Anonymous (`anon` role) read of any matview | 0 rows | **0 rows** |
| Anonymous read of an `mv_*_raw` matview | Denied | **`permission denied`** |

`tests/staging-integrity-scan.test.ts` sweeps every table rather than a
chosen sample, which is what makes this a boundary statement and not an
anecdote.

### The analytics views, and a correction

During the previous audit I raised the analytics materialized views as a
suspected **P0 cross-tenant leak** — views do not carry RLS, and a plain view
runs as its owner. I then tested it and **disproved my own claim**: the raw
matviews are owner-only and `permission denied` for `anon`, and the granted
views filter on `get_my_college_id()`. Recorded here because a corrected
finding is worth more than a quietly dropped one.

---

## 4. Cache isolation (Phase 36)

Redis is the one place where a tenant boundary is enforced by a *string*
rather than by the database, so it gets its own treatment.

| Key | Scope | Status |
| --- | --- | --- |
| `listCacheKey(prefix, collegeId, …)` | college | **Scoped** |
| ~~`middlewareProfileCacheKey(userId)`~~ | user | removed in Phase 2.1 |
| `dashboard:finance:{collegeId}:fee-stats` | college | **Scoped** |
| `dashboard:warden:{userId}:overview` | user | **Scoped** |
| `reports:hod:{departmentId}:mv` | department (globally unique UUID) | **Scoped** |
| `gate-ops:{collegeId or userId}` | college or user | **Scoped** |

**No cache key in this codebase is unscoped.** Phase 36's failure mode —
`student:{studentId}` where `student:{collegeId}:{studentId}` was needed —
does not occur.

### C-001, the defect that did exist

Four keys are built with optional chaining:

```ts
`dashboard:finance:${viewerProfile?.college_id}:fee-stats`
`dashboard:hod:${department?.id}:faculty-courses`
```

When the optional is missing, JavaScript writes the literal string
`undefined` into the key. Every caller in that state then shares **one**
entry, across users and across colleges.

**Was it exploitable?** Not today, and the report says so rather than
inflating it: the same missing profile that produces the broken key also
leaves RLS with no college to match, so the value cached under it is empty.
But nothing *enforces* that coupling — it is a coincidence of two unrelated
code paths, and it stops holding the moment one of those queries no longer
depends on the profile row.

Fixed at the pattern level rather than at the four sites: `getCached()` and
`invalidateCache()` now refuse any key with an `undefined` or `null` segment,
fall through to a live database read, and log the key.
`tests/cache-key-scope.test.ts`, mutation-checked.

---

## 5. Not tested

- **No two real colleges were created in the hosted Supabase project and
  driven through a browser.** Everything above is a local real PostgreSQL
  with the real migration chain — deeper than a browser test in what it
  proves about the database, but it is not the same act.
- Storage-level isolation: **NOT APPLICABLE**, there is no file storage.
