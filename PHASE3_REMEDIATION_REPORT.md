# Phase 3 — remediation verification report

Date: 2026-09-24. Evidence-based; no control is marked PASS on the strength
of reading the code.

---

## 0. What this session actually did — read this first

**Migration `051_phase3_hardening.sql`, `tests/phase3-hardening.test.ts` and
`scripts/migrate-047-backfill.sql` already existed in the repository when
this phase began** — all three untracked, none committed. They were written
by an earlier pass, not by this one, and they implement all four
ship-blockers plus the 047 backfill. Seven further test files carried
uncommitted edits aligning them to 051's new behaviour.

Claiming that work here would be false. What this session contributed is the
part that was missing, and it is the part §21 and §32 insist on:

| Contribution | Evidence |
| --- | --- |
| **Proved every 051 control is load-bearing** — 9 mutations, each removing one control and reproducing the original attack | `tests/staging-mutations-phase3.test.ts` (new, 9 tests) |
| **Rehearsed migration 047 + the backfill on a populated database** (§16) — the backfill existed but nothing had ever executed it | `tests/migration-047-populated.test.ts` (new, 11 tests) |
| **Tested a suspected gap and disproved it** — closed-semester reopening | probe, §3.5 below |
| **Discovered the finance ledger has three independent controls, not one** | §3.2 below |
| Verified the pre-existing suite and the uncommitted edits | 77/77, then full suite |

A green test file proves nothing until you know it can go red. That was the
open question, and it is now answered.

**Then, closing the remaining §30 boxes,** this session wrote migration
`052_controlled_reopen_and_audit.sql` and its suites — the controlled
semester reopen (§6/§7), trigger-written academic audit (§15), audit-record
immutability, and a drift test binding the SQL invitation tier to the
TypeScript one (§14). That work *is* this session's, and §3.3 and §3.4 give
its evidence.

**Finally, §13** — permission centralization — was classified rather than
swept, which changed the answer: most of what the audit counted is scope
selection, not authorization. §5 gives the census, the four drift sites it
found, and the guard test that now holds the surface in place. With that,
every P0/P1 and P1/P2 item in the priority list is closed. What remains
open is stated in §7 and is open because nothing here could measure it: no
browser, no device, no load generator.

---

## 1. Verification method

Every result below was executed, not inspected:

- **Real PostgreSQL** — the repository's actual migration chain 001→052
  applied unedited to a disposable database (PGlite), seeded with the
  two-college QA dataset, with each statement run **as the real role** under
  RLS (`as()`), never as the owner. Postconditions are read with owner
  privileges so a denial cannot be mistaken for an empty result.
- **Mutation testing** — `mutatedFile()` / `mutatedFiles()` rebuild the same
  chain with exactly one control removed. They throw if a pattern stops
  matching, so a mutation that silently stopped applying fails loudly instead
  of asserting that a defect is absent from a migration it was never
  introduced into. This caught three real problems in this session's own
  work: a mutation that renamed a trigger instead of removing it (so the
  renamed trigger kept firing), four mutations that stopped mutating when 052
  redefined the function they targeted, and an unreachable check in 052
  itself.
- **PostgREST/RPC equivalence** — the harness executes SQL as the
  `authenticated` role with `request.jwt.claim.sub` set, which is the same
  security context PostgREST establishes. A control that holds here holds for
  a direct REST call, because it is the database refusing, not the app.

---

## 2. Ship-blocker results

### P1-1 — cross-college security instruction leak

| | |
| --- | --- |
| **Original vulnerability** | A College B guard could read College A's `audience='all'` security instructions. |
| **Root cause** | `security_instructions_read_security` checked `security_has_permission()` and the audience, but had **no tenant predicate**. Any active guard matched any college's rows. |
| **Affected tables** | `security_instructions` |
| **Affected policies** | `security_instructions_read_security` |
| **Fix (051)** | Added `college_id = public.get_my_college_id()` as the first conjunct. |
| **Database protection** | RLS SELECT policy. |
| **Attack BEFORE** | PASS (leak) — reproduced by mutation. |
| **Attack AFTER** | **DENIED** — 0 rows. |
| **Legitimate AFTER** | **PASS** — College A guard still reads its own. |
| **Direct PostgREST** | **DENIED** — it is RLS, not app code. |
| **Mutation** | Remove the predicate → **leak reproduces**. Control is load-bearing. |

