# Academic Nexus — final security certification

Phase 54. Date: 2026-09-19.

This document is optimised for truth, not for a positive result. Where there
is no evidence, it says so, and no absence of evidence has been converted
into a PASS.

---

## Verdict

# NOT PRODUCTION READY

**Not because the security posture is weak.** It is genuinely strong, and it
is stronger after this pass than before it. Seven defects were found and
closed, three of them P1, and every one has a regression test that fails when
the fix is reverted.

**Because critical workflows have never been executed.** Specifically:

1. **No camera has ever opened against the gate scanner.** No phone has
   displayed a QR to it. No physical crossing has ever been recorded. That is
   the system's flagship feature and its device layer is entirely unproven.
2. **CI has never run.** Not once. A workflow file that has never executed is
   not a control.
3. **`FINANCE_CREDENTIAL_KEY` is not set anywhere** — so the finance
   integration hub cannot create a connection at all. It fails closed, which
   is correct, but it means the feature is non-functional as configured.
4. **No secret in the Cloudflare Worker has been verified**, including
   `GATE_QR_SIGNING_KEY`. Without it the scanner cannot verify a payload.
5. **No backup has ever been restored.** RPO and RTO are unknown numbers.
6. **No browser has opened any page in this audit.**
7. **No load test has been run**, against a system whose rate limiter adds an
   HTTP round trip to every mutation.

Phase 54 is explicit: *"Do not certify production readiness if critical
workflows are merely untested."* Seven of them are.

---

## Findings

### P0 — CRITICAL: none

No cross-college data exposure, no privilege escalation, no payment
corruption, no forged QR accepted, no authentication bypass was found. Each
was tested for; see `SECURITY_TEST_MATRIX.md`.

One suspected P0 was raised in the previous pass — a cross-tenant leak
through the analytics materialized views — **tested, and disproved by me**.
Recorded rather than quietly dropped.

### P1 — HIGH: 4 found, 3 fixed, 1 open

| ID | Finding | Status |
| --- | --- | --- |
| **R-001** | The rate limiter failed **open for every bucket** when Redis was unconfigured or erroring — payments, refunds, invitations, role changes, security authorization included. Nothing logged it. One missing environment variable on a new deployment produced an application with no rate limiting at all. | **FIXED** |
| **R-002** | The global bucket keyed on `x-forwarded-for`, a header any client can write. Rotating it minted a fresh empty bucket per request, so the limit was not a limit. | **FIXED** |
| **E-001** | 10 sites still returned raw PostgreSQL text — constraint names, column names, table names — through `error?.message \|\| "fallback"`, a shape the earlier F-002 codemod did not match. Reachable from `/api/mobile/finance/payment`, `/invoice`, `/scholarship`, `/super-admin/create-college` and six more. | **FIXED** |
| **R-003** | Login and password reset go **browser → GoTrue directly** and never reach this application's limiter. Brute-force protection rests entirely on GoTrue's own settings, which are outside this repository and were not read. | **OPEN — configuration, not code** |

### P2 — MEDIUM: 5 found, 4 fixed, 2 open

| ID | Finding | Status |
| --- | --- | --- |
| **C-001** | Cache keys built with `?.` collapse to a literal `undefined` segment — one entry shared by every caller in that state, across colleges. Not exploitable today (the same missing profile also empties the RLS result), but nothing enforced that coupling. | **FIXED** at the pattern level |
| **A-001** | `logAudit` discarded the insert result. The Supabase client resolves rather than throws on a rejected write, so a lost audit record produced no exception, no log and no return value. | **FIXED** |
| **M-001** | Middleware returned the response for an authenticated user with **no profile row**, skipping every check below it — status, role, and route prefix. | **FIXED** |
| **T-001** | `realpg-concurrency`'s payment-vs-refund test pinned its interleaving with a fixed `pg_sleep(0.2)` — a bet on process startup. It lost once in two full runs. | **FIXED** — lock handshake, no assertion changed |
| **A-002** | Audit rows are written in a statement separate from the mutation they describe. A process dying between the two still loses the record. | **OPEN** — needs DB triggers across every audited table |

### P3 — LOW: 3

| ID | Finding | Status |
| --- | --- | --- |
| R-004 | Rate-limit capacities were never derived from measured traffic | OPEN — needs production traffic |
| CR-001 | `/api/cron/*` return `error.message` to the caller; only a valid QStash signature reaches them | OPEN — deliberate deferral |
| MOCK-001 | `api-mobile.test.ts` let `insert()` resolve to `undefined`, a shape the real client cannot produce | **FIXED** |

### One more, opened by running the suite rather than by reading it

**T-002 (P2, CI risk).** The PGlite-backed test files carry 60-second
per-test timeouts. Under CPU contention on this machine, four tests exceeded
them and failed **as timeouts, not as assertions** — the same files pass
86/86 in isolation, and the full suite passes 1,358/1,358 clean. A GitHub
Actions runner is considerably weaker than this machine, and **CI has never
run**, so nobody knows whether the suite fits inside those timeouts there.
The first CI run will answer it. **OPEN.**

### INFO

