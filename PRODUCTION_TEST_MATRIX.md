# Production test matrix

Phase 1. Module × scenario × role, with the status each actually earned.

Statuses: **PASS** (tested), **PARTIAL**, **BLOCKED**, **NOT TESTED**,
**DESIGN DECISION REQUIRED**, **N/A**.

A **NOT TESTED** is never rewritten as a PASS. Where a row is PASS, the
Evidence column names the suite that ran.

---

## Legend for evidence

| Tag | Meaning |
| --- | --- |
| `DB` | Real PostgreSQL (PGlite) with the actual migration chain, as the actual role |
| `PG18` | Real PostgreSQL 18, multiple simultaneous `psql` sessions |
| `unit` | Automated test, no database |
| `live` | Measured against real infrastructure (Upstash, hosted Supabase read-only) |
| `mut` | Additionally mutation-checked — the control was removed and the attack then succeeded |

---

## 1. Authentication

| ID | Scenario | Role | Kind | Expected | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| AU-1 | Valid credentials | any | normal | Session issued | **NOT TESTED** | — |
| AU-2 | Invalid password | any | attack | Refused | **NOT TESTED** | — |
| AU-3 | Nonexistent user | — | attack | Refused, no enumeration | **NOT TESTED** | — |
| AU-4 | Suspended account acts | any | attack | Refused at the next action | **PASS** | unit |
| AU-5 | Pending account loads a page | any | attack | Bounced to /login | **PASS** | `DB` (migration 043) |
| AU-6 | Authenticated, no profile row | any | attack | Bounced to /login | **PASS** | code (fixed, M-001) |
| AU-7 | Modified / forged JWT | — | attack | Rejected by GoTrue | **NOT TESTED** | — |
| AU-8 | Signup with `role: admin` metadata | anon | attack | Forced to student/pending | **PASS** | `DB` |
| AU-9 | Google OAuth with any account | anon | attack | Inert pending student | **PASS** | `DB` |
| AU-10 | Login brute force | — | attack | Throttled | **NOT TESTED — control is outside this repo** | — |
| AU-11 | Password reset flood | — | attack | Throttled | **NOT TESTED — same** | — |
| AU-12 | Unknown role in `profiles.role` | any | attack | Route access fails closed | **PASS** | unit |

## 2. RBAC

| ID | Scenario | Role | Kind | Expected | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| RB-1 | Every action × correct role | all 9 | normal | Allowed | **PASS** | unit + `DB` |
| RB-2 | Every action × wrong role | all 9 | attack | 403 | **PASS** | unit + `DB` |
| RB-3 | Every action × anonymous | anon | attack | 401 | **PASS** | unit |
| RB-4 | Every action × disabled account | all | attack | 403 | **PASS** | unit |
| RB-5 | Hidden UI button, API called directly | student | attack | Refused server-side | **PASS** | `DB` |
| RB-6 | Guard reaches Finance / marks / users | security | attack | No read path | **PASS** | `DB` `mut` |
| RB-7 | Director inherits scanner privileges | director | attack | Cannot record a movement | **PASS** | `DB` |
| RB-8 | Guard promotes themselves | security | attack | Refused | **PASS** | `DB` |

## 3. Tenant isolation

| ID | Scenario | Kind | Expected | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| TI-1 | Every table, A reads B | attack | 0 rows | **PASS** | `DB` (full sweep) |
| TI-2 | Every table, A writes B | attack | Refused | **PASS** | `DB` |
| TI-3 | Cross-college gate scan | attack | Refused | **PASS** | `DB` `mut` |
| TI-4 | Cross-college finance connection | attack | Refused | **PASS** | `DB` |
| TI-5 | Straddle two colleges with RLS bypassed | attack | Refused by FK | **PASS** | `DB` |
| TI-6 | Anon reads a materialized view | attack | 0 rows / permission denied | **PASS** | `live` |
| TI-7 | Cross-tenant cache read | attack | Impossible | **PASS** | unit `mut` |

## 4. Gate Security

