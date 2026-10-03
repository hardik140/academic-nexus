# Academic Lifecycle, Assignments & Student Workflows — Implementation Contract

Status: **approved by the owner on 2026-10-03, with the owner's ten modifications folded in.** PR 1 implements §15's first boundary. PRs 2 and 3 start only after PR 1 is fully verified.

The existing Academic Nexus model is the source of truth. This contract extends it and builds no parallel academic system.

---

## 0. Vocabulary — one concept per term

| Concept | Where it lives | Notes |
|---|---|---|
| College academic year | `academic_years` (046) | planned → active → closed; one active per college; Admin/Director |
| College academic term | `semesters` (046/047/052) | An institutional term ("Fall 2026"); one active per college; Admin/Director; reopen per 052. **The UI says "Term".** |
| Department operational term | `department_terms` (**new, 055**) | The HOD starts and ends their department's operation **inside** the active college term. Not a second term model. |
| Programme | `programmes` (046) | Belongs to a department. `duration_semesters` is the number of programme semesters. |
| Programme semester number | `students.semester` (003) | The student's "Semester 5". Changed by year-end progression only (PR 3). |
| Programme year of study | **derived** | `start year of the college academic year − section.batch_year + 1`. Never stored. |
| Class | **derived** | Programme + year of study, for example "B.Tech CSE · Year 3". |
| Section | `sections` (046) | A cohort: programme + `batch_year` + name ("2026 A"). It persists across terms. |
| Current student section | `student_section_assignments` (**new**) | Effective-dated; one current row per student. |
| Course | `courses` (002) | Catalog entry. `department_id` is the owning (teaching) department. |
| Course offering | `course_offerings` (046) | Term + course + section + instructor. This is the teacher assignment. |
| Course enrollment | `course_enrollments` (047) | Student in an offering. |

## 1. Existing tables reused (unchanged in shape)

`academic_years`, `semesters` (with the 047 lifecycle trigger and 052 reopen), `departments`, `programmes`, `sections`, `courses`, `course_offerings`, `course_enrollments`, `attendance`, `marks`, `timetable_slots`, `students`, `profiles`, `invitations`, `notifications`, `audit_logs` (immutable, 052), the 053/054 access gate (`tenant_access_gate`, `guard_tenant_write_access`, `my_operational_role()`), and Supabase Auth invitation tokens (`generateLink`).

## 2. Existing tables and rules modified

