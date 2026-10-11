# B1 INVESTIGATION REPORT

## 1. Reproduction

Exact command:

```text
npx playwright test e2e/dialog.spec.ts -g "enters in 200ms ease-emphasized and exits in 150ms ease-in-out, animating only opacity, transform, display and overlay" --project=chromium-mobile-375
```

Result: the first isolated run passed in 5.7 seconds (22.2 seconds including server startup). An unchanged diagnostic repetition using the repository's default worker behavior (`--repeat-each=12`, four workers) reproduced the release-gate failure three times: 9 passed, 3 failed. Every failure was the same assertion, then at `e2e/dialog.spec.ts:405`: expected `cubic-bezier(0.4, 0, 0.2, 1)`, received `""`.

Reproducibility: timing-dependent. It did not reproduce in the single isolated run, but reproduced reliably enough under concurrent load to confirm that the original observation was unsafe.

## 2. Root Cause

Test observation race.

The original test correctly captured the exit transition objects when the dialog's `open` attribute changed, then made a separate Playwright locator RPC to read the closed dialog's computed easing. `NativeDialog` intentionally calls `HTMLDialogElement.close()`, obtains the dialog's exit animations, and unmounts after those animations settle. The exit lifetime is 150ms.

Under load, the separate computed-style RPC could begin while the element was attached but execute after the 150ms exit and React unmount. `getComputedStyle` on that detached element returns empty transition fields, producing the observed empty easing. The release-gate trace recorded 194.339ms for that RPC and its final snapshot contained no dialog. The focused stress run reproduced the same empty value in 3/12 cases.

The application behavior is correct: the dialog remains connected for the exit transition and is intentionally removed when it completes. No source regression or browser/runtime defect was found.

## 3. Evidence

The lifecycle is:

```text
open prop true
→ NativeDialog mounts
→ useLayoutEffect calls showModal()
→ 200ms opacity/transform enter
→ Close asks the caller to set open=false
→ useLayoutEffect calls dialog.close()
→ open attribute changes and 150ms exit transitions start
→ Promise.allSettled(exit animations)
→ shown becomes null and React unmounts the dialog
→ native focus restoration remains intact
```

The original test timeline was:

1. Open the gallery and click the trigger.
2. A `MutationObserver` sees the dialog's `open` attribute change and captures enter transition objects.
3. Read the open computed style and verify properties and enter easing.
4. Click Close; the same observer captures exit transition objects and their 150ms duration.
5. Return across the Playwright boundary.
6. Start a second locator/evaluate RPC to read closed computed easing.
7. On slow/concurrent runs, the dialog unmounts before step 6 finishes.

The corrected observation captures computed dialog and `::backdrop` style in step 4, inside the existing browser-side mutation callback. It asserts that the dialog is still connected, checks the exact exit properties, exact 150ms duration and exact ease-in-out value, then separately waits for the dialog count to reach zero. This checks both the transition contract and the intended unmount.

The corrected test passed 12/12 repetitions with four default workers, the same diagnostic shape that failed 3/12 before the correction.

Adversarial temporary CSS mutations proved that the test still rejects:

- wrong enter duration (250ms);
- wrong exit duration (175ms);
- wrong enter easing (`ease-out`);
- wrong exit easing (`ease-out`);
- an unauthorized `color` transition;
- missing `transform`;
- missing `opacity`;
- missing `display` and `overlay`.

Each mutation failed at the relevant exact assertion. Every mutation was reverted before validation. Reduced-motion, console-error and unmount coverage remained active in the unchanged surrounding dialog/motion suites.

## 4. Accepted M4 Comparison

Accepted M4 reference: `3f479d2` (implementation commit history includes `cbc21be`, “Motion M4: native dialog Modal”).

Before this correction, `e2e/dialog.spec.ts` was byte-identical to the accepted M4 version: both M4 and `HEAD` hashed to `1f671274ef5d17906a6524b1cffd9d52f98ff865`.

The `motion-dialog` rules are behaviorally and textually unchanged from M4: closed state is `150ms ease-in-out`; open state is `200ms ease-emphasized`; allowed properties are opacity, transform, display and overlay; `allow-discrete` retains the node through exit. Later additions elsewhere in `app/globals.css` do not change this utility.

M5 extracted M4's inline native-dialog lifecycle from `Modal` into `components/ui/native-dialog.tsx`. The relevant behavior is preserved: `showModal()` on open, `close()` when the prop becomes false, exit animations collected from the dialog, unmount after they settle, and cancellation of that unmount if reopened. The current source did not introduce B1.

## 5. Source Changes

None.

`components/ui/modal.tsx`, `components/ui/native-dialog.tsx` and `app/globals.css` were not changed. All temporary mutation changes were reverted. D7 finance-readiness and backend date/business-rule debt remain untouched. M7 was not started.

## 6. Test Changes

One file changed: `e2e/dialog.spec.ts`.

This is a **B1 test-observation correction**. `clickAndReadTransitions` now returns the connected state and computed dialog/backdrop transition style from the same browser-side callback that observes the `open` change. The test checks those values before the intentional unmount and then checks that unmount actually occurs.

No assertion was weakened. No sleep, retry, timeout, skip, project exclusion, worker override or Playwright configuration change was added.

## 7. Validation

| Check | Result |
|---|---|
| Exact focused reproduction before correction | PASS once; non-deterministic in isolation |
| Diagnostic repeat before correction | 9 passed, 3 failed; same empty easing |
| Corrected diagnostic repeat, default four workers | 12/12 passed |
| Adversarial mutation checks | All eight mutation categories rejected; all mutations reverted |
| `motion-contract.test.ts` + `primitive-motion.test.ts` | 107/107 passed |
| TypeScript (`npx tsc --noEmit`) | PASS, 0 errors |
| Dialog + motion + page-motion + shell browser suites | 144/144 passed across desktop and mobile |
| Dialog/open-motion/drawer axe coverage | PASS |
| Reduced-motion and console-error coverage | PASS |
| Full unchanged `npm run test:e2e` | 328/328 passed in 11.3 minutes; four workers; 0 failed, skipped, flaky or retried |
| `git diff --check` | PASS |

The final full-suite result is B1 resolution evidence only. It is not a Final S1 Release Gate PASS.

## 8. Remaining S1 Blockers

B1 has no remaining blocker after the test-observation correction and required validation. The owner-controlled Final S1 Release Gate must still be rerun before S1 can be declared PASS or BLOCKED.

Known debt remains unchanged:

```text
D7 / Backend Finance Readiness
validateMappings → activateConnection
failed finance read may appear ready
OUTSTANDING — NOT MODIFIED
```

Documented D7 backend date/business-rule debt remains outstanding. M7 remains blocked.

## 9. Verdict

```text
B1 — RESOLVED; READY FOR FINAL S1 RELEASE GATE RERUN
```

No commit, merge, push or deployment was performed.
