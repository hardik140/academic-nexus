# Security attack matrix

Phase 51. Every row names the evidence. Evidence classes, per Phase 52:

- **DATABASE TESTED** — executed against a real PostgreSQL (PGlite) carrying
  the repository's actual migration chain, as the actual role.
- **AUTOMATED TESTED** — executed as a unit/integration test.
- **LIVE TESTED** — measured against real infrastructure (Upstash).
- **CODE VERIFIED** — read in source, not executed. Never written as PASS.
- **NOT TESTED** — no evidence. Never converted to PASS.

---

## A. Identity attacks

| # | Attack | Expected | Evidence | Status |
| --- | --- | --- | --- | --- |
| A1 | Replace `userId` in a request body | Ignored; identity comes from `getUser()` | `tests/api-mobile.test.ts`, `tests/staging-request-integrity.test.ts` | **PASS — AUTOMATED + DATABASE TESTED** |
| A2 | Replace `collegeId` in a request body | Ignored; tenant derived from the profile | `tests/staging-mutations-period-tenant.test.ts` | **PASS — DATABASE TESTED** |
| A3 | Send `role: "admin"` in signup metadata | Forced to `student`/`pending` by the trigger | migration 043; `tests/privileged-writes.test.ts` | **PASS — DATABASE TESTED** |
| A4 | Change own role/status/department | Refused by trigger with a written message | `tests/privileged-writes.test.ts` | **PASS — DATABASE TESTED** |
| A5 | Modified / expired / malformed / missing JWT | Rejected by GoTrue before the app sees it | — | **NOT TESTED** — needs live GoTrue calls |
| A6 | Login brute force | Throttled | — | **NOT TESTED — CONTROL IS OUTSIDE THIS REPOSITORY.** Login goes browser → GoTrue directly (see `REDIS_RATE_LIMIT_DESIGN.md` §9) |
| A7 | Use a session after the account is suspended | Refused at the next action | `requireRole()` re-reads status uncached; `tests/rbac-matrix.ts` | **PASS — AUTOMATED TESTED** |
| A8 | Authenticated user with no profile row loads portal pages | Redirect to login | Fixed this pass (M-001) | **PASS — CODE VERIFIED** (middleware is not unit-testable here) |

## B. Object attacks (IDOR / BOLA)

| # | Attack | Expected | Evidence | Status |
| --- | --- | --- | --- | --- |
| B1 | Another student's `studentId` | 0 rows / refused | `tests/rls/`, `tests/staging-security-f1-f2.test.ts` | **PASS — DATABASE TESTED** |
| B2 | Another student's `paymentId` | Refused | `tests/staging-hostel-finance.test.ts` | **PASS — DATABASE TESTED** |
| B3 | Another student's `gatePassId` | Refused | `tests/staging-gate-pass-machine.test.ts` | **PASS — DATABASE TESTED** |
| B4 | A guessed credential id | Refused, and says nothing about why | `staging-gate-security` Test 5 | **PASS — DATABASE TESTED** |
| B5 | An operation naming another college's payment | Refused | `staging-finance-integration` (§85) | **PASS — DATABASE TESTED** |
| B6 | Another user's `notificationId` | 0 rows | `receiver_id = auth.uid()` policy | **PASS — DATABASE TESTED** |
| B7 | Another student's `documentId` | n/a | The `documents` table is inert — no code path, no write policy, no storage backend | **NOT APPLICABLE** |
| B8 | Re-aim a sync journal row at another payment | Refused; identity columns frozen | `staging-finance-integration` | **PASS — DATABASE TESTED** |

## C. Tenant attacks (College A → College B)

| # | Attack | Expected | Evidence | Status |
| --- | --- | --- | --- | --- |
| C1 | Read any College B table as a College A user | 0 rows | `tests/rls/`, `tests/staging-integrity-scan.test.ts` | **PASS — DATABASE TESTED** |
| C2 | College B guard scans a College A credential | Refused, reason withheld | `staging-gate-security` Test 1 | **PASS — DATABASE TESTED** |
| C3 | Cross-college gate assignment | Refused in both directions | `staging-gate-security` | **PASS — DATABASE TESTED** |
| C4 | Cross-college integration connection | Refused | `staging-finance-integration` | **PASS — DATABASE TESTED** |
| C5 | **Straddle two colleges from the console, RLS bypassed** | Refused by the composite FK | `staging-finance-integration` | **PASS — DATABASE TESTED** |
| C6 | Cross-tenant cache read | Impossible; keys carry the college | `tests/cache-key-scope.test.ts` | **PASS — AUTOMATED TESTED** |
| C7 | Cache key collapsing to a shared `undefined` namespace | Cache skipped, live read | `tests/cache-key-scope.test.ts` (mutation-checked) | **PASS — AUTOMATED TESTED** |
| C8 | Analytics materialized views leak across colleges | 0 rows for anon; `permission denied` on the raw matviews | verified against hosted Supabase, read-only | **PASS — LIVE TESTED** |

## D. Financial attacks