### P1-2 — finance ledger integrity

| | |
| --- | --- |
| **Original vulnerability** | Deleting a fee cascade-deleted its payments; cleared payments were deletable; `paid_amount` was directly settable; a paid fee could regress. |
| **Root cause** | `payments.fee_id → fees` was `ON DELETE CASCADE`; no immutability or derivation guard on the ledger columns. |
| **Affected tables** | `payments`, `fees` |
| **Affected functions** | `update_fee_on_payment`, `guard_fee_ledger_columns`, `guard_fee_delete` |
| **Fix (051)** | FK re-pointed to `ON DELETE RESTRICT`; `guard_fee_delete` refuses a fee with payments; `update_fee_on_payment` refuses deleting a **cleared** payment and drives `paid_amount`; `guard_fee_ledger_columns` refuses hand edits to `paid_amount`/`status` unless the write carries the ledger trigger's own transaction-local flag. |
| **Attack BEFORE** | PASS. |
| **Attack AFTER** | **DENIED** — all of: delete fee with payments, delete cleared payment, set `paid_amount` by hand, regress a paid fee, revive a refunded payment. |
| **Legitimate AFTER** | **PASS** — recording a payment drives `paid_amount` to 4000 through the ledger; refund workflow intact (`approve_refund` raises/lowers the flag around its own fee update). |
| **Concurrency** | **PASS** — real PostgreSQL 18, two simultaneous `psql` sessions: two payments cannot overpay one fee; a refund is approved exactly once. |

> **Discovered while mutation-testing this:** deleting a fee's ledger requires
> removing **three independent controls** — the RESTRICT FK, `guard_fee_delete`,
> *and* `update_fee_on_payment`'s DELETE branch, which refuses a cleared
> payment even when the delete arrives as a cascade from the parent. My first
> mutation removed only the first two and the attack still failed. That is
> defence in depth working exactly as intended, and it is recorded here
> because it is stronger than the fix claimed to be.

### P2-3 — closed semester is actually closed

| | |
| --- | --- |
| **Original vulnerability** | `semester.status='closed'` did not stop writes to marks, attendance, enrolments, offerings or timetable. |
| **Root cause** | No policy or trigger resolved the chain `child → offering → semester → status`. |
| **Affected tables** | `attendance`, `marks`, `course_enrollments`, `timetable_slots`, `course_offerings` |
| **Affected functions** | `guard_closed_semester` (new in 051) |
| **Fix (051)** | One `BEFORE INSERT OR UPDATE OR DELETE` trigger on all five tables, resolving the chain. Offerings are scoped precisely: no create/delete/status-change/move-into a closed term, while a metadata edit on a historical offering stays legal. Service/seed writes (`auth.uid() IS NULL`) exempt so fixtures still load. |
| **Attack BEFORE** | PASS. |
| **Attack AFTER** | **DENIED** — insert marks, edit historical marks, delete historical attendance, create an offering in a closed term. |
| **Legitimate AFTER** | **PASS** — the active semester still accepts marks; closed data stays **readable**. |
| **Mutation** | Detach from `marks` → **write into the closed term succeeds**. Load-bearing. |

### P2-4 — pending users have no tenant access

| | |
| --- | --- |
| **Original vulnerability** | A self-registered pending account resolved to a college and could read tenant data through direct API paths; only browser middleware stopped it. |
| **Root cause** | `get_my_college_id()` / `get_my_role()` returned the profile's college and role **regardless of `status`**. Every RLS policy in the schema is built on those two helpers. |
| **Fix (051)** | Both helpers gated on `status = 'active'`. A pending or suspended account resolves to `NULL` — i.e. no tenant — in every policy at once, without touching a single policy. Accept-invite is unaffected (it keys on `id = auth.uid()`). |
| **Attack BEFORE** | PASS. |
| **Attack AFTER** | **DENIED** — a pending account reads 0 profiles, 0 offerings. |
| **Legitimate AFTER** | **PASS** — an active member reads its own college. |
| **Mutation** | Remove the `status='active'` gate → **pending account reads college offerings**. Load-bearing. |

### P2-5 — cross-tenant inserts

