# S1 Gate 4 Report — DataTable Accessibility

Validated 2026-09-30. Gate 4 passes; all changes remain uncommitted.

## 1. Git state and scope

- Branch: `feat/frontend-s1-ux-stabilization`.
- HEAD and integration base: `a424d9aa3ad40ffd4af3c920e9ba41562c7a0857` (M6 merge).
- Final complete S1 tree: 77 modified tracked files and 12 untracked files, including the prior gates. Gate 4 adds two tracked modifications and three new files. `git diff --check` passes.
- All S1 work remains uncommitted. No merge, commit, deployment, or change to `main`.
- Gate 4 changes: `components/ui/data-table.tsx`, `e2e/a11y.spec.ts`, new `tests/data-table-accessibility.test.ts`, new `e2e/data-table.spec.ts`, and this report.
- Before editing, checked status, last commit, diff stat/check, existing component/tests, gallery, motion contract and consumers. Read the installed Next.js client-component guidance.
- SHA-256 snapshot covers 722 pre-existing tracked/untracked nonignored files. Only the shared DataTable and axe spec differ from that snapshot; D5, Gate 2 and Gate 3 source and reports remain byte-identical.

## 2. Sortable header audit

The existing contract was initially unsorted, then ascending ↔ descending; selecting a different column starts ascending and resets the page. That algorithm, filtering, pagination and server query callbacks are unchanged.

Sortable headers now contain native named `button type="button"` controls. `scope="col"` and `aria-sort` stay on the `th`: `none` on inactive sortable columns, `ascending`/`descending` on the active column. Non-sortable headers have neither a control nor sort state. Direction arrows are decorative (`aria-hidden`); state is independently exposed by `aria-sort`. Native button behavior supplies Enter/Space without custom key handlers. An empty positioned pseudo-element preserves the original whole-header mouse target, including cell padding, without changing layout.

All controls inherit the existing focus tokens. No row/sort/layout/scroll animation or runtime dependency was added. Existing spacing, typography, card and pagination structure remain in place.

The following production inventory comes from inspecting the actual JSX column definitions. Keyboard/state/name support is inherited from the shared component; browser verification uses its real development gallery instances with fictional data, not authenticated production accounts.

| Table/Component | Sortable columns | Keyboard | aria-sort | Accessible name |
|---|---|---|---|---|
| Admin audit | 1: Timestamp | Native button | none/ascending/descending | Sort by Timestamp |
| Admin courses | 4: Code, Course Name, Credits, Sem | Native button | Same | Sort by each header |
| Admin departments | 2: Department, Code | Native button | Same | Sort by each header |
| Admin hostel | 1: Block | Native button | Same | Sort by Block |
| Admin users | 3: Name, Email, Role | Native button | Same | Sort by each header |
| Director faculty | 1: Name | Native button | Same | Sort by Name |
| Director placements | 2: Company, Package | Native button | Same | Sort by each header |
| Finance invoices | 3: Type, Amount, Due Date | Native button | Same | Sort by each header |
| Finance scholarships | 2: Scholarship, Amount | Native button | Same | Sort by each header |
| Finance transactions: fees | 2: Amount, Due Date | Native button | Same | Sort by each header |
| Finance transactions: payments | 2: Amount, Date | Native button | Same | Sort by each header |
| Placement companies | 2: Company, Industry | Native button | Same | Sort by each header |
| Placement drive applicants | 0 | No sort tab stops | Absent | Not applicable |
| Placement drives | 3: Role, Package, Deadline | Native button | Same | Sort by each header |
| Placement student records | 2: Enrollment No., Year | Native button | Same | Sort by each header |
| Super-admin colleges | 2: Name, Code | Native button | Same | Sort by each header |
| Warden complaints | 1: Complaint | Native button | Same | Sort by Complaint |
| Warden gatepass history | 2: Date, Destination | Native button | Same | Sort by each header |
| Warden rooms | 4: Block, Room #, Category, Occupancy | Native button | Same | Sort by each header |
| Gallery client/empty/server-loading tables | 3 each: Enrollment, Student, Amount | Actual browser tests | All three states tested | Exact names tested |
| Gallery feedback table | 0 | No sort tab stops | Absent | Not applicable |

No gallery modification was necessary.

## 3. Scroll-region audit

One existing scroll wrapper becomes a named region with `tabIndex=0` only when `scrollWidth > clientWidth`; otherwise `tabIndex=-1` prevents an unnecessary stop, including browser-provided scroll-container tab stops. `ResizeObserver` observes both wrapper and table, responds to viewport/content size changes, and disconnects on unmount. The wrapper's existing focus outline is inset by its token width so the card does not clip it. Neither observation nor focus changes layout.

Both configured browser projects produced identical measurements for the gallery's client table:

| Viewport px | Region client px | Table scroll px | Overflow | Wrapper tabIndex | Keyboard result |
|---:|---:|---:|---|---:|---|
| 375 | 325 | 588 | Yes | 0 | Tab reaches named region; token outline visible; ArrowRight scrolls; sortable buttons reachable |
| 639 | 589 | 589 | No | -1 | Tab goes directly to first sortable button |
| 640 | 590 | 590 | No | -1 | Same |
| 768 | 718 | 718 | No | -1 | Same |
| 1023 | 973 | 973 | No | -1 | Same |
| 1024 | 974 | 974 | No | -1 | Same |
| 1280 | 1230 | 1230 | No | -1 | Same |

