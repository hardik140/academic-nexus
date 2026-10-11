# FINAL S1 RELEASE GATE — POST-B1 RERUN

Completed 1 October 2026 (Asia/Kolkata). This report supersedes the previous blocked release decision in `FINAL_S1_RELEASE_GATE_REPORT.md`. That report and the B1 investigation report remain preserved as history.

## 1. Git and scope

Branch: `feat/frontend-s1-ux-stabilization`. HEAD and `main` both remain `a424d9aa3ad40ffd4af3c920e9ba41562c7a0857`. S1 remains uncommitted. The accumulated content diff is 79 tracked files, 650 insertions and 300 deletions. No dependency/lockfile, migration/schema, or API implementation changes are present.

Comparison against the previous gate's SHA-256 inventory confirms that the only new code-content change is the accepted **B1 test-observation correction** in `e2e/dialog.spec.ts`. The two added documents since that inventory are the previous final-gate report and `B1_INVESTIGATION_REPORT.md`.

There is also a line-ending-only difference in `app/globals.css` left by the B1 temporary mutations: CRLF became LF. Git's normalized blob hash is identical to HEAD (`750c8018c6fdc100f1194e60d40856a56399e9c3`), its content diff is empty, and reconstructing CRLF in memory reproduces the previous SHA-256 exactly. No CSS content or behavior changed. This gate did not normalize or edit it.

All 731 tracked/nonignored files in this rerun's initial inventory remained byte-identical after the tests and builds. The only final addition is this report. `git diff --check` passes. Generated build/test evidence is ignored; there are no unexpected source additions or deletions.

No implementation, assertion, timeout, retry, worker count, project, exemption, dependency, or configuration was changed during this rerun.

## 2. Final matrix

| Area | Result | Evidence |
|---|---|---|
| Git/tree | VERIFIED | Correct branch; unchanged HEAD/main; 731-file SHA-256 comparison; clean whitespace check |
| B1 | VERIFIED | Exact mobile test passed; focused dialog suite 44/44; full-suite B1 cases passed in both projects |
| D5 | VERIFIED | 299/299 relevant unit cases: 132 failed-read, 94 read-contract, 5 client-loader, 22 feedback-contract, 46 offerings |
| Gate 2 INR | VERIFIED | 14 currency-contract + 30 web formatter + 6 mobile formatter tests; accepted display diff reviewed |
| Gate 3 IST | VERIFIED | 9/9 UTC-process tests; seven accepted UI corrections preserved |
| Gate 4 DataTable | VERIFIED | 5/5 unit and 26/26 browser cases, including keyboard sorting, overflow, resize and axe |
| Gate 5 Sidebar | VERIFIED | 69/69 unit and 30/30 browser cases; 75 configured links and all seven widths |
| M6 | VERIFIED | 78 component + 40 M6 + 22 contract unit cases; 28 feedback + 42 M6 + 18 pending browser cases |
| Auth security | VERIFIED | 100 safe-redirect + 9 authorization-surface unit cases; 14/14 auth browser cases |
| Motion | VERIFIED | 80 motion-contract + 27 primitive-motion unit cases; 38 motion + 20 page-motion + 44 dialog + 42 shell browser cases |
| Accessibility | VERIFIED | All 26 axe cases passed; no new exemptions or skipped tests; keyboard/focus/navigation-name coverage passed |
| TypeScript | VERIFIED | `npx tsc --noEmit`: 0 errors; both builds also passed their TypeScript stages |
| ESLint | VERIFIED | 0 errors, 518 warnings; warning count unchanged |
| Production build | VERIFIED | Standard `npm run build` passed |
| Worker build | VERIFIED | Standard `npm run build:worker` passed; `.open-next/worker.js` exists |
| No-dev-routes | VERIFIED | Guard passed after both production and Worker builds |
| Full Playwright | VERIFIED | Fresh normal command: 328/328; four default workers; 0 failed/skipped/flaky/retried |
| Security/business integrity | VERIFIED | Fresh query/signature/write/authority audits; accumulated diff review; protected implementation paths unchanged |
| D7 preservation | VERIFIED | Preservation only: excluded finance-readiness and backend date debt remain outstanding and untouched |

## 3. Fresh validation

| Command/check | Result |
|---|---|
| Full unfiltered `npm test` (JSON reporting only) | 2375/2375, 72 files; 0 failed or skipped |
| Mobile `npm run test:ci` (existing script, no test filter) | 10/10, 2 files: 6 formatter and 4 API tests |
| Exact B1 mobile command | 1/1 passed; test 5.4 seconds, run 1.8 minutes including startup |
| `npx playwright test e2e/dialog.spec.ts e2e/motion.spec.ts e2e/page-motion.spec.ts e2e/shell.spec.ts` | 144/144 in 4.4 minutes, normal four workers |
| `npm run test:e2e` | 328/328 in 9.6 minutes, normal four workers |
| `npx tsc --noEmit` | PASS, 0 errors |
| Full `npm run lint` (JSON reporting only) | PASS, 0 errors / 518 warnings |
| `npm run build` | PASS |
| `npm run verify:no-dev-routes` after production build | PASS |
| `npm run build:worker` | PASS, including its normal Next build and OpenNext bundling |
| `npm run verify:no-dev-routes` after Worker build | PASS |

The exact B1 command was:

```text
npx playwright test e2e/dialog.spec.ts -g "enters in 200ms ease-emphasized and exits in 150ms ease-in-out, animating only opacity, transform, display and overlay" --project=chromium-mobile-375
```

