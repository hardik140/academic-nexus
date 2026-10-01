# D5 VALIDATION REPORT

S1 / owner decision D5 — failed Supabase reads must never resolve as successful empty results.

Validated 2026-09-30 against the uncommitted working tree. The implementation was written in an earlier session; this report is an independent check of the diff, the tests, and the full baseline. No D5 source changes were needed during validation.

**Verdict: D5 PASS — PROCEED TO S1 GATES 2–5**

---

## 1. Git state

| Item | Value |
|---|---|
| Branch | `feat/frontend-s1-ux-stabilization` |
| Base / HEAD | `a424d9aa3ad40ffd4af3c920e9ba41562c7a0857` (M6 integration) |
| Commits made | none (all changes uncommitted, for review) |
| `main` / `master` | untouched |
| Modified tracked files | 52 (46 server/helper `.ts`, 4 client pages, 1 e2e spec, 1 unit test) |
| New untracked files | 3 test files + this report |
| Diff | 451 insertions, 185 deletions |
| `git diff --check` | clean |

Not in the diff: `package.json` or lockfile, `supabase/migrations`, RLS policies, `lib/rbac`, `lib/permissions`, `lib/auth`, middleware, `lib/cache.ts`, `lib/read-result-server.ts`, `lib/finance/*`, `lib/gate-security/*`, cron routes. No unrelated refactoring was found. Every added line either reads a query's `error`, calls `assertRead`, or (in four pages) swaps a bare promise chain for `useAsyncResource` + `StateView`.

## 2. Tier 1 results

Mechanism: the existing `assertRead(error)` from `lib/read-result-server.ts`. It throws `dbError(error)`, which logs the fault for operators and hands the caller a generic `InternalOperationError`. PostgREST's no-row code (PGRST116) is not a failure, so `.single()` "not found" paths keep their existing null/not-found behavior. Successful return shapes are unchanged.

| Screen | Functions | Failed read throws | Empty works | Cache safe | Tests |
|---|---|---|---|---|---:|
| HOD approvals | `listHodApprovals`, `listCorrectionApprovals` (HOD and admin branches) | yes, all 10 check sites incl. department/staff/offering scope | yes, `{pending:[],processed:[]}` cached | yes | 21 |
| Finance refunds | `listRefundRequests` | yes, pending and processed | yes, cached | yes | 5 |
| Warden transfers | `resolveWardenBlockIds`, `listRoomTransferRequests` | yes, block scope and both queues | yes, cached | yes | 6 |
| Warden gate passes | `resolveWardenScopedStudentIds`, `listPendingGatePasses`, `listProcessedGatePasses`, `getGateOperationsSnapshot` | yes, blocks/rooms/allocations scope, queues, resident and pass counts | yes, cached | yes | 24 |
| Director dashboard | `getCommandCenterData` | yes, all 5 reads | yes | not cached in source; no view-state upsert after failure | 10 |
| Director attention | `resolveHodDepartmentId`, `listRiskFlags`, `listMyRiskFlagAssignments`, `getStudentRiskOverview` | yes, all 7 reads, HOD and director branches | yes, cached | yes | 20 |
| Director briefing | `getExecutiveBriefing` | yes, all 4 reads | yes | not cached in source; no "generated" write after failure | 9 |
| Placement dashboard | `getPlacementCellDashboard` | yes, all 8 reads | yes, cached | yes | 11 |

Every P0 failure test asserts four things: the call throws an `InternalOperationError`; the message does not contain the injected database text (`secret_internal_table`); `[internal] database/service call failed` was logged; and nothing was written to the cache (`redis.set` not called, store empty). Cached record and empty results are fetched twice to prove cache reuse with unchanged TTLs.

## 3. Tier 2 results

| Measure | Count |
|---|---:|
| Read functions discovered by the behavioral guard | 91 |
| Changed by D5 | 82 |
| Already handled failures before D5 (intentionally unchanged) | 9 |
| Covered by a dedicated case instead of discovery (`director/ask.answerQuestion`, every question) | 1 |
| Justified exclusions | 2 |
| Top-level functions changed in the diff, incl. private helpers | 95 |
| `assertRead` call sites added | 208 (8 of them opt-in, see §4) |

Already handled, unchanged: `director/attention.getRiskFlag`, `director/attention.listAssignableStaff`, `director/decisions.getDecision`, `director/decisions.listDelegateCandidates`, `director/decisions.listDecisionAuditTrail`, `director/forecast.listSavedScenarios`, `director/goals.listGoalOwnerCandidates`, `director/notifications.listMyNotifications`, `finance/integrations.discoverAccounts`. The guard still sweeps all nine.

