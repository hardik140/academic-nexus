# IDOR / BOLA test report

Phases 4, 31, 32, 33. Object-level authorization: can a caller reach an
object by naming it?

---

## 1. The structural answer

Most of the ID-replacement matrix in Phase 4 cannot be exercised as written
against this application, for a reason worth stating precisely rather than
hiding behind a green tick: **there is no `GET /api/students/{id}`.**

The read surface is Server Components and Server Actions, not a REST API.
The 44 route handlers are almost all mutations (`POST`), and they take
business parameters — `feeId`, `gatePassId`, `payload` — not a caller-chosen
identity. Identity comes from `getUser()`, and tenancy from the profile row.

So the attack in this codebase is not "change `/user/123` to `/user/124`".
It is **"pass another tenant's object id to a mutation"**, and that is what
the tests below do.

Where an id *is* accepted, three things happen before anything is written:

1. `requireRole()` resolves who the caller is — from the validated JWT, never
   from the body.
2. The `*Core` function loads the object and compares its `college_id` to the
   actor's, refusing with a message that does not confirm existence
   (*"Invoice not found in your college."*).
3. RLS re-applies the same boundary underneath, as the caller's role.

Layer 3 is the one that holds when layers 1 and 2 are bypassed, which is why
every test below runs against a real database as the real role.

---

## 2. Resource-by-resource result

Phase 4 lists the resources to cover. This is each of them, with what the
coverage actually is.

| Resource | Cross-user / cross-tenant attempt | Result | Evidence |
| --- | --- | --- | --- |
| students | Read another student's row | 0 rows | `tests/rls/`, `staging-security-f1-f2` |
| profiles | Read another user's profile | 0 rows beyond what policy allows | migration 044 cross-student privacy |
| attendance | Write for a non-enrolled student | Refused | `staging-mutations-period-tenant` |
| assignments / offerings | Act on an offering not held | Refused | `rls-offering-authority` |
| exams / marks | Grade a student not in the offering | Refused | `staging-mutations-period-tenant` |
| fees | Read/create in another college | Refused | `staging-hostel-finance` |
| payments | Record against another college's fee | Refused | `staging-hostel-finance`, `api-mobile` |
| refunds | Approve another college's request | Refused | `staging-refund-atomicity` |
| receipts | n/a — no separate receipt object | — | — |
| documents | — | **NOT APPLICABLE** — the table is inert: no code path, no write policy, no storage backend | — |
| gate passes | Act on another warden's / college's pass | Refused | `staging-gate-pass-machine` |
| QR credentials | Read another student's credential | Only the owning student can read their own | `staging-gate-security` |
| movement records | Read another student's crossings | *"a student sees their own crossings and nobody else's"* | `staging-gate-security` |
| hostel records | Act outside the warden's block | Refused | `staging-mutations-hostel-finance` |
| leave | Approve outside the HOD's department | Refused | `staging-authority-graph` |
| notices / notifications | Read another user's notification | `receiver_id = auth.uid()` | migration 006 |
| academic status | Change another college's student | Refused | `student-lifecycle`, `admin/users` |
| user management | Change own role, or another college's user | Refused by trigger and by policy | `privileged-writes`, migration 042 |
| reports | Read another college's aggregates | 0 rows; matviews filter on `get_my_college_id()` | verified live, read-only |
| imported ERP records | Read/act on another college's external link | Refused, **including from the console with RLS bypassed** | `staging-finance-integration` |

---

## 3. Mass assignment (Phase 31)

Attempted injections and what stops each:

| Injected field | Outcome |
| --- | --- |
| `role: "super_admin"` | Never read from the body. On signup, migration 043 forces `student`; on update, migration 042's trigger refuses a self-role change |
| `collegeId: "OTHER"` | Never read from the body — tenancy comes from the actor's profile |
| `approved: true` / `status: "approved"` | State transitions go through explicit, validated paths; `assertClaimed` (`lib/concurrent-claim.ts`) verifies the row actually moved |
| `amount: 99999999` | Validated by zod, then bounded by the ledger trigger (`> outstanding` is refused) |
| `isAdmin: true` | No such column |
| Unexpected extra fields | zod schemas parse a fixed shape; extras are dropped, not persisted |

`tests/staging-request-integrity.test.ts` and `tests/c3-mutation-integrity.test.ts`
carry this.

---

## 4. State machines (Phase 33)

| Machine | Illegal transitions tested |
| --- | --- |
| Gate pass | `staging-gate-pass-machine.test.ts` — the full matrix |
| Gate movement | One OUT and one IN per pass; ledger immutable |
| Refund | `approved` is terminal; a second approval is refused |
| Payment | No update path exists at all |
| Academic period | `planned → active → closed` only; `tests/academic-period-actions.test.ts` |
| Security personnel | Lifecycle per §12; **DEACTIVATED is terminal** |
| Integration connection | `DRAFT → … → ACTIVE`; cannot jump; a revoked connection must be re-authorised, not switched back on |
| Sync operation | `RETRYING` only reachable from an outcome classified safe |

`tests/workflow-guards.test.ts` and `tests/state-transitions.test.ts` cover
the application-side guards; the database refuses independently.

---

## 5. What was NOT tested

- **No browser and no DevTools were used.** Phase 4's literal method —
  capture a request, edit the id, replay it — was not performed. The
  equivalent was executed at the database and action layer instead, which is
  strictly lower in the stack, but it is not the same act and is not
  reported as one.
- **No live HTTP replay against the deployed application.** All of the above
  is local.
- Mobile deep links and offline replay (Phase 42) — **NOT TESTED**.