- **D-001** — the `documents` table is inert: no code path reads or writes
  it, it has no INSERT/UPDATE/DELETE policy, and there is no file storage in
  this application at all. Either drop it or build the feature; leaving a
  schema stub that looks like a document store is a trap for the next reader.

---

## Category status

| Category | Status |
| --- | --- |
| **FUNCTIONAL TESTS** | PASS — 1,358 automated tests across 46 files, zero failures on a clean run (747 s). TypeScript: 0 errors. Production build: compiled, 129 routes |
| **SECURITY TESTS** | PASS — 48 attack scenarios, `SECURITY_TEST_MATRIX.md` |
| **RLS** | PASS — real PostgreSQL, every table swept, not sampled |
| **IDOR / BOLA** | PASS at the database and action layer. **NOT TESTED via a browser** |
| **RBAC** | PASS — 9 roles × correct / wrong / anonymous / disabled |
| **TENANT ISOLATION** | PASS — including a console-level attempt with RLS bypassed, refused by a composite foreign key |
| **RATE LIMITING** | PASS — atomicity, burst, refill, distributed and bypass all measured. **Login excluded — not ours** |
| **REDIS** | PASS — failure policy per bucket, fail-closed by default. Timeout behaviour **NOT TESTED** |
| **FINANCE** | PASS — immutable ledger, no UPDATE path, real two-session concurrency |
| **EXTERNAL ERP DATA** | PASS for isolation and provenance. **No live provider was ever contacted** |
| **GATE SECURITY** | PASS in the database — the most heavily tested subsystem here, 10 controls mutation-checked. **NOT TESTED on a device** |
| **AUDIT** | PARTIAL — append-only under RLS, failures now visible, but A-002 remains |
| **CONCURRENCY** | PASS — real PostgreSQL 18, multiple simultaneous sessions |
| **BROWSER** | **NOT TESTED** |
| **MOBILE** | PASS at the API layer (131 tests). **NOT TESTED on a device** |
| **DEPLOYMENT** | **NOT VERIFIED** — no Worker secret confirmed, CI has never run |
| **BACKUP / RECOVERY** | **NOT TESTED** — RPO and RTO unknown |
| **PERFORMANCE / LOAD** | **NOT TESTED** |

---

## What changed in this pass

| File | Change |
| --- | --- |
| `lib/rate-limit.ts` | Per-bucket failure policy; 503 for a blind limiter; `Retry-After`; cached limiter instances |
| `lib/rate-limit-policy.ts` | **NEW** — one reviewable table; default DENY; every fail-open justified in source |
| `lib/client-ip.ts` | **NEW** — prefers `CF-Connecting-IP`, the one header a client cannot write |
| `lib/supabase/middleware.ts` | Trusted IP key; fails closed on a missing profile; `Retry-After` on 429 |
| `lib/api-errors.ts` | 503 for `RateLimiterUnavailableError`; `Retry-After` on 429 |
| `lib/cache.ts` | Refuses any key with an `undefined`/`null` segment; live read instead |
| `lib/audit.ts` | Reads the insert result; logs a lost audit record; returns success |
| 10 action modules | `error?.message \|\| "…"` → `dbError(…)`, preserving the human fallback |
| `.env.local.example` | Documents `FINANCE_CREDENTIAL_KEY`, which was undocumented and unset |

**Three new test files, 84 new tests**, all mutation-checked:
`tests/rate-limit-policy.test.ts` (63), `tests/cache-key-scope.test.ts` (10),
`tests/audit-write-failure.test.ts` (5), plus 6 added to
`tests/api-error-disclosure.test.ts` (13 → 19).

Mutation results: reverting `bucketPolicy()` to always-allow fails 51 tests;
reverting the IP key to `x-forwarded-for` fails the bypass test; disabling the
cache guard fails 4 tests.

---

## What was deliberately not done

- **No architecture was rewritten.** Supabase, Cloudflare, Next.js,
  authentication, RLS, Finance and Gate Security are all untouched in design.
- **No Finance production code, RPC, schema or assertion was modified.** The
  one Finance-adjacent change is the *ordering* of a test's two sessions.
- **The sliding-window limiter was kept.** `tokenBucket` was measured
  alongside it and is equivalent for these buckets; switching would have been
  churn without a defect to point at.
- **Nothing was written to the hosted Supabase project.** All hosted
  verification was read-only.
- **Nothing was pushed.** No commit has left this machine.

---

## The shortest path to a real PASS

In order, and none of them is code:

1. Open the scanner on a real device and complete one OUT/IN cycle.
2. Push the Worker secrets and verify with `wrangler secret list`.
3. Let CI run once, and read the result.
4. Provision `FINANCE_CREDENTIAL_KEY` in a secret store — or leave the
   finance hub disabled and say so.
5. Restore one backup; record RPO and RTO.
6. Set GoTrue's login and password-reset rate limits in the Supabase
   dashboard.
7. Run a load test in-region against non-production infrastructure.

Until at least 1–5 are done, the honest answer stays **NOT PRODUCTION
READY** — and the reason is absence of evidence, not presence of a
vulnerability. Those are very different situations, and this system is in the
better one.