| ID | Scenario | Kind | Expected | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| GS-1 | Full OUT/IN lifecycle | normal | Two ledger rows | **PASS** | `DB` |
| GS-2 | 13 QR attacks (replay, forge, expire, revoke, cross-tenant, …) | attack | All refused | **PASS** | `DB` + unit, `mut` |
| GS-3 | 12 simultaneous scans of one QR | concurrent | One transition | **PASS** | `PG18` |
| GS-4 | Suspended / deactivated guard | attack | Refused; terminal | **PASS** | `DB` `mut` |
| GS-5 | Wrong gate / retired gate | attack | Refused | **PASS** | `DB` `mut` |
| GS-6 | Service-role key records a movement | attack | Refused | **PASS** | `live` |
| GS-7 | Ledger update / delete | attack | Refused | **PASS** | `DB` `mut` |
| GS-8 | Client-supplied timestamp | attack | Discarded | **PASS** | `DB` `mut` |
| GS-9 | Warden manual override without a reason | attack | Refused | **PASS** | `DB` |
| GS-10 | Rate limit on scanning | attack | 120/min/guard | **PASS** | unit + `live` |
| GS-11 | **Real camera, real device, real crossing** | normal | Works | **NOT TESTED — REAL DEVICE REQUIRED** | — |
| GS-12 | Poor lighting / slow network / network loss | normal | Degrades gracefully | **NOT TESTED** | — |

## 5. Finance

| ID | Scenario | Kind | Expected | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| FI-1 | Record a payment | normal | Ledger updated | **PASS** | `DB` |
| FI-2 | Payment > outstanding | attack | Refused | **PASS** | `DB` |
| FI-3 | Edit a payment's amount | attack | No path exists | **PASS** | `DB` |
| FI-4 | Delete a payment or audit row, as any of 6 roles | attack | Refused | **PASS** | `DB` |
| FI-5 | Refund > paid | attack | Refused | **PASS** | `DB` |
| FI-6 | Double refund approval | concurrent | One debit | **PASS** | `PG18` |
| FI-7 | Two payments overpaying one fee | concurrent | One succeeds | **PASS** | `PG18` |
| FI-8 | Payment racing a refund | concurrent | Committed balance read | **PASS** | `PG18` (T-001 fixed) |
| FI-9 | Duplicate transaction reference | attack | Refused | **PASS** | `DB` |
| FI-10 | Rate limit fails open during a Redis outage | attack | **Refused, 503** | **PASS** | unit `mut` |
| FI-11 | Audit write fails silently | attack | Logged, reported | **PASS** | unit |
| FI-12 | Audit row lost to a process crash mid-mutation | attack | Record preserved | **OPEN — A-002** | — |

## 6. External ERP

| ID | Scenario | Kind | Expected | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| EX-1 | Provenance on every imported record | normal | Source, company, tenant recoverable | **PASS** | `DB` |
| EX-2 | Cross-tenant external record access | attack | Refused | **PASS** | `DB` |
| EX-3 | Duplicate import / duplicate external id | attack | Refused | **PASS** | `DB` |
| EX-4 | Retry after an unknown outcome | attack | Refused | **PASS** | `DB` |
| EX-5 | Credential readable by any authenticated role | attack | 0 rows | **PASS** | `DB` |
| EX-6 | Operator declares an outcome | attack | Refused | **PASS** | `DB` |
| EX-7 | Hub writes into the ledger | attack | Cannot | **PASS** | `DB` |
| EX-8 | Webhook replay / forged signature | attack | — | **N/A** — there are no inbound webhooks |
| EX-9 | A live Tally / BUSY / Zoho call | normal | Posts correctly | **NOT TESTED — no provider contacted** | — |
| EX-10 | BUSY integration usable | normal | — | **PARTIAL — the adapter reports every capability unsupported, deliberately** | unit |

## 7. Rate limiting and Redis