Justified exclusions (both finance readiness, owner decision: leave unchanged):

- `finance/integrations.connectionCredentialPresent` calls `lib/finance/credentials.hasCredential`.
- `finance/integrations.mappingReadiness` calls `lib/finance/mapping.validateMappings`.

Both live in `lib/finance/*`, which D5 excludes as finance reconciliation. `validateMappings` is also the gate inside `activateConnection`, so changing its failure semantics changes a finance business decision. See §7 for the risk this leaves.

Group C (write-path lookups, auth, gate credential verification, enrollment, finance internals) is unchanged.

## 4. Special cases

**Notification recipient lookup** (`placement-cell/notifications.resolveRecipientUserIds`), verified in code and tests for all five audiences:

- Case A, lookup succeeds: notifications are inserted and the recipient count is returned.
- Case B, lookup succeeds with nobody: the existing `No recipients found for the selected audience.` error is unchanged.
- Case C, lookup fails: the action throws before any `notifications` insert or push. All 8 lookup reads are tested separately.

**Eligible-department lookup failure.** Before D5, a failed `placement_drive_departments` read gave `deptIds = []`, and the filter treats an empty list as "no department restriction". A failed read therefore sent the notification to eligible students in every department. It now throws. Removing that single check is caught by the tests (mutation M4).

**Offerings.** Only `listTeachableOfferings` and `getActiveSemesterId` changed. `loadOffering`, `assertCanRecordAttendance`, `canWriteOfferingRecords`, `resolveHodDepartmentIds` and `assertOfferingInReviewScope` are byte-identical to base. A successful empty read still gives `[]` / `null`; a failed read throws. Tested for teacher, HOD and admin, and the existing 46 `lib/offerings.test.ts` authority tests still pass.

**Four client loaders.** Director briefing, hostel, department performance and placement funnel no longer use `action().then(setState)`. They use the existing `useAsyncResource` + `StateView` (which renders `ErrorState` with Try again). Tests render each real page through loading, failure, retry, successful empty and data; the funnel is also tested with only its second read failing. The fields read by each page's empty predicate exist in the action's return. A new `feedback-contract` rule rejects a `.then(set…)` chain with no error path anywhere in shipped UI.

**View-state writes.** `getCommandCenterData` and `getExecutiveBriefing` check every read before their `upsert`, so a failed load never records the view as seen or the briefing as generated.

**Shared helpers with write callers.** `resolveAutoMetricValue` (goals) and `resolveAffectedSessions` (leave impact) take an opt-in flag; only `listGoals` and `previewLeaveImpact` pass it. `createGoal` and the post-approval substitution path keep their exact pre-D5 behavior.

**Write-path scope helpers.** `resolveWardenScopedStudentIds`, `resolveWardenBlockIds`, `resolveWardenScopedSubmitterIds`, `resolveStudentId` and `getOwnStudentRow` are also called by writes. In every caller, the old failed-read value (`[]` or null) already led to denial, and the throw happens before the scope check. Denial is preserved and no scope is widened. `security.securityContext` now shows an error instead of "not authorized" on a failed read; access is denied either way, and gate credential verification (`lib/gate-security/credential`) is untouched.

**Cache behavior.** `lib/cache.ts` is unchanged. `getCached` awaits the fetcher before `redis.set`, so a thrown read is never stored. A successful `[]` is stored and later returned as a hit. Proven by the P0 tests and by mutation M9.

## 5. Test results

| Check | Result |
|---|---|
| Focused D5 (5 files) | 299 / 299 passed: `s1-failed-reads` 132, `read-failure-contract` 94, `s1-client-loaders` 5, `feedback-contract` 22, `lib/offerings.test` 46 |
| Unit, full suite | 2278 / 2278 passed, 68 files |
| TypeScript `tsc --noEmit` | 0 errors |
| ESLint | 0 errors, 518 warnings; the changed files have 45 lint problems at base and 45 now (no new warnings) |
| Production build `next build` | passed |
| Worker / OpenNext `build:worker` | passed (`.open-next/worker.js` produced; not deployed) |
| No-dev-routes guard | passed |
| Playwright, full parallel (desktop + mobile 375) | 272 / 272 passed, 0 retries |
| Heavy axe test, isolated | 2 / 2 passed (12.4 s desktop, 12.5 s mobile) |
| Heavy axe test, inside full parallel run | passed (20.7 s desktop, 22.3 s mobile; budget 60 s) |
| axe (18 axe tests across the e2e specs) | 18 / 18 passed |
| Motion guard `motion-contract` + e2e `motion`, `page-motion` | 80 unit; 38 + 20 e2e, all passed |
| Primitive motion `primitive-motion` | 27 / 27 passed |
| Feedback guard `feedback-contract` + `feedback-components` + `m6-feedback` | 22 + 78 + 40, all passed; e2e `feedback` 28 passed |
| Auth `safe-redirect` + `authorization-surface` + e2e `auth-redirect` | 100 + 9 unit; 14 e2e, all passed |