At every width, the page itself has no horizontal overflow and there is no nested focusable scroll wrapper. Resizing 375 → 1280 → 375 removes and restores the wrapper tab stop. Wider tables elsewhere still receive it if their measured content actually overflows. Focus screenshots at 375/1280 were inspected; the original table styling and token focus outline are retained.

## 4. Accessibility and adversarial coverage

- Five focused SSR/source tests exercise the actual production component in client/server mode, native names/semantics, non-sortable headers, initial tab behavior and absence of custom key handlers/new motion.
- Browser coverage checks Tab, mouse clicks in header padding, Enter, Space, repeated activation, exact row order, all sort states, switching columns, decorative arrows, non-sortable columns, focus tokens, all seven widths, arrow-key horizontal scrolling, absence of page overflow/duplicate wrappers, resize in both directions and server-loading sorting.
- Targeted axe scans inspect all gallery DataTables. The previous gallery allowance for up to three `scrollable-region-focusable` violations is removed; the page-wide axe test now permits zero violations.
- Focused browser run: 30/30 passed in 2.1 minutes, zero retries. This includes 26 DataTable cases and four page-wide axe scans. Both projects passed every keyboard/resize/width assertion, targeted DataTable axe and zero-debt gallery axe.

## 5. Regression results

| Check | Result |
|---|---|
| D5 focused subset | 299/299 passed (132 failed reads + 94 read contract + 5 client loaders + 22 feedback contract + 46 offerings) |
| Gate 2 currency | 14/14 contract tests and 30/30 web formatter tests passed; mobile files remain byte-identical to the validated Gate 2 state |
| Gate 3 IST today | 9/9 passed |
| Full unit suite | 2306/2306 passed, 71 files |
| Gate 4 unit tests | 5/5 passed |
| TypeScript | 0 errors after clearing malformed generated dev types |
| ESLint, full | 0 errors, 518 existing warnings |
| ESLint, final Gate 4 files | 0 errors, 1 existing DataTable any-type warning |
| Motion contract / primitive motion | 80/80 and 27/27 unit; 38/38 motion and 20/20 page-motion browser tests passed |
| Feedback guard/components/M6 | 22/22 + 78/78 + 40/40 unit; 28/28 feedback, 42/42 M6 and 18/18 pending browser tests passed |
| Auth safe-redirect/authorization-surface | 100/100 + 9/9 unit; 14/14 auth-redirect browser tests passed |
| Production / Worker / no-dev-routes | All passed; standard Worker build produced `.open-next/worker.js`; guard passed after both builds |
| Playwright, complete | 298/298 passed in 10.7 minutes: 149 desktop + 149 mobile; two workers, fully parallel enabled, 0 retries / skipped / flaky |
| axe, complete | 20/20 passed, including both targeted DataTable scans and both zero-debt gallery scans |
| Dialog / shell regressions | 44/44 and 42/42 passed in the complete rerun |
| Focused browser | 30/30 passed |

Logs and baseline hashes are retained under ignored `playwright/.cache/gate4/`.

Validation environment notes:

- The first focused Vitest startup was denied creation of its local API token in the sandbox. The same focused command outside the sandbox passed 72/72 tests.
- An initial TypeScript run encountered malformed stale `.next/dev/types` generated files. The generated development cache was cleared after stopping the test server; no application source or configuration was changed to work around this.
- Two initial browser launches were stopped during stalled server startup before tests ran. A direct local `/login` probe timed out; Next.js reported a 2190 ms filesystem benchmark. A subsequent fresh-cache launch reached the unchanged 240,000 ms server-start limit before any tests ran. After completing the builds, the identical browser tests passed: Next reported Ready in 1205 ms and a 234 ms filesystem benchmark. Test retries and timeout configuration remain unchanged.

- First complete browser run: 296/298 passed, 0 retries. All 26 DataTable and 20 axe tests passed. A desktop toast test failed at navigation with Chromium `ERR_NO_BUFFER_SPACE` before its assertions. A mobile dialog-motion test timed out reading the closed dialog after its exit; the trace shows a 382 ms close RPC followed by lookup after the 150 ms exit/unmount. The dialog implementation and test are byte-identical to baseline. Both scenarios then passed unchanged in both projects with one worker (4/4). The complete two-worker rerun passed 298/298 under lower resource pressure; assertions, global/local timeout budgets and retries remain unchanged. First-run JSON and failure traces are retained in the ignored gate cache.

- Worker invocation note: an attempted `build:worker -- --skipNextBuild` failed because the ordinary production output lacked `middleware.js.nft.json`. The standard `npm run build:worker` then performed its own traced Next.js build and completed successfully. No source/config workaround was made.

## 6. Security and business integrity

The Gate 4 delta changes no Supabase query, schema, RLS, RBAC, tenant isolation, server action, finance calculation, authentication, attendance/marks authorization, gate security, API or cache behavior. No dependency or lockfile changed. Hash comparison protects all previous S1 work, not merely files outside the Git diff.

## 7. Remaining S1 debt

```text
D7 / Backend Finance Readiness
validateMappings → activateConnection
failed finance read may appear ready
OUTSTANDING — NOT MODIFIED
```

Other previously documented D7 backend date/business-rule debt and D5 exclusions remain unchanged. Gate 5 sidebar accessibility has not started. M7 remains blocked.

## 8. Verdict

```text
S1 GATE 4 PASS — PROCEED TO GATE 5
```

Gate 5 has not started. M7 remains blocked. No merge, commit or deployment was performed.