| Object | Change | PR |
|---|---|---|
| `course_offerings` | **Instructor eligibility trigger** (§6, decision 4). **Closed-term instructor lock**: defect 5; amends `guard_closed_semester`. **Instructor history** trigger. Auto-enrolls a section's current students when an offering is created in the active term. Teacher-clash check on an instructor change. | 1 |
| `attendance`, `marks` | New trigger `guard_offering_open_for_records`: no write to a `cancelled` offering, and none to a `completed` one unless its term is `reopened` (052's correction window). A trigger rather than a change to `can_write_offering_records()`, so the HOD's approved-correction path is covered too. Mirrored in `lib/offerings.ts` (`offeringOpenForRecords`). Defect 4. | 1 |
| `course_enrollments` | Direct staff writes narrowed to `admin`; the HOD and instructor branches are removed. No application code used them. New trigger: no two `enrolled` rows for one student in the same course in the same term. | 1 |
| `course_enrollments.status` | Adds `transferred`, plus `ended_at` and `ended_by_request`. | 2 |
| `timetable_slots` | Conflict trigger for teacher, section and room, overlap-aware and term-scoped. Writes go through functions only. Read narrowed for students and parents to their own enrollments. Defect 2, database half. | 1 |
| `departments` | HOD history trigger. `hod_id` stays authoritative. | 1 |
| `programmes` | HOD may INSERT and UPDATE **own-department** programmes; no DELETE; validated changes; audited. | 1 |
| `sections` | Structural fields are immutable once the section holds history; deactivation is refused while students are assigned; audited. | 1 |
| `invitations` | `invitations_update_by_invitee` dropped: acceptance runs through the service role or a definer function. Defect 3. `can_invite_role`: a teacher may invite a student only while a current Class In-Charge. | 1 |
| `guard_tenant_write_access` | One more transaction-local sanction, `app.academic_service`. It is set only inside `accept_student_invitation()`, which a still-pending invitee calls. | 1 |
| `students.semester` | Guarded: written only by the progression function. | 3 |
| Student schedule, web and mobile | Shows only the student's own enrolled offerings in the active term. Defect 2, application half. | 1 |
| Teacher timetable, web and mobile | Limited to the active term. | 1 |
| Teacher dashboard | Today's classes and workload limited to the active term; lists the sections the teacher is Class In-Charge of. | 1 |
| `guard_tenant_write_access` on `user_sessions` | Dropped if present, restating 054's intent (replaying 053 would attach it). | 1 |
| HOD student invite | Rebuilt on placements (§11). Defect 1. | 1 |

## 3. New tables

Every new table has RLS enabled, the restrictive `tenant_access_gate`, the `guard_tenant_write_access` trigger, plain foreign keys plus one `guard_academic_tenant` trigger that requires every reference to belong to the row's college (047 drops and re-adds the composite `(id, college_id)` keys, so referencing them would make 047 non-replayable), and **no direct write policies**. Writes happen only inside `SECURITY DEFINER` functions that check `my_operational_role()` and `my_operational_college_id()`. Blocked colleges and revoked sessions therefore cannot act.

| Table | PR | Purpose | Key constraints |
|---|---|---|---|
| `department_terms` | 1 | the department's operation inside a college term | UNIQUE(department_id, semester_id); status `active` → `ended`; immutable once ended |
| `section_class_incharges` | 1 | Class In-Charge per term and section | partial UNIQUE(semester_id, section_id) WHERE ended_at IS NULL; append-only except closing once |
| `student_section_assignments` | 1 | effective-dated student → section | partial UNIQUE(student_id) WHERE ended_at IS NULL; the section's programme department must equal the student's home department; never deleted |
| `department_hod_assignments` | 1 | HOD history | partial UNIQUE(department_id) WHERE ended_at IS NULL; trigger-written only |
| `offering_instructor_history` | 1 | teacher history per offering | trigger-written only |
| `external_teaching_authorizations` | 1 | lets a teacher from department X be assigned to department Y's courses | partial UNIQUE(department_id, teacher_id) WHERE revoked_at IS NULL |
| `student_invitation_placements` | 1 | the server-resolved academic placement of a student invitation | PK = invitation_id; immutable except consumption |
| `section_change_requests`, `section_change_events` | 2 | section-change workflow | one open request per student |
| `course_change_requests`, `course_change_events` | 2 | course-change workflow | one open request per enrollment |
| `progression_runs`, `progression_decisions` | 3 | year-end proposals | one run per department and academic year |

## 4. Migration sequence

- **055_academic_foundation.sql** (PR 1), in order:
  1. Additive tables.
  2. Triggers and functions.
  3. Policy changes: the two narrowings, the HOD programme grant, dropping the invitee update policy.
  4. Defect fixes.
  5. Backfill.
- **056_student_academic_requests.sql** (PR 2).
- **057_year_end_progression.sql** (PR 3).
- **048 stays reserved** for dropping `courses.instructor_id`.

**Backfill in 055. It is derived only, nothing invented:**
- `department_hod_assignments`: one open row per department that has a `hod_id`, with source `backfill`.
- `offering_instructor_history`: one open row per offering with an instructor.
- `department_terms`: `active` for every department that has offerings of its own courses in the currently active college term. Everything that works today keeps working.
- `student_section_assignments`: only for a student whose `enrolled` enrollments in active-term offerings all point to **exactly one** section in the student's home department. Every other student goes to the reconciliation list (`students_without_section()`), where the HOD or Admin assigns them explicitly.
- **No Class In-Charges and no placements are invented.**

**Rehearsal:**
- The full chain runs on PGlite and on PostgreSQL 18.
- Each migration ends with a rollback footer.
- **Nothing is applied to the hosted database.**

## 5. State machines

Every machine is enforced by a database trigger for every caller, and every transition is made only through a definer function.

```
department_terms          (none) ──start──▶ active ──end──▶ ended            (closing the college term ends any still-active row)

section_class_incharges   open ──replace/end──▶ ended                        (replace = end + open, one transaction)

student_section_assignments open ──transfer (PR 2) / progression (PR 3)──▶ ended

student_invitation_placements pending ──accept──▶ consumed                   (void when the invitation is revoked/expired)

section_change_requests (PR 2)
  pending_current_incharge ─▶ pending_target_incharge ─▶ pending_hod ─▶ executed
  any pending ─▶ rejected (by that stage's approver) | withdrawn (by the student) | expired (department term ended)

course_change_requests (PR 2)
  pending_current_incharge ─▶ pending_home_hod ─▶ pending_target_hod* ─▶ pending_target_assignment ─▶ executed
  * only when the requested course's department ≠ the student's home department
  any pending ─▶ rejected | withdrawn | expired
```

**Notes:**
- **HOD approval executes.** HOD approval and execution are one transaction: the section transfer, or the course change once a target teacher assigns. "Approved but not executed" cannot exist.
- **Feasibility comes first.** The HOD approval step re-checks feasibility before it can succeed. A request that cannot be executed safely cannot be approved.

## 6. RBAC matrix

| Capability | super_admin | admin | director | hod | Class In-Charge | teacher | student |
|---|---|---|---|---|---|---|---|
| College year / term lifecycle | — | ✔ | ✔ | — | — | — | — |
| Appoint HOD | — | — | ✔ | — | — | — | — |
| Department setup: programmes create/edit (no delete) | — | ✔ | ✔ | own dept | — | — | — |
| Sections create/edit | — | ✔ | ✔ | own dept | — | — | — |
| Courses (existing 047 rule) | — | ✔ | ✔ | own dept | — | — | — |
| Start/end department operational term | — | ✔ (db) | ✔ (db) | own dept | — | — | — |
| Assign/replace Class In-Charge | — | ✔ (db) | ✔ (db) | sections of own dept | — | — | — |
| Create offering / assign instructor | — | ✔ | ✔ | courses of own dept | — | — | — |
| Grant/revoke external teaching authorization | — | ✔ (db) | ✔ (db) | own dept | — | — | — |
| Timetable slots | — | ✔ (db) | ✔ (db) | offerings of own dept's courses | — | — | — |
| Invite a student | — | — | — | sections of own dept | **own section, active term** | — | — |
| Assign section to an unplaced student | — | ✔ (db) | — | own dept | — | — | — |
| View workload / timetable | — | — | — | ✔ | ✔ | ✔ own | own |
| File section/course change (PR 2) | — | — | — | — | — | — | own |
| Approve stage (PR 2) | — | — | — | resolved HOD | resolved In-Charge | target-dept instructor (course change) | never |

**How the "(db)" entries work:**
- **The database grants the authority.** Admin and Director hold the database authority as institutional fallback, for example a department with no HOD.
- **PR 1 ships only the HOD UI.** It ships no Admin or Director screen for these, so the UI exposes nothing those roles can't actually do.
- **Mirrored on every layer.** Every capability is named in `lib/permissions.ts` and enforced in the server action, the mobile API route where one exists, and the database function or RLS.

**Decision 4: the instructor eligibility rule, as implemented.** An offering's instructor must satisfy all of:
1. same college as the offering;
2. `profiles.status = 'active'`;
3. role `teacher` or `hod`;
4. **either** `profiles.department_id = courses.department_id` (the owning department), **or** an unrevoked `external_teaching_authorizations` row for (the owning department, that teacher).

**Who grants an external authorization:**
- Only the owning department's HOD, or Admin/Director.
- Revocation is refused while the teacher is still the instructor of a `planned` or `active` offering of that department.

The rule is checked by a trigger on `course_offerings` (INSERT, and UPDATE of `instructor_id` or `course_id`) for every non-service caller. As a side effect, it closes 047's recorded residual: a Director can no longer name themselves instructor.

**Class In-Charge eligibility:**
- An active `teacher` or `hod` of the college.
- Home department equal to the section's programme department.
- Cross-department In-Charges are not allowed.

## 7. RLS strategy

**Reads:**
- **New tables:**
  - the student reads their own rows;
  - the Class In-Charge reads their sections' rows;
  - the HOD reads their department's rows, plus incoming course-change rows in PR 2;
  - Admin and Director read the whole college;
  - teachers read their offerings' students, as today;
  - `department_terms` and `section_class_incharges` are readable college-wide, because they are not sensitive.
- **`timetable_slots`:** staff keep college-wide read. A student reads slots of offerings they are enrolled in. A legacy parent reads their children's slots.

**Writes:**
- Only definer functions write the new tables, with authority re-derived from `departments.hod_id`, `section_class_incharges` and the offering.
- No function trusts a client-supplied department, HOD, In-Charge, section owner or teacher. The client supplies only the target object's id and, where needed, a choice the actor is entitled to make, such as which section an inviter places a student in. The function re-verifies that choice against the actor's authority.

**Gate:** the 053 guard test fails the build if any new table lacks `tenant_access_gate` or the write gate.

## 8. Historical-data strategy

- **Effective-dated rows are closed, never edited or deleted.** This covers section assignments, In-Charges, HOD history, instructor history and external authorizations. A trigger refuses every UPDATE except setting the `ended_*` / `revoked_*` columns once, and refuses DELETE.
- **The closed-term freeze is extended.** It now covers the instructor of a closed-term offering (defect 5). Offerings of a completed department term are not writable (defect 4), except inside 052's reopen window.
- **Attendance and marks always stay on the offering they were recorded against.** A transfer in PR 2 marks the old enrollment `transferred` and never moves rows.
- **"Which section was this student in during term T?"** is answered by `student_section_at(student, term)`. It overlaps the assignment intervals with the term's dates.
- **Requests and their event logs are immutable** once the request is terminal (PR 2).

## 9. Concurrency strategy

| Operation | Mechanism |
|---|---|
| Department term start/end | `pg_advisory_xact_lock(dept,term)` + `FOR SHARE` on the semester row (a concurrent term close waits) + UNIQUE(department_id, semester_id) + status compare-and-set |
| In-Charge assign/replace | `FOR UPDATE` on the current row + partial unique index |
| Section assignment, enrollment, (PR 2) transfer and course change, (PR 3) progression | per-student `pg_advisory_xact_lock` + partial unique "one current section" + trigger "one enrolled row per course per term" |
| Timetable slot writes, instructor change | per (college, term) advisory lock inside the conflict trigger, so two overlapping inserts cannot both pass |
| Invitation acceptance | `FOR UPDATE` on invitation + placement, UNIQUE(college_id, enrollment_number) |
| Approvals (PR 2) | `FOR UPDATE` on the request row + expected-state compare-and-set; the event log has UNIQUE(request_id, stage) |

**Known residual:**
- 052/F-01 remains: an academic write already in flight can commit into a college term that is closing concurrently.
- Department-term end takes the same locks as above, so it does not widen that window.

## 10. Timetable strategy

- **Authoring:** functions `create_timetable_slot`, `update_timetable_slot` and `delete_timetable_slot`. The authority is the HOD of the offering's course department, or Admin/Director.
- **Validation, done by the trigger and so applied to every caller:**
  - the offering's term is `planned` or `active`; closed and reopened terms are immutable, the latter because 051's freeze already covers them;
  - the offering is `planned` or `active` and has an eligible instructor;
  - `end_time > start_time`;
  - no **teacher** overlap, no **section** overlap and no **room** overlap (room names case-insensitive and trimmed) with any non-cancelled offering's slot in the **same term** on the same day;
  - an instructor change on an offering is refused if it would create a teacher overlap.
- **Student timetable:** slots of the student's `enrolled` offerings in the active term.
- **Teacher timetable:** slots of their offerings in the active term.
- **One source for both:** web and mobile read the same rows, so both see the same state.
- **History:** older terms' slots stay attached to their offerings and are never rewritten.

## 11. Invitation strategy

**Token:** Supabase Auth's `generateLink` token (hashed, single-use, expiring), unchanged. Its hosted single-use and expiry semantics are **UNVERIFIED** here. The `invitations` row is still bookkeeping. **Placement is the new authoritative record.**

**Invite flow, `inviteStudentCore`, shared by the HOD and the Class In-Charge (web action and mobile API):**
1. `student_invitation_preflight(section_id, enrollment_number, programme_semester)` is a read-only check that the actor may place a student in that section. The section must be active in an active term. The actor must be the HOD of the section's programme department, or the section's current In-Charge. The enrollment number must be unused and the programme semester within the programme's duration. The function returns the derived department and programme. The client's department is never used.
2. `inviteUserCore` creates the auth user, the profile with the **derived** department, and the invitation row.
3. `create_student_invitation_placement(invitation_id, section_id, enrollment_number, programme_semester, parent fields)` re-verifies everything and writes the placement.
4. **If step 2 or 3 fails, the auth user is deleted and the invitation revoked.** No half-created accounts remain (defect 1).
5. The email is sent only after the placement commits.

**Acceptance:**
- `accept_student_invitation(invitation_id)` is called by the invitee. In one transaction it:
  - verifies `user_id = auth.uid()`, the invitation is pending and unexpired, the college is ACTIVE, the placement is unconsumed and the section still active;
  - creates the `students` row (department from the section's programme, `batch_year` from the section, programme semester from the placement);
  - opens the section assignment and enrolls the student into the section's non-elective offerings in the active term;
  - activates the profile, marks the invitation accepted and consumes the placement;
  - audits all of it and notifies the inviter.
- Non-student invitations keep the existing acceptance path.

**Other paths:**
- **Resend:** keeps the placement, because it is keyed by invitation id.
- **Revoke:** voids the placement.
- **Forged information:** the invitee can write neither the placement nor, after defect 3, the invitation.

**Electives:**
- Automatic enrollment skips courses whose `type = 'elective'`.
- An elective is joined by explicit enrollment: by Admin in PR 1, or by course change in PR 2.

## 12. Notification strategy

- **Delivery:** in-app `notifications` rows are written **inside** the same database transaction as the state change, by the definer function. A notification can therefore never describe an uncommitted state.
- **Push:** Expo push is sent by the server action only **after** the function returns. It is best-effort and never blocks.
- **PR 1 events:**
  - Class In-Charge assigned or replaced (new and outgoing teacher);
  - external teaching authorization granted or revoked (the teacher);
  - department term started or ended (the department's teachers);
  - student invitation accepted (the inviter).
- **PR 2:** every workflow transition, to the next approver and the student.
- **PR 3:** progression decisions, to the affected students.

## 13. Test matrix (PR 1)

- **Disposable database (PGlite, the real chain).** Every row below is run as `authenticated` with the caller's claims.
- **Real PostgreSQL 18:** concurrency.
- **Mutation tests:** every guard is proven load-bearing.
- **Application tests:** actions, API routes, preflight and compensation.
- **Gallery E2E + axe:** the new components. Per D3, no authenticated flows run against the hosted database.
- **Mobile Jest:** the schedule filter.
- **pgbench:** the §36 queries before and after.

| Area | Cases |
|---|---|
| Department term | start; start twice fails; end; end twice fails; teacher can't start/end; wrong HOD can't; readiness lists missing items; pending instructors need acknowledgement; ending completes offerings and blocks writes; closing the college term ends active department terms; history unchanged |
| Class In-Charge | assign; replace keeps history; inactive or other-department or other-college teacher refused; wrong HOD refused; closed-term rows immutable |
| Teacher assignment | own-department instructor; external instructor with authorization; external without it refused; director self-assignment refused; inactive refused; other college refused; revocation refused while teaching; instructor history recorded; closed-term instructor change refused (**defect 5**) |
| Offerings | completed offering refuses attendance/marks (**defect 4**); reopened term still allows corrections; auto-enrollment of section members, skipping electives |
| Enrollment | duplicate active enrollment in the same course and term refused; HOD/instructor direct enrollment refused; concurrent duplicate enrollment (real PostgreSQL) |
| Section assignment | reconciliation assign; second current section refused; other-department section refused; history immutable; `student_section_at` |
| Timetable | create; teacher, section and room overlap refused; closed-term slot immutable; invalid offering refused; instructor change into overlap refused; concurrent overlapping inserts (real PostgreSQL); student sees only own slots (**defect 2**) |
| Department setup | HOD creates/edits own programme; other department refused; HOD delete refused; duration below enrolled students refused; structural audit rows; Admin/Director authority unchanged |
| HOD replacement | A → B: B inherits every capability on the existing configuration, A loses it immediately; nothing recreated (row counts and hashes identical); history row closed and opened |
| Invitations | HOD invites own department; In-Charge invites own section; other teacher refused; other department's section refused; other college refused; reused/expired/revoked refused; invitee can't edit invitation (**defect 3**); half-created account cleanup (**defect 1**); acceptance creates student + section + enrollments atomically; acceptance in a blocked college refused; audited |
| Adversarial | direct PostgREST writes to every new table refused; forged placement; skipped placement; client-supplied department ignored |

## 13a. Measured performance (PR 1)

pgbench on local PostgreSQL 18, 8 clients, 15 s per workload. The same data in both databases: the QA dataset plus 3,000 students, 30 sections, 191 offerings, 18,010 enrolments and 184 slots. "Before" is the chain through 054; "after" is the same database with 055 applied. 0 failed transactions in every run, and the timetable reads return the same rows in both.

| Workload | Before (tps) | After (tps) | Ratio |
|---|---:|---:|---:|
| Student timetable (own enrolled offerings, active term) | 585.9 | 641.1 | 1.09 |
| Student active course enrolments | 840.0 | 799.8 | 0.95 |
| Teacher timetable (active term) | 607.2 | 848.0 | 1.40 |
| Teacher active assignments | 1,082.4 | 1,116.1 | 1.03 |
| Teacher attendance write (upsert) | 351.7 | 336.8 | 0.96 |

New reads (after only): current section 6.6 ms, student `my_academic_context()` 3.7 ms, In-Charge context 3.0 ms, HOD `department_term_readiness()` 39.4 ms. Applying 055 to this database, backfill included, took 1.8 s and placed 3,005 students.

The first version of the student timetable policy measured **0.05×** (37 tps): an `OR` in the helper defeated the index and the set was planned per row. It was rewritten (two branches, one array, initplan form) before these numbers were taken.

## 14. Known risks

- **Hosted data is unknown.** D3 rules out reading the hosted database, so the reconciliation-list size and any existing offerings that violate the new eligibility rule are unknown. The trigger checks writes only, so existing rows keep working.
- **The programme semester at invitation** is chosen by the inviter, validated against the programme's duration. The system has no authoritative source for it before PR 3.
- **The year-of-study derivation** assumes `academic_years.start_date` is set for the active year; if it is not, the UI shows the programme semester instead.
- **Elective handling** in PR 1 is explicit only.
- **GoTrue is UNVERIFIED** for invite-token single-use and expiry on the hosted project.
- **F-01 residual**, see §9.
- **Size.** PR 1 is large.

## 15. Exact PR boundaries

**PR 1 — Foundation** (this PR, migration 055):
- **Defects:** fixes 1–5.
- **Database:** `department_terms` plus readiness, start and end; Class In-Charge; offering instructor eligibility, history, external authorizations and auto-enrollment; enrollment narrowing and uniqueness; student section assignments plus reconciliation; HOD history; programme grant and structural guards and audit; timetable authoring functions and conflict trigger; student invitation placements, preflight and acceptance; `my_academic_context()`.
- **HOD UI:** department term and readiness, structure, offerings and instructors, external faculty, Class In-Charges, timetable, unplaced students, student invites with a section.
- **Class In-Charge UI:** my class, plus invitations.
- **Teacher workload:** current-term offerings plus In-Charge sections.
- **Student UI:** academic context card and filtered schedule.
- **Mobile:** schedule and timetable filters; the mobile invite API accepts a section.
- **All tests.**

**PR 2 — Student workflows** (056): section change and course change requests, their state machines and execution, enrollment `transferred`, notifications, audit, concurrency and security tests, and web UI. Mobile workflow UI is deferred, per decision 8.

**PR 3 — Year-end** (057): progression runs, PROMOTE / HOLD with reason / GRADUATE decisions, next-year preparation, the `students.semester` guard, audit and tests.

Each PR must be independently testable and must leave `main` green.