Heavy axe test change: `test.setTimeout(60_000)` local to that one test, plus a comment. Scans, assertions and axe tags are unchanged. The global timeout and `retries: 0` are unchanged. Playwright runs with every local env key blanked and Supabase pointed at a closed loopback port (owner decision D3).

No failures occurred, so nothing needed classifying as baseline, D5, infrastructure, environment or pre-existing.

## 6. Adversarial verification

**Behavioral guard** (`tests/read-failure-contract.test.ts`). It discovers exported read-only action functions from source, runs each as the area role and as admin, first with all reads succeeding (both `rows` and `empty` fixtures), then fails read 1, read 2, and so on, one at a time. Each failure must throw, must not be a fixture `TypeError`, and must not carry the database text. A successful empty read must not throw a read failure; the only allowed baseline errors are pre-existing "not found" business messages. Total: 687 injected read failures, all caught. It does not ban `[]` returns.

**Source mutations.** Each mutation was applied to the real source, the D5 suites were run, and the file was restored. The working-tree diff hash was identical before and after.

| # | Mutation | Result |
|---|---|---|
| M1 | Drop one `assertRead` in a Tier 1 function (refunds pending) | caught, 2 failing |
| M2 | `if (error) return []` in `listTeachableOfferings` | caught, 2 failing |
| M3 | `return data ?? []` ignoring the error in a Tier 2 function (`listGates`) | caught, 1 failing |
| M4 | Eligible-department lookup unchecked (audience widening) | caught, 1 failing |
| M5 | Recipient lookup failure returns `[]` | caught, 2 failing |
| M6 | Command Center risk read unchecked | caught, 3 failing |
| M7 | Briefing snapshot read unchecked (view written after failure) | caught, 3 failing |
| M8 | `getActiveSemesterId` returns null on failure | caught, 2 failing |
| M9 | `getCached` stores a failed fetch as `[]` | caught, 49 failing |
| M10 | Legitimate empty queue turned into an error | caught, 3 failing |
| M11 | `assertRead` made a no-op | caught, 171 failing |
| M12 | Raw database message passed to the caller | caught, 171 failing |
| M13 | Client loader swallows a failure into empty data | caught, 1 failing |

13 of 13 mutations caught.

## 7. Unresolved business decisions (retained, not fixed)

1. **Goal creation baseline — D5 remaining business-rule debt.** If the metric read fails in `createGoal`, the goal is still created with an empty (null) baseline. Only `listGoals` fails loudly. Left unchanged by owner decision.
2. **Push / device-token lookup — best-effort delivery behavior.** After notification rows are saved, the `device_tokens` read and Expo push are best effort, as the code's own comment states. No existing contract makes the lookup mandatory. Left unchanged.
3. **Finance-readiness exclusions.** `hasCredential` and `validateMappings` still ignore read errors. Left unchanged by owner decision. **Risk to record:** `validateMappings` is the gate in `activateConnection` ("the last gate before money can move"). A failed `fees` or `payments` read finds no gaps and reports the connection as ready, so a failed read can let a VERIFIED connection become ACTIVE with incomplete mappings. This is a fail-open in a finance gate. It needs an owner / backend (D7) decision; it is outside D5.

Other retained debt: D11 `ActionResult` remains deferred; live-tenant browser validation is not claimed because the browser suite is isolated from real services.

## 8. D5 verdict

```text
D5 PASS — PROCEED TO S1 GATES 2–5
```

M7 remains blocked until the complete S1 gate (D5 plus Gates 2–5) passes. Nothing has been merged.

## Changed function inventory