| | |
| --- | --- |
| **Original vulnerability** | Cross-tenant INSERT into `fees`, `hostel_allocations`, `invitations`. |
| **Root cause** | `fees` has **no** composite `(student_id, college_id)` FK — verified, not assumed. The invitation INSERT policy checked only `invited_by = auth.uid()`. |
| **Fix (051)** | `guard_row_student_tenant` on `fees`; `guard_allocation_tenant` on `hostel_allocations` (student **and** room must match); invitation policy bound to `college_id = get_my_college_id()` **and** `can_invite_role(role)`, mirroring the application's invite tiers. |
| **Attack AFTER** | **DENIED** — all three. |
| **Legitimate AFTER** | **PASS** — finance bills its own student; admin appoints a director. |
| **Mutation** | Each control removed independently → **each attack reproduces**. Load-bearing. |

---

## 3. Findings this session added

### 3.1 §16 — migration 047 on a populated database: **characterised**

047 adds `offering_id UUID NOT NULL` to six transaction tables with no
`DEFAULT` and no backfill. That is legal only while the tables are empty.

**Reproduced** (`tests/migration-047-populated.test.ts`): built a post-046
database, inserted realistic legacy rows (2 attendance, 1 marks, keyed on the
old `course_id`), then applied 047 whole.

| Result | Status |
| --- | --- |
| 047 applies | **NO — refused**, "column contains null values" |
| Pre-existing history survives the failed attempt | **YES — untouched** |
| An offering is invented for an unmappable row | **NO — none; `course_offerings` still empty** |

**This is the correct behaviour, not a defect.** There is no derivable
mapping from `(student, course, date)` to a `course_offering` without knowing
the section and term; guessing would silently attach a student's attendance
to a section they were never in. §16 requires exactly this: *"Migration must
fail safely if mapping cannot be proven. Never silently assign arbitrary
offerings."* It does.

**A correction I owe this report.** I first wrote that no backfill existed
and that one could not be written here. That was wrong, and it was wrong
because I read a truncated `git status` (`| head -3`) and never saw
`scripts/migrate-047-backfill.sql`, which was sitting untracked in the
repository the whole time.

The backfill exists. What did *not* exist was any evidence that it works —
nothing executed it. "There is a backfill" was a claim about a file.

So the second half of that test now rehearses the real production sequence
end to end on populated data:

```
001..046  →  legacy rows  →  BACKFILL  →  047  →  verify
```

| Property §16 requires | Result |
| --- | --- |
| Backfill runs | **PASS** |
| Backfill is idempotent (run twice) | **PASS** |
| 047 then applies cleanly | **PASS** |
| 100% mapping, no silent orphaning | **PASS** — 0 unmapped rows in attendance, marks, enrolments |
| Legacy values preserved verbatim | **PASS** — 41/50 still 41/50 |
| Offering agrees with the row's course, college and term | **PASS** |
| Legacy `course_enrollments.student_id` translated user → student | **PASS** |
| No offerings invented beyond what the data implies | **PASS** — exactly 1 |

**§16 is verified, not asserted.**