| ID | Scenario | Kind | Expected | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| RL-1 | Burst past capacity | attack | Denied at capacity | **PASS** | `live` |
| RL-2 | 50 concurrent on one bucket | attack | No overshoot | **PASS** | `live` |
| RL-3 | Two instances, one bucket | attack | Global cap holds | **PASS** | `live` |
| RL-4 | Refill after the window | normal | Tokens return | **PASS** | `live` |
| RL-5 | Key isolation | normal | Independent buckets | **PASS** | `live` |
| RL-6 | Rotating `X-Forwarded-For` | attack | One bucket | **PASS** | unit `mut` |
| RL-7 | Redis unconfigured in production | attack | Money/identity refused | **PASS** | unit `mut` |
| RL-8 | Redis call throws | attack | Same | **PASS** | unit `mut` |
| RL-9 | Redis slow / timeout | attack | Bounded | **NOT TESTED** | — |
| RL-10 | 500-way concurrency | attack | No overshoot | **NOT TESTED — needs a non-production Upstash** | — |
| RL-11 | 429 carries `Retry-After` | normal | Yes | **PASS** | unit |
| RL-12 | Redis internals in a response | attack | Never | **PASS** | unit |

## 8. API and input

| ID | Scenario | Kind | Expected | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| AP-1 | PostgreSQL error text to a caller | attack | Redacted, logged | **PASS** | unit |
| AP-2 | Deliberate business message | normal | Passes through | **PASS** | unit |
| AP-3 | Trigger-authored refusal | normal | Passes through | **PASS** | unit |
| AP-4 | Non-Error throw | attack | Generic 400 | **PASS** | unit |
| AP-5 | null / empty / oversized / wrong-type / wrong-enum / bad UUID | attack | zod 400 | **PASS** | unit + `DB` |
| AP-6 | Mass assignment (`role`, `collegeId`, `approved`, `amount`) | attack | Ignored | **PASS** | `DB` |
| AP-7 | Illegal state transitions, 8 machines | attack | Refused | **PASS** | `DB` |

## 9. Jobs, cache, notifications, files

| ID | Scenario | Kind | Expected | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| JB-1 | Cron invoked without a QStash signature | attack | 401 | **CODE VERIFIED — runtime NOT TESTED** | — |
| JB-2 | Cron with no signing keys configured | attack | 503, not open | **CODE VERIFIED** | — |
| JB-3 | Cron replay | attack | Idempotent | **PARTIAL** — the queue is the journal; not replay-tested |
| CA-1 | Cache key scoping | attack | Always scoped | **PASS** | unit `mut` |
| CA-2 | Stale cache after a role change | attack | Invalidated | **PARTIAL — 20 s TTL worst case, documented** |
| NT-1 | Read another user's notification | attack | 0 rows | **PASS** | `DB` |
| FS-1 | File upload / download authorization | attack | — | **N/A — no file storage exists** |

## 10. Frontend, mobile, operations

| ID | Scenario | Kind | Expected | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| FE-1 | Every browser workflow (Phase 47) | normal | Works | **NOT TESTED — no browser** | — |
| FE-2 | DevTools state / payload tampering (Phase 41) | attack | Backend authoritative | **PASS at the server layer** (`DB`), **NOT TESTED in a browser** | — |
| MO-1 | Mobile API authorization matrix | attack | Same as web | **PASS** | unit (131 tests) |
| MO-2 | Mobile device, offline replay, deep links | attack | — | **NOT TESTED** | — |
| OP-1 | Load, 10 → 5,000 users | normal | — | **NOT TESTED** | — |
| OP-2 | Backup restore, RPO/RTO | normal | — | **NOT TESTED** | — |
| OP-3 | CI executes | normal | Green | **NOT TESTED — has never run** | — |
| OP-4 | Worker secrets present | normal | All set | **NOT VERIFIED** | — |
| OP-5 | `FINANCE_CREDENTIAL_KEY` provisioned | normal | Set | **ABSENT — blocks the finance hub** | — |
| OP-6 | ESLint | normal | Clean | **BLOCKED — no TypeScript 7 support upstream** | — |

---

## Totals

| Status | Count |
| --- | --- |
| **PASS** | 63 |
| PARTIAL | 4 |
| NOT TESTED | 17 |
| NOT VERIFIED / ABSENT | 2 |
| BLOCKED | 1 |
| N/A | 3 |
| OPEN finding | 1 |

The 17 NOT TESTED rows are not a formality. They are concentrated in exactly
three places — **a browser, a physical device, and a deployed environment** —
and that concentration is the whole of this system's remaining risk.