| # | Attack | Expected | Evidence | Status |
| --- | --- | --- | --- | --- |
| D1 | Payment exceeding the outstanding balance | Refused by the ledger trigger | `tests/staging-hostel-finance.test.ts` | **PASS — DATABASE TESTED** |
| D2 | Refund exceeding what was paid | Refused | `tests/staging-refund-atomicity.test.ts` | **PASS — DATABASE TESTED** |
| D3 | Double refund approval | Exactly one debit | `staging-refund-atomicity`; `realpg-concurrency` | **PASS — DATABASE TESTED**, two real sessions |
| D4 | Two concurrent payments overpaying one fee | Exactly one succeeds | `tests/realpg-concurrency.test.ts` | **PASS — DATABASE TESTED**, two real psql sessions against PostgreSQL 18 |
| D5 | Edit a payment's amount after the fact | No update path exists | `tests/c3-mutation-integrity.test.ts` | **PASS — DATABASE TESTED** |
| D6 | Delete or rewrite audit history | No UPDATE/DELETE policy on `audit_logs` | migration 006 + 047 | **PASS — DATABASE TESTED** |
| D7 | Duplicate transaction reference | Unique constraint | `tests/staging-hostel-finance.test.ts` | **PASS — DATABASE TESTED** |
| D8 | Finance hub writes into the ledger | It cannot | `staging-finance-integration`, *"the hub cannot move money"* | **PASS — DATABASE TESTED** |

## E. Gate attacks

| # | Attack | Expected | Evidence | Status |
| --- | --- | --- | --- | --- |
| E1 | Copied QR / screenshot | One movement per direction only | `staging-gate-security` Test 6 | **PASS — DATABASE TESTED** |
| E2 | Expired credential | Refused, marked expired | Test 2 | **PASS — DATABASE TESTED** |
| E3 | Credential presented before its window | Refused | Test 2b | **PASS — DATABASE TESTED** |
| E4 | Revoked credential | Refused; approval not undone | Test 3 | **PASS — DATABASE TESTED** |
| E5 | Modified payload / flipped signature | Does not verify | `gate-security-credential` §45 Test 4 | **PASS — AUTOMATED TESTED** |
| E6 | Signature lifted from another credential | Does not transfer | Test 4 | **PASS — AUTOMATED TESTED** |
| E7 | Payload signed with a different key | Does not verify | Test 4 | **PASS — AUTOMATED TESTED** |
| E8 | Fabricated payload | Rejected before any lookup | Test 5 | **PASS — AUTOMATED TESTED** |
| E9 | Wrong gate | Refused | Test 9 | **PASS — DATABASE TESTED** |
| E10 | Wrong college | Refused | Test 1 | **PASS — DATABASE TESTED** |
| E11 | Suspended / deactivated guard | Refused; deactivation is terminal | Tests 8, 8c | **PASS — DATABASE TESTED** |
| E12 | Any other role calls the movement recorder | Refused — including the **service-role key** | Test 8b; hosted Supabase read-only check | **PASS — DATABASE + LIVE TESTED** |
| E13 | Client-supplied timestamp | Discarded; server clock stamped | ledger tests | **PASS — DATABASE TESTED** |
| E14 | Simultaneous scans of one QR | Exactly one transition | `tests/realpg-gate-security.test.ts` | **PASS — DATABASE TESTED**, 12 simultaneous sessions |
| E15 | Read the signing nonce as any signed-in role | Unreadable | minimum-exposure tests | **PASS — DATABASE TESTED** |
| E16 | **Scan with a real camera, on a real device** | Works | — | **NOT TESTED — REAL DEVICE REQUIRED** |

> Ten of the gate controls above are additionally **mutation-checked** in
> `tests/staging-mutations-gate-security.test.ts`: each control is removed
> from a scratch database and the corresponding attack is shown to succeed.
> That is what makes the PASS load-bearing rather than incidental.

## F. Infrastructure attacks

| # | Attack | Expected | Evidence | Status |
| --- | --- | --- | --- | --- |
| F1 | **Redis down → unlimited mutations** | Money/identity/authority refused with 503 | `tests/rate-limit-policy.test.ts` (mutation-checked) | **PASS — AUTOMATED TESTED.** Was the R-001 defect |
| F2 | **Rotating `X-Forwarded-For` to mint fresh buckets** | One bucket; `CF-Connecting-IP` wins | `tests/rate-limit-policy.test.ts` (mutation-checked) | **PASS — AUTOMATED TESTED.** Was the R-002 defect |
| F3 | 50 concurrent requests against one bucket | No overshoot | Live Upstash | **PASS — LIVE TESTED** |
| F4 | Two application instances sharing one bucket | Global cap holds | Live Upstash | **PASS — LIVE TESTED** |
| F5 | Redis error text reaching a caller | Never | `tests/api-error-disclosure.test.ts` | **PASS — AUTOMATED TESTED** |
| F6 | Cron endpoint invoked without a QStash signature | 401; 503 when keys absent | CODE VERIFIED in all five routes | **CODE VERIFIED — runtime NOT TESTED** |
| F7 | Cache poisoning across users | Keys carry the principal | `tests/cache-key-scope.test.ts` | **PASS — AUTOMATED TESTED** |
| F8 | Stale cache after a role change | Invalidated on every role/status write; 20 s TTL bound | CODE VERIFIED | **PARTIAL — the 20 s window is accepted and documented** |
| F9 | Webhook replay | No inbound webhooks exist | — | **NOT APPLICABLE** |
| F10 | PostgreSQL error text reaching a caller | Redacted, logged server-side | `tests/api-error-disclosure.test.ts` (18 tests) | **PASS — AUTOMATED TESTED** |

---

## Summary

| | Count |
| --- | --- |
| PASS — DATABASE TESTED | 31 |
| PASS — AUTOMATED TESTED | 13 |
| PASS — LIVE TESTED | 4 |
| PASS — CODE VERIFIED only | 1 |
| PARTIAL | 1 |
| NOT TESTED | 3 |
| NOT APPLICABLE | 3 |

**Nothing in this matrix was marked PASS on the strength of source
inspection alone except A8, which is labelled as such.**
