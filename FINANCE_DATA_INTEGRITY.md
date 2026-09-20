# Finance data integrity

Phases 8, 9, 10, 34.

---

## 1. What a payment is, and what can change about it

| Field | Mutable after creation? |
| --- | --- |
| `amount` | **No** |
| `student_id`, `fee_id`, `college_id` | **No** |
| `method` | **No** |
| `transaction_ref` | **No** |
| `status` | **No** through the application |
| `processed_by`, `created_at` | **No** |
| `notes` | **No — there is no update path at all** |

This is stronger than Phase 8 asks for. Phase 8 contemplates a permissioned
edit with a reason and an audit diff; this system simply has **no UPDATE path
on `payments`**. There is no Server Action, no route handler, and no RLS
UPDATE policy. A correction is a new row (a refund), not an edit.

**Rule 7 — no unrestricted financial-history mutation — HOLDS, by absence.**

`tests/c3-mutation-integrity.test.ts` asserts it rather than assuming it.

---

## 2. Payment-log immutability (Phase 9)

| Actor attempting to modify or delete a payment or audit row | Result |
| --- | --- |
| Student | Refused |
| Finance (the creator) | Refused |
| A different Finance user | Refused |
| Admin | Refused |
| Director | Refused |
| Super Admin | Refused |
| Direct SQL as `authenticated` | Refused — no UPDATE/DELETE policy exists |

`audit_logs` has SELECT policies and an INSERT policy and **no UPDATE or
DELETE policy at all**, which under RLS is deny for every non-owner role.
The table is append-only by construction.

The service-role key bypasses RLS — that is inherent to what a service-role
key is, on any Supabase project. It is used by exactly two things here: the
QStash-signed cron routes and the invitation flow. Neither has a payment
mutation path.

**No role can silently erase financial history.**

---

## 3. Invariants enforced by the database (Phase 34)

| Invariant | Mechanism |
| --- | --- |
| A payment never exceeds the fee's outstanding balance | Trigger, with `SELECT … FOR UPDATE` on the fee row |
| `fees.paid_amount` equals the sum of cleared payments minus approved refunds | Trigger maintains it; never written by the application |
| A refund never exceeds what was paid | `approve_refund()` |
| A refund request is approved at most once | Status CAS inside `approve_refund()` |
| `transaction_ref` is unique per college | Unique index |
| A fee belongs to exactly one student in one college | FK + `college_id` |
| Status vocabularies | `CHECK` constraints, not application enums |
| `fees.status = 'overdue'` is never stored | Computed live by `computeEffectiveFeeStatus()` |

The last one is a real subtlety and it is handled correctly: nothing ever
writes `overdue`, so a raw `status = 'overdue'` filter reads zero. The
application computes it at read time.

---

## 4. Concurrency (Phase 10) — real PostgreSQL, two live sessions

`tests/realpg-concurrency.test.ts` and `tests/realpg-finance-concurrency.test.ts`
spawn genuinely simultaneous `psql` processes against PostgreSQL 18. This is
the evidence PGlite structurally cannot produce — it is a single connection.

| Race | Expected | Result |
| --- | --- | --- |
| Two simultaneous 6,000 payments against a fee owing 10,000 | Exactly one succeeds | **1 succeeded, 1 refused** with *"exceeds the outstanding balance"*; `paid_amount = 6000` |
| Two approvals of the **same** refund request | Exactly one debit | 1 succeeded, 1 refused with *"already"*; fee debited once |
| Payment racing a refund on a paid-in-full fee | Payment sees the committed balance and is refused | Refund succeeded, payment refused, `paid_amount = 6000` |
| Two teachers writing the same attendance key | Unique index admits one | 1 succeeded |
| Two admins activating two semesters | Partial unique index admits one | 1 succeeded |
| Two wardens approving one pending gate pass | One approval | Exactly one row changed |

### T-001 — a flaky test, found and fixed

The third row used to pin its interleaving with `SELECT pg_sleep(0.2)` on the
refund side. That is a bet on process startup, not a guarantee: the sleep only
begins once the *refund's* `psql` has connected, so it assumes the payment's
`psql` connects within 200 ms of it. Under the loaded machine of a full-suite
run, that assumption failed — the test failed once in two consecutive full
runs.

Both interleavings are legal PostgreSQL and they answer different questions.
Refund-first drops `paid_amount` to 6,000, at which point the competing 2,000
payment is genuinely within the outstanding balance and is **correctly
accepted** — so the assertions failed while the database behaved exactly as
designed.

The ordering is now a handshake with no clock in it: the payment session takes
a session-level advisory lock and *then* announces itself; the refund waits
(unbounded) for the announcement and then blocks on the same lock, which is
released only when the payment's session disconnects — after its insert has
been attempted and answered. Because the announcement is written *after* the
lock is held, seeing it proves the lock is held.

**No Finance production code, no RPC, no schema, and no assertion was
changed.** Only which interleaving runs. Verified stable across four
consecutive runs.

---

## 5. Audit trail

Every finance mutation calls `logAudit()` with actor, role-derived college,
action, table, record id, and before/after values where the call site provides
them.

### A-001 — silent audit loss, fixed

`logAudit` was a bare `await supabase.from("audit_logs").insert(...)`. The
Supabase client **does not throw** on a rejected write — it resolves, with the
failure in `error`. Nobody read it. An RLS denial, a constraint violation or a
dropped connection produced no exception, no log line, and no return value:
the mutation happened, the record did not, and nothing recorded the divergence.

It now inspects the result, logs at error level with everything needed to
reconstruct the entry by hand, and returns whether the write succeeded.

It deliberately **does not throw**: the mutation it describes has already
committed, so turning a lost audit row into an error would report a successful
operation as failed, and the caller's natural response — retry — would perform
it a second time. A duplicated payment is worse than a missing audit line.

### A-002 — the remaining gap, stated plainly

The audit row is still written by the application, in a statement separate
from the mutation it describes. **A process that dies between the two still
loses the record.** Closing that properly means writing audit rows from a
database trigger inside the same transaction — a schema change across every
audited table, which is not a "smallest safe change" and was not attempted.

**Status: OPEN, P2.**

---

## 6. Not tested

- No real payment gateway exists in this system; `payments` records a
  settlement that happened elsewhere. There is no card flow to attack.
- No live accounting provider was contacted — see `EXTERNAL_DATA_OWNERSHIP.md` §8.
- Reconciliation against a real Tally/Zoho ledger: **NOT TESTED**.