The first attempt failed **before any test ran**: the local Next server did not become ready within the existing 240000ms `webServer` timeout. The full unit suite and lint were concurrently running. A read-only host check found approximately 1.1 GB free physical memory, and a later Next startup reported an 856ms slow-filesystem probe. Resource contention is consistent with this evidence; it is not established as the sole cause.

After unit/lint completed, the exact same B1 command passed within the unchanged startup budget. The complete targeted matrix then passed, followed by the complete E2E command on its first full-suite attempt in this gate. No browser test failed, was retried, or was labeled flaky. The startup failure is retained in `b1-focused.log`; it is not rewritten as a passing attempt. There was no lower-worker override, timeout increase, cache deletion, or source/config workaround.

The standard full E2E HTML report was parsed after the run: total 328, expected 328, unexpected 0, flaky 0, skipped 0. Logs confirm four workers and no retries. Both projects passed all 164 cases each. The historical B1 328/328 run was not substituted for this fresh evidence.

OpenNext emitted its platform/compatibility and experimental Node.js middleware advisories, then completed successfully. The E2E server also emitted a smooth-scroll advisory. These warnings prompted no unrelated changes or test exemptions.

## 4. Contract and integrity review

B1 continues to assert 200ms enter transitions, exact enter easing, permitted properties, 150ms exit transitions and exact exit easing. It captures dialog/backdrop styles in the existing browser-side `open` mutation callback, verifies the node is connected, and separately verifies unmount. Native dialog lifecycle, retained inert exit content, focus restoration, console guards and reduced-motion coverage passed. Production Modal, NativeDialog and motion rules have no B1 content change.

Gate 2 retains canonical web `formatMoney`, INR/en-IN grouping, the mobile INR formatter and unchanged financial calculations. The accepted director impact displays use the same financial-impact field through the canonical formatter. Placement LPA/lakh notation remains unchanged. Source guards continue to reject unintended USD/duplicate currency formatters.

Gate 3 retains the teacher timetable/dashboard, attendance default, student schedule, hostel menu, finance sync and reconciliation corrections. UI dates use Asia/Kolkata; excluded backend date rules remain outside this change.

DataTable retains native `type="button"` sort controls, column scope, correct `aria-sort`, single keyboard activation, ascending-on-column-switch behavior and the original sort/filter/page/server-callback logic. Named overflow regions become focusable only while overflowing, respond to resizing, and avoid duplicate focus stops and document overflow.

Sidebar coverage retains all 75 configured links across ten roles, visible or screen-reader label text in every state, decorative hidden icons, exact/descendant path matching with boundary protection and a sole current section. The configured Placements destination remains `/director/placements/funnel`. Browser checks cover 375, 639, 640, 768, 1023, 1024 and 1280px, Enter/Shift+Tab, Escape, focus return and background inertness.

D5/M6 coverage verifies failed-read errors versus successful empty states, P0 queues, persistent consequential feedback, loading/error/empty states, confirmations, pending behavior, session expiry, safe login-next values, validation and request-decision recovery. Auth tests include same-origin paths and descendants, protocol-relative/absolute URLs, backslashes, malformed paths, login/API/auth exclusions and permitted auth links.

The accumulated S1 diff intentionally contains **45 server-action files changed by D5**. It does not contain zero server-action changes. Fresh TypeScript AST comparisons against `main` confirm:

- Query method argument sequences match in all 45 action files plus `lib/offerings.ts` (46/46), including filters, selection, ordering and write arguments.
- Exported action parameter/return-type signatures are unchanged.
- 66 of 68 write-containing exported functions are unchanged after comment/format normalization. The accepted exceptions, `getExecutiveBriefing` and `getCommandCenterData`, assert read success before their existing view-state upserts; write payloads remain unchanged.
- Offerings permission functions, finance-readiness helpers and the selected backend Date/UTC expressions match the baseline.

RLS, RBAC, tenant isolation, route protection, auth implementation, gate-credential implementation, API/cron implementation, finance internals, cache implementation/keys/TTLs, dependencies, lockfiles and schema/migrations have no unintended content changes. D5 intentionally prevents failed reads from becoming successful empty results or cached empty successes. Its error propagation is preserved, including scope failures remaining denials.

## 5. Outstanding exclusions

```text
D7 / Backend Finance Readiness

validateMappings → activateConnection

failed finance read may appear ready

OUTSTANDING — NOT MODIFIED
```

This risk is not fixed or certified as safe by this gate. The matrix verifies preservation only. It remains an explicitly accepted exclusion from S1 rather than a new release blocker.

D7 backend date/business-rule debt also remains outstanding: effective overdue-fee status, scholarship awarded date, placement date, transfer vacated date, finance pipeline sync date, and guard/director security today windows. Accepted D5 exclusions and older date-display migration remain unchanged.

## 6. Evidence and release decision

Fresh results, command logs, file hashes and audits are retained under `playwright/.cache/post-b1/`: `baseline.json`, `unit.json`, `mobile-unit.json`, `lint.json`, `browser-report.json`, browser/build/route-guard logs, `security-audit.json`, `authority-debt-audit.json`, and final Git/scope checks. Previous blocked-gate evidence remains under `playwright/.cache/final-s1/`.

No remaining P0/P1 S1 release blocker was found. All required S1 gates are green.

```text
S1 FINAL RELEASE GATE — PASS

S1 is ready for the owner-controlled commit/review handoff.

No commit performed.
No merge performed.
No push performed.
No deployment performed.

M7 remains blocked until separately authorized.

D7 backend finance-readiness debt remains outstanding.
D7 backend date/business-rule debt remains outstanding.
```

The next step is owner authorization for commit/review. Work stops with this report.