047 was **not modified**: it is applied history in the hosted project
(050's preflight proves it completed), so a remediation belongs in a new
migration, not an edit to 047.

### 3.2 A hypothesis I tested and disproved

I suspected P2-3 was undermined because nothing appeared to guard
`semesters.status` — if a plain `UPDATE semesters SET status='active'` worked,
the freeze would be a speed bump.

**I probed it rather than reporting it.** The result:

- An admin's `UPDATE` affected **0 rows** — RLS filtered it; status stayed `closed`.
- A trigger I had not found, `guard_academic_period()` (migration **047**, not 051),
  raises on any write to a closed period.

Reading that function: `planned → active → closed` are the only transitions,
`closed` is unconditionally immutable, `college_id` is immutable, and a
semester cannot go active unless its academic year is. **§7's academic state
machine was already fully enforced, and more strictly than §7 asks.** The gap
did not exist.

### 3.3 §6 — controlled reopening: **CLOSED** (migration 052)

§6 asks for `CLOSED → correction request → approval → controlled reopen →
audited → close again`. Before 052 the database allowed **no reopen at all**.

An earlier draft of this report called that "stricter than requested" and
left it as a product decision. That was the wrong call, and the reasoning was
wrong in a specific way: an absolute seal does not remove the need to correct
a mark found wrong after close, it removes the *lawful* way to do it. The
work still has to happen, so it happens with service credentials, out of
band, unaudited — the seal pushes the mutation somewhere nobody can see it.
§6 says as much: *"Prefer a controlled correction mechanism instead of broad
unrestricted reopening."*

**What 052 does.** The generic path stays exactly as shut as it was — every
`UPDATE` against a closed semester is still refused, for everyone, by both
RLS and the period trigger. One door opens: `reopen_semester(semester, reason)`,
`SECURITY DEFINER`, which checks the actor, demands a reason of real length,
refuses a semester in another college without confirming it exists, refuses a
semester inside a closed academic year, and leaves an audit record.

**Why a new `reopened` state rather than a return to `active` (§7).**
`idx_semesters_one_active` permits one active semester per college and that
is correct — "active" means the term now running. A term reopened for a
correction is not the running term; making it `active` would collide with
that index or force the live term closed to make room. §7 lists `REOPENED`
as a legitimate richer state, so:

```
planned ──→ active ──→ closed ⇄ reopened
                          ↑         │
                          └─────────┘
```

`is_current` stays false throughout. Academic writes flow again because
`guard_closed_semester` (051) freezes on `status = 'closed'` and `reopened`
is not that. While reopened, the *only* permitted change is back to `closed`
— dates, name and academic year stay sealed, because reopening exists to
correct records, not to re-plan a term.

**One deliberate narrowing, called out so it can be overruled:** the RPC
admits `admin` and `super_admin`, not `director`, even though a director
manages semesters that are open. Reopening reaches into sealed history, which
§6 frames as a separate approved act. It is a one-word change in the
migration, and `tests/phase3-reopen-audit.test.ts` asserts the current
choice, so changing it cannot happen silently.

**A defect this found in my own work.** The mutation that removes the
"reopened may change only status" freeze could not make its attack succeed:
the transition check above it answered first, refusing a no-status-change
`UPDATE` with a message about a transition nobody attempted, and leaving the
column freeze unreachable. Fixed by testing the transition only when the
status actually changes. Both checks are now live and separately mutation-proven.

### 3.4 §15 — audit durability: **A-002 closed** (migration 052)

`lib/audit.ts`'s `logAudit()` is called at 73 sites, but it runs **after** the
mutation commits. A crash in the window between keeps the change and loses the
record, which is the one failure mode an audit trail must not have. That was
recorded as A-002 and left PARTIAL.

052 adds three trigger-written records that live in the **same transaction**
as the thing they describe:

| Trigger | Fires on | Records |
| --- | --- | --- |
| `audit_period_status` | `semesters`, `academic_years` — status changed | `opened` / `closed` / `reopened` / `reclosed`, with before, after and the reopen reason |
| `audit_profile_privilege` | `profiles` — role, status or department changed | both sides of the change (§30 "role changes audited") |
| `audit_marks_change` | `marks` — UPDATE or DELETE | student, exam type, marks before and after |

These **complement** `logAudit()` rather than replacing it: the application
still records intent and request context the database cannot see. Nothing was
removed.

**The atomicity is measured, not asserted.** A test opens a transaction,
changes a semester's status, observes the audit row already present
mid-transaction, rolls back, and then confirms that *both* the status change
and the audit row are gone. Either both land or neither does.

**Why marks audits UPDATE and DELETE but not INSERT.** §25 warns against
making every academic write cost more, and marks arrive in bulk — a teacher
saving one class writes dozens of rows at once, and auditing each INSERT would
double that for no security gain, since the row already carries `entered_by`
and `created_at`. What is *not* evident from the row is a later edit or
removal — a grade that changed after it was recorded — which is exactly what
§15 names ("marks modified", "grade changed") and exactly what this captures.

**Audit records are protected from modification (§15).** `audit_logs` had no
UPDATE or DELETE policy, so those statements already matched zero rows. Two
reasons that was not enough: the refusal is **silent** (a caller deleting its
own tracks gets a success and an empty result), and it depends on the
continued *absence* of a policy — one careless `FOR ALL` policy added later
reopens it. `guard_audit_immutable` states the rule in the table. The tests
say plainly that it cannot make today's refusal loud, because RLS filters the
row away before any row-level trigger fires; a mutation adds a permissive
policy and shows the trigger is then the thing that refuses.

---

## 4. Definition of Done

| Item | Status | Evidence |
| --- | --- | --- |
| Cross-college security instructions | **PASS** | RLS + mutation |
| Pending users cannot access tenant data | **PASS** | RLS + mutation |
| Cross-tenant fee / hostel / invitation writes | **PASS** | triggers + policy + mutation |
| HOD scope still enforced | **PASS** | regression in `phase3-hardening` |
| Role transitions unified | **PASS** | `enforce_profile_privileged_columns` + `can_invite_role` share one tier map; a drift test now compares the SQL `CASE` arms against `lib/auth/invite-tiers.ts` arm by arm, so the two physical copies cannot diverge |
| Closed semester blocks child writes / stays readable | **PASS** | trigger + mutation |
| Reopening requires authorization | **PASS** | 052 `reopen_semester()` — admin/super_admin only; teacher, HOD, warden, director, pending account and cross-college admin each refused, invoked directly; not callable by `anon` |
| Reopening is audited | **PASS** | trigger-written row carrying actor, before, after and the mandatory reason; re-close recorded distinctly as `semesters.reclosed` |
| Attendance & marks require enrolment | **PASS** | `guard_enrolled_student` + mutation |
| Academic dates validated | **PASS** | `guard_attendance_date` |
| Cleared payments immutable / undeletable | **PASS** | three independent controls |
| Fee→payment cascade cannot destroy history | **PASS** | RESTRICT + mutation |
| `paid_amount` cannot be hand-set | **PASS** | ledger-flag guard + mutation |
| CHECK constraints added | **PASS** | marks, fees, gate passes, semesters, academic years, hostel rooms |
| Partial UNIQUE (one active allocation) | **PASS** | `idx_hostel_alloc_one_active` — observed refusing a duplicate during mutation work |
| Migration 047 production-safe | **PASS** | fails safely without the backfill; with `scripts/migrate-047-backfill.sql` the full sequence applies, maps 100%, and preserves every legacy value — rehearsed end to end |
| Mutation tests pass | **PASS** | 19/19 — 9 against 051, 10 against 052 |
| Typecheck / lint / build | **PASS** | tsc clean; lint 0 errors (593 pre-existing warnings); `next build` compiled |
| Academic audit trail (§15) | **PASS** | semester/year transitions, profile role-status-department changes, and marks UPDATE/DELETE are now **trigger**-written inside the mutation's own transaction — A-002 closed for these. See §3.4 |
| Audit records protected from modification | **PASS** | `guard_audit_immutable`; proven load-bearing by adding a permissive policy and watching the trigger refuse |
| Controlled reopening (§6) | **PASS** | see §3.3 |
| Permission centralization (§13) | **PASS** | 218 gate sites classified; 130 are named capabilities, 88 are section role gates where the role is the rule. 4 drift sites fixed; the surface is pinned and "no ungated mutation" is enforced by `tests/authorization-surface.test.ts`, both checks shown to fail when mutated. See §5 |

---

## 5. §13 — permission centralization: classified, then closed as a property

§13 says, in one breath, "centralize permission checks" and *"Do NOT blindly
replace everything. Classify each authorization rule."* Those pull against
each other, so the classification came first. It changed the answer.

### The census

`requireRole` / `requireRoleFromRequest` is the gate everywhere. There are
**218** call sites:

| Kind | Count | What the rule actually is |
| --- | --- | --- |
| Resolve through the named `PERMISSIONS` table | **130** | **CAPABILITY** — `assign_hod`, `approve_refund`, the gate-security set, the escalation set. Shared across call sites, and the UI asks the same table through `can()` |
| Inline role array inside the matching portal section | **88** | **ROLE** — `requireRole(["director"])` inside `/director`, `["admin"]` inside `/admin`. 88 sites, **14** distinct role sets |

Plus the 58 `role === "…"` comparisons the audit counted. Classified, those
are almost entirely **SCOPE**, not authorization, and they run *after* the
gate:

- `actor.role === "hod"` → narrow the query to the actor's own department (**DEPARTMENT**)
- `actor.role === "admin" ? actor.collegeId : actor.userId` → pick the cache key's scope (**TENANT**)
- `form.role === "student"` → show the enrolment-number field (**UI**)
- `candidate.role !== "warden"` → the *target* must be a warden (**RESOURCE**, not the actor's authority)

Rewriting those through a permission call would change behaviour while
looking like a refactor — which is the outcome §13's warning exists to prevent.

### Why the remaining 88 were not renamed

Because the role *is* the rule. `PERMISSIONS.admin_only = ["admin"]` is not a
capability; it is the literal `["admin"]` with a layer of indirection in
front, and §13 is explicit: *"Do not create a giant generic function that
hides important business logic. Authorization should remain readable and
testable."* A 1:1 entry per call site would make the table longer and the
code no clearer.

### What was done instead

Three things, each executable:

**1. Fixed the drift the census exposed.** Four call sites hardcoded a role
array that was *already named* in `PERMISSIONS`, while the named entry was
referenced by nothing — `create_department` and `create_course`. Anyone
editing those entries would have believed they had changed who can create a
department, and nothing would have changed. The four sites now read the
table. **The role arrays are identical**, so nothing about who can do what
moved.

**2. `tests/authorization-surface.test.ts` (9 tests).** It asserts the
properties that a rename would only have gestured at:

- **Nothing mutates without a gate.** Every exported function in all 103
  action/route files is gated, is handed an `actor: AuthorizedActor` that
  `requireRole` already vouched for (checked on the *signature*, not on a
  `…Core` naming convention), delegates to a gated function in its own file,
  or is a QStash-signature-verified cron route. The four pre-authentication
  auth routes are listed by name.
- **No permission entry controls nothing.** Two remain deliberately
  unenforced (`escalation_resolve` — no resolve action exists;
  `institution_analytics_read` — the dashboards gate on two other entries).
  Both are named, and the count is pinned so the list cannot quietly grow.
- **The surface is pinned.** All 14 distinct role sets, per section, in 30
  lines. Widening a gate — adding `admin` to a warden-only action — can no
  longer be a one-word edit nobody notices; it changes this list and has to
  be justified in review.
- `can()` (which decides whether a button renders) and `requireRole` (which
  decides whether the action runs) are proven to read the same table.

**3. Verified the test can fail.** A green guard test is worth nothing until
it has been seen to go red, so both checks were mutated:

| Mutation | Result |
| --- | --- |
| Widened `hostel_room_read` to include `student` | pin failed, printing `admin+student+warden` as the diff |
| Replaced a `requireRole` call with a literal actor object | ungated check failed, naming `listWardenRooms` |

Both reverted; `git diff` on that file is empty.

### Honest limits

These are **static** properties of the source. They hold for every call site
at once, which is what makes them worth having, but they are not a substitute
for the real boundary: authorization is enforced by RLS, the tenant guards
and the triggers in 047/050/051/052, and that is what the adversarial and
mutation suites exercise against a live database. A gate is defence in depth
on top of that — which is exactly why a *missing* one should fail a build,
and now does.

---

## 6. Change inventory

**Added by this session:**

| File | Kind |
| --- | --- |
| `supabase/migrations/052_controlled_reopen_and_audit.sql` | NEW — see below |
| `tests/phase3-reopen-audit.test.ts` | NEW — 38 tests (§6/§7/§14/§15) |
| `tests/staging-mutations-052.test.ts` | NEW — 10 mutations against 052 |
| `tests/authorization-surface.test.ts` | NEW — 9 tests (§13) |
| `tests/staging-mutations-phase3.test.ts` | NEW — 9 mutations against 051 |
| `tests/migration-047-populated.test.ts` | NEW — 11 tests (§16) |
| `PHASE3_REMEDIATION_REPORT.md` | NEW — this report |

**Modified by this session, with reasons:**

| File | Change | Why |
| --- | --- | --- |
| `tests/staging/mutate.ts` | added `mutatedFiles()` | a control is not always in one file — an RLS policy in 047 and a trigger in 052. Every named file must still actually change, or it throws |
| `tests/staging-mutations-period-tenant.test.ts` | 4 mutations repointed at 052 | 052 redefines `guard_academic_period()`, so 047's copy no longer runs and those mutations silently stopped mutating. They **failed** when 052 landed — the harness doing its job. **No assertion was changed** |
| `tests/staging-security-definer.test.ts` | 4 new functions added to the §26 inventory; a `reopen_semester` block appended | that inventory fails until every `SECURITY DEFINER` function is listed *and* its grant decided. It caught all four |
| `app/(portal)/admin/departments/actions.ts`, `app/(portal)/admin/courses/actions.ts` | 4 gates point at their named `PERMISSIONS` entry | those entries already existed with **identical** role arrays and were referenced by nothing — editing them would have changed nothing. No role array changed |

**What 052 contains:** `reopen_semester(uuid, text)`; a redefined
`guard_academic_period()`; the `reopened` state on `semesters`;
`guard_audit_immutable`; `audit_academic_period_status`,
`audit_profile_privilege`, `audit_marks_change` and their triggers; two
indexes on `audit_logs` for the read path those records feed.

**Pre-existing, verified but not written by this session:**
`supabase/migrations/051_phase3_hardening.sql`,
`tests/phase3-hardening.test.ts`, `scripts/migrate-047-backfill.sql`, and the
uncommitted edits to seven staging test files (all correct — they align
assertions to 051's behaviour).

Application code changed in exactly one way: four `requireRole` calls now read the `PERMISSIONS` entry that already held the same roles. No role array, and no authorization outcome, was altered. No existing assertion was weakened.

---

## 7. Security scorecard

Evidence only. "UNVERIFIED" where there is none.

| Control | Verdict | Basis |
| --- | --- | --- |
| Cross-tenant isolation | **PASS** | RLS swept across every table; composite FK refuses even with RLS bypassed; mutation-proven |
| HOD department isolation | **PASS** | regression suite; was already strong, preserved |
| Role escalation | **PASS** | self-role change, super_admin protection, tier-bound promotion |
| Pending-user isolation | **PASS** | helper gate; mutation-proven |
| Finance integrity | **PASS** | three independent controls; mutation-proven; real two-session concurrency |
| Closed semester | **PASS** | trigger across 5 tables; mutation-proven; state machine immutable |
| Enrolment binding | **PASS** | trigger; mutation-proven |
| Gate security | **PASS** | unchanged; 10 controls mutation-checked in the existing suite |
| RPC / SECURITY DEFINER | **PASS** | helpers are `STABLE`, pinned `search_path`, and now status-gated |
| Database constraints | **PASS** | CHECKs + partial unique; refusal observed at superuser level |
| Migration 047 populated path | **PASS** | backfill + 047 rehearsed on populated data; idempotent; 0 unmapped rows |
| Controlled semester reopening | **PASS** | one `SECURITY DEFINER` door; 6 classes of caller refused invoked directly; not callable by `anon`; window proven narrow and self-closing; 10 mutations |
| Academic audit durability | **PASS** | trigger-written for period transitions, role changes and marks edits; atomicity measured by rollback, not argued |
| Audit-record immutability | **PASS** | RLS (silent) + `guard_audit_immutable` (loud, once a policy exists); mutation-proven |
| Permission centralization | **PASS** | classified rather than swept; no ungated mutation across 103 action/route files; 14-entry surface pinned; guard proven to fail when a gate is widened or removed |
| Browser / real-device workflows | **UNVERIFIED** | no browser, no device in this environment |
| Load behaviour of the new triggers | **UNVERIFIED** | no load test. The new audit triggers append to an indexed table and the period guard does single-row primary-key lookups, so the cost should be small — but that is reasoning, not measurement, and it stays UNVERIFIED until something measures it |

| RPC authorization (§26) | **PASS** | `reopen_semester` refuses student, teacher, warden, HOD, director, pending and cross-college callers when invoked directly; `anon` cannot execute it at all |

---

## 8. Final gate

```
Test files   52 passed (52)
Tests        1476 passed (1476)
Duration     428.02s

TypeScript   clean
Lint         0 errors (593 pre-existing warnings)
Build        next build compiled
```

Mutation coverage: **19** controls each removed individually and the original
attack reproduced — 9 against 051, 10 against 052.

Nothing here is marked PASS because the code looks right. Every PASS names the
statement that was executed and the postcondition that was read back
afterwards. The three UNVERIFIED rows stay UNVERIFIED.