| File | Function | Added checks |
|---|---|---:|
| `app/(portal)/admin/audit/actions.ts` | `listAuditLogs` | 1 |
| `app/(portal)/admin/courses/actions.ts` | `listCourses` | 1 |
| `app/(portal)/admin/users/actions.ts` | `listUsers` | 1 |
| `app/(portal)/admin/users/actions.ts` | `getStudentAcademicSummary` | 4 |
| `app/(portal)/director/ask/actions.ts` | `answerQuestion` | 5 |
| `app/(portal)/director/attention/actions.ts` | `resolveHodDepartmentId` | 1 |
| `app/(portal)/director/attention/actions.ts` | `listRiskFlags` | 2 |
| `app/(portal)/director/attention/actions.ts` | `listMyRiskFlagAssignments` | 1 |
| `app/(portal)/director/attention/actions.ts` | `getStudentRiskOverview` | 3 |
| `app/(portal)/director/briefing/actions.ts` | `getExecutiveBriefing` | 4 |
| `app/(portal)/director/dashboard/actions.ts` | `getDashboardStats` | 3 |
| `app/(portal)/director/dashboard/actions.ts` | `getCommandCenterData` | 5 |
| `app/(portal)/director/decisions/actions.ts` | `listDecisions` | 2 |
| `app/(portal)/director/departments/actions.ts` | `listEligibleHodCandidates` | 1 |
| `app/(portal)/director/departments/performance/actions.ts` | `resolveHodDepartmentId` | 1 |
| `app/(portal)/director/departments/performance/actions.ts` | `listDepartmentHealth` | 2 |
| `app/(portal)/director/departments/performance/actions.ts` | `getDepartmentDetail` | 4 |
| `app/(portal)/director/faculty/actions.ts` | `listFaculty` | 5 |
| `app/(portal)/director/forecast/actions.ts` | `getForecastBaseline` | 6 |
| `app/(portal)/director/goals/actions.ts` | `resolveAutoMetricValue` | 6 |
| `app/(portal)/director/goals/actions.ts` | `listGoals` | 0 |
| `app/(portal)/director/hostel/actions.ts` | `getHostelRollup` | 4 |
| `app/(portal)/director/placement-cell/actions.ts` | `listPlacementCellUsers` | 1 |
| `app/(portal)/director/placement-cell/actions.ts` | `listPlacementCellCandidates` | 1 |
| `app/(portal)/director/placement-cell/actions.ts` | `getPlacementOverview` | 5 |
| `app/(portal)/director/placements/actions.ts` | `listPlacements` | 1 |
| `app/(portal)/director/placements/funnel/actions.ts` | `getInstitutionPlacementFunnel` | 1 |
| `app/(portal)/director/placements/funnel/actions.ts` | `listDriveFunnels` | 2 |
| `app/(portal)/director/security/actions.ts` | `listSecurityPersonnel` | 4 |
| `app/(portal)/director/security/actions.ts` | `listUnauthorizedSecurityAccounts` | 2 |
| `app/(portal)/director/security/actions.ts` | `listGates` | 1 |
| `app/(portal)/director/security/actions.ts` | `listSecurityInstructions` | 1 |
| `app/(portal)/director/security/actions.ts` | `securityOverview` | 5 |
| `app/(portal)/director/security/actions.ts` | `listGateMovements` | 6 |
| `app/(portal)/director/security/actions.ts` | `listSecurityAuditEvents` | 2 |
| `app/(portal)/finance/disputes/actions.ts` | `listFinancialDisputes` | 1 |
| `app/(portal)/finance/exceptions/actions.ts` | `getFinanceExceptions` | 4 |
| `app/(portal)/finance/integrations/actions.ts` | `listConnections` | 1 |
| `app/(portal)/finance/integrations/actions.ts` | `integrationHealth` | 4 |
| `app/(portal)/finance/integrations/actions.ts` | `listSyncOperations` | 1 |
| `app/(portal)/finance/integrations/actions.ts` | `listMappings` | 1 |
| `app/(portal)/finance/integrations/actions.ts` | `listReconciliation` | 2 |
| `app/(portal)/finance/integrations/actions.ts` | `integrationAuditTrail` | 1 |
| `app/(portal)/finance/invoices/actions.ts` | `listInvoices` | 1 |
| `app/(portal)/finance/refunds/actions.ts` | `listRefundRequests` | 2 |
| `app/(portal)/finance/scholarships/actions.ts` | `listScholarships` | 1 |
| `app/(portal)/finance/transactions/actions.ts` | `listPayments` | 1 |
| `app/(portal)/finance/transactions/actions.ts` | `getFeeStats` | 1 |
| `app/(portal)/hod/approvals/actions.ts` | `listHodApprovals` | 4 |
| `app/(portal)/hod/approvals/actions.ts` | `resolveAffectedSessions` | 2 |
| `app/(portal)/hod/approvals/actions.ts` | `previewLeaveImpact` | 2 |
| `app/(portal)/hod/approvals/actions.ts` | `listCorrectionApprovals` | 6 |
| `app/(portal)/hod/faculty/actions.ts` | `listDepartmentFacultyWorkload` | 4 |
| `app/(portal)/hod/substitutions/actions.ts` | `resolveHodDepartmentId` | 1 |
| `app/(portal)/hod/substitutions/actions.ts` | `listSubstitutionNeeds` | 5 |
| `app/(portal)/hod/substitutions/actions.ts` | `listDepartmentTeachers` | 2 |
| `app/(portal)/placement-cell/companies/actions.ts` | `listCompanies` | 1 |
| `app/(portal)/placement-cell/dashboard/actions.ts` | `getPlacementCellDashboard` | 8 |
| `app/(portal)/placement-cell/drives/actions.ts` | `listDrives` | 1 |
| `app/(portal)/placement-cell/drives/actions.ts` | `listCompaniesForSelect` | 1 |
| `app/(portal)/placement-cell/drives/actions.ts` | `listActiveDrivesForSelect` | 1 |
| `app/(portal)/placement-cell/drives/actions.ts` | `listDepartmentsForSelect` | 1 |
| `app/(portal)/placement-cell/drives/actions.ts` | `listApplicants` | 2 |
| `app/(portal)/placement-cell/notifications/actions.ts` | `resolveRecipientUserIds` | 8 |
| `app/(portal)/placement-cell/notifications/actions.ts` | `listSentPlacementNotifications` | 1 |
| `app/(portal)/placement-cell/records/actions.ts` | `listStudentPlacementRecords` | 2 |
| `app/(portal)/placement-cell/reports/actions.ts` | `getPlacementReports` | 2 |
| `app/(portal)/security/actions.ts` | `securityContext` | 4 |
| `app/(portal)/security/actions.ts` | `securityTodayCounts` | 1 |
| `app/(portal)/student/fees/actions.ts` | `resolveStudentId` | 1 |
| `app/(portal)/student/fees/actions.ts` | `listMyRefundRequests` | 1 |
| `app/(portal)/student/fees/actions.ts` | `listMyDisputes` | 1 |
| `app/(portal)/student/gatepass/actions.ts` | `getMyGatePassMovements` | 1 |
| `app/(portal)/student/hostel/actions.ts` | `listMyRoomTransferRequests` | 2 |
| `app/(portal)/student/placements/actions.ts` | `getOwnStudentRow` | 1 |
| `app/(portal)/student/placements/actions.ts` | `listOpportunities` | 3 |
| `app/(portal)/student/placements/actions.ts` | `listMyApplications` | 1 |
| `app/(portal)/student/placements/actions.ts` | `getMyPlacementProfile` | 1 |
| `app/(portal)/student/placements/actions.ts` | `listMyPlacementNotifications` | 1 |
| `app/(portal)/super-admin/colleges/actions.ts` | `listColleges` | 1 |
| `app/(portal)/teacher/attendance/actions.ts` | `listMyCorrectionRequests` | 1 |
| `app/(portal)/warden/complaints/actions.ts` | `resolveWardenScopedSubmitterIds` | 1 |
| `app/(portal)/warden/complaints/actions.ts` | `listHostelComplaints` | 1 |
| `app/(portal)/warden/gatepasses/actions.ts` | `resolveWardenScopedStudentIds` | 3 |
| `app/(portal)/warden/gatepasses/actions.ts` | `listPendingGatePasses` | 1 |
| `app/(portal)/warden/gatepasses/actions.ts` | `listProcessedGatePasses` | 1 |
| `app/(portal)/warden/gatepasses/actions.ts` | `listGatesForOverride` | 1 |
| `app/(portal)/warden/gatepasses/actions.ts` | `listGatePassMovements` | 1 |
| `app/(portal)/warden/gatepasses/actions.ts` | `getGateOperationsSnapshot` | 2 |
| `app/(portal)/warden/rooms/actions.ts` | `listWardenRooms` | 2 |
| `app/(portal)/warden/transfers/actions.ts` | `resolveWardenBlockIds` | 1 |
| `app/(portal)/warden/transfers/actions.ts` | `listRoomTransferRequests` | 2 |
| `app/(portal)/warden/transfers/actions.ts` | `listAvailableRoomsForTransfer` | 1 |
| `lib/offerings.ts` | `listTeachableOfferings` | 1 |
| `lib/offerings.ts` | `getActiveSemesterId` | 1 |
