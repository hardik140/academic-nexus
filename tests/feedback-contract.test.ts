import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Feedback contract guard (M6.1, extended for the rest of M6). A static scan
 * that keeps the feedback rules from eroding as pages change:
 *
 *   • feedback never dismisses itself: no timer in any feedback component,
 *     and timers anywhere else only where each is listed below with its job;
 *   • every message has a live region that existed before it: Alert and
 *     ErrorAlert are always rendered, only their content is conditional;
 *   • errors are announced: no hand-made banner divs; error Alerts are
 *     role=alert; no raw `e.message` reaches the screen;
 *   • a failed read is never shown as an empty one: no read discards its
 *     error, and every hand-written loader catches;
 *   • an empty state only ever follows a successful load: EmptyState is
 *     rendered by StateView, never directly by a page;
 *   • errors are not toasts: nothing calls toast.error, and the toast API
 *     has no error method;
 *   • pending work is exposed: a button whose label says it is working is
 *     aria-busy, and so is <main> while a navigation is pending;
 *   • loading is not announced passively: the navigation marker is no live
 *     region, and neither is the data table's loading row;
 *   • the toast and the navigation marker use only the motion they are allowed.
 *
 * The only files exempt are the owner-decision D5 exclusions, listed by name:
 * auth fail-closed paths and gate credential verification.
 *
 * Markup and state selection are unit-tested in
 * tests/feedback-components.test.ts and tests/m6-feedback.test.ts; browser
 * behaviour in e2e/feedback.spec.ts, e2e/m6.spec.ts and e2e/pending.spec.ts.
 */

const FEEDBACK_COMPONENTS = [
  "components/ui/alert.tsx",
  "components/ui/loading-state.tsx",
  "components/ui/empty-state.tsx",
  "components/ui/error-state.tsx",
  "components/ui/state-view.tsx",
  "components/ui/error-alert.tsx",
  "components/ui/sign-in-again.tsx",
];

/** Owner decision D5: left as they are, on purpose. */
const D5_EXCLUSIONS = {
  // Auth fail-closed paths: a failed read signs the user out or refuses.
  authFailClosed: ["app/(portal)/layout.tsx", "app/page.tsx", "app/auth/accept-invite/page.tsx"],
  // Gate credential verification (decision D9).
  gateCredential: ["app/(portal)/security/scanner/page.tsx", "app/(portal)/security/scanner/scanner-client.tsx"],
};

const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|jsx?)$/.test(entry) ? [path.replace(/\\/g, "/")] : [];
  });
}

const APPLICATION = ["app", "components", "hooks", "lib"].flatMap(sourceFiles);
/** What users see: everything but the development-only gallery and harness. */
const SHIPPED_UI = APPLICATION.filter((f) => /\.tsx$/.test(f) && !f.startsWith("app/dev/"));

// Comments explain the rules in prose ("never dismisses itself", "toast.error"),
// so the rules look at code only.
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/** `file: match` for each match of `pattern` in each file's code. */
function offenders(files: string[], pattern: RegExp): string[] {
  return files.flatMap((f) => [...code(read(f)).matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"))].map((m) => `${f}: ${m[0].replace(/\s+/g, " ").slice(0, 120)}`));
}

describe("feedback contract", () => {
  it("scans the intended files", () => {
    for (const file of FEEDBACK_COMPONENTS) expect(APPLICATION).toContain(file);
    for (const file of [...D5_EXCLUSIONS.authFailClosed, ...D5_EXCLUSIONS.gateCredential]) expect(APPLICATION).toContain(file);
    expect(APPLICATION).toContain("app/dev/gallery/demos.tsx");
    expect(SHIPPED_UI.length).toBeGreaterThan(100);
  });

  // ─── Nothing dismisses itself ──────────────────────────────────────────

  it("no feedback component sets a timer: nothing dismisses itself", () => {
    for (const file of FEEDBACK_COMPONENTS) {
      expect(code(read(file)), file).not.toMatch(/\b(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback)\s*\(/);
    }
  });

  it("timers in shipped UI are exactly these, each with a job that is not dismissing a message", () => {
    const TIMERS = [
      // The camera's frame loop (D5: gate credential verification, untouched).
      "app/(portal)/security/scanner/scanner-client.tsx: requestAnimationFrame(",
      "app/(portal)/security/scanner/scanner-client.tsx: requestAnimationFrame(",
      "components/portal/portal-shell.tsx: setTimeout(", // the navigation marker's 150ms show delay
      "components/ui/confirmation-dialog.tsx: setTimeout(", // ends the focus-return watch
      "components/ui/data-table.tsx: setTimeout(", // debounces the search box
      "components/ui/toast.tsx: setInterval(", // the toast clock: at least 6s, paused while hovered, focused, hidden or under a dialog
      "components/ui/toast.tsx: requestAnimationFrame(", // after a user's dismiss, focus the next toast
    ];
    expect(offenders(SHIPPED_UI, /\b(?:setTimeout|setInterval)\s*\(|\brequestAnimationFrame\s*\(/).map((o) => o.replace("window.", ""))).toEqual(TIMERS);
  });

  // ─── Every message has a live region first ─────────────────────────────

  it("Alert and ErrorAlert are always rendered: only their content is conditional", () => {
    // `{cond && <Alert`, `{cond && (\n <Alert`, `cond ? <Alert`, `: <ErrorAlert`
    expect(offenders(SHIPPED_UI, /(?:&&|\?|:)\s*\(?\s*<(?:Alert|ErrorAlert)\b/)).toEqual([]);
  });

  it("an error Alert is role=alert and every other tone role=status", () => {
    expect(code(read("components/ui/alert.tsx"))).toContain('role={tone === "error" ? "alert" : "status"}');
  });

  it("ErrorAlert is an error Alert; ErrorState is role=alert", () => {
    expect(code(read("components/ui/error-alert.tsx"))).toMatch(/<Alert\s+tone="error"/);
    expect(code(read("components/ui/error-state.tsx"))).toContain('role="alert"');
  });

  // ─── Errors are announced, and say nothing internal ────────────────────

  it("no hand-made feedback banners outside the D5 exclusions", () => {
    const banners = offenders(SHIPPED_UI, /bg-(?:error|success|warning|info)\/10[^"`]*border[^"`]*text-(?:error|success|warning|info)/);
    const files = [...new Set(banners.map((b) => b.split(": ")[0]))];
    expect(files).toEqual(D5_EXCLUSIONS.gateCredential);
  });

  it("no raw error message reaches the screen", () => {
    expect(offenders(SHIPPED_UI, /\be instanceof Error \? e\.message\b/)).toEqual([]);
    expect(offenders(SHIPPED_UI, /\{\s*(?:e|err|error)\.message\s*\}/)).toEqual([]);
  });

  it("the error state components print no error message", () => {
    // (ErrorAlert prints a FeedbackError's message: toFeedbackError() has
    // already made it safe — see tests/m6-feedback.test.ts.)
    for (const file of ["components/ui/error-state.tsx", "components/ui/state-view.tsx", "app/(portal)/error.tsx", "app/global-error.tsx"]) {
      expect(code(read(file)), file).not.toMatch(/\.message\b|\.stack\b|String\(\s*(?:state\.)?error|JSON\.stringify/);
    }
  });

  it("the route-level error pages use ErrorState with a way to recover", () => {
    for (const file of ["app/(portal)/error.tsx", "app/global-error.tsx"]) {
      const source = code(read(file));
      expect(source, file).toMatch(/<ErrorState\b/);
      expect(source, file).toMatch(/onRetry=\{retry\}/);
      expect(source, file).toMatch(/href="\/"/);
    }
  });

  // ─── A failed read is never shown as empty ─────────────────────────────

  it("no read discards its error, outside the D5 auth fail-closed paths", () => {
    const dropped = [
      ...offenders(SHIPPED_UI, /const\s*\{\s*data(?:\s*:\s*\w+)?\s*(?:,\s*count(?:\s*:\s*\w+)?)?\s*\}\s*=\s*await\s+supabase/),
      ...offenders(SHIPPED_UI, /\{\s*data(?:\s*:\s*\w+)?\s*\}\s*(?:,\s*\{\s*data(?:\s*:\s*\w+)?\s*\})+\s*\]\s*=\s*await\s+Promise\.all/),
      // A read used inline, keeping only its data: (await supabase…).data
      ...offenders(SHIPPED_UI, /\(\s*await\s+supabase\b[^;]*?\)\s*\.data\b/),
    ];
    expect([...new Set(dropped.map((d) => d.split(": ")[0]))].sort()).toEqual([...D5_EXCLUSIONS.authFailClosed].sort());
  });

  it("a missing parent's id filters as NO_MATCH_ID, never \"\" (invalid uuid input would fail the read)", () => {
    expect(offenders(SHIPPED_UI, /\.(?:eq|neq|in)\(\s*"[\w.]+"\s*,[^)]*\|\|\s*""\s*\)/)).toEqual([]);
  });

  it("every hand-written loader catches its failure", () => {
    const uncaught = SHIPPED_UI.flatMap((f) =>
      [...read(f).matchAll(/const\s+(load\w*)\s*=\s*(?:useCallback\()?\s*async[^\n]*\n([\s\S]*?)\n  \};?\)?/g)]
        .filter((m) => !/catch\s*[({]/.test(m[2]))
        .map((m) => `${f}: ${m[1]}`)
    );
    expect(uncaught).toEqual([]);
  });

  it("no page loads through a promise chain with no error path (S1: a failed read must reach an error state)", () => {
    // `action().then(setData)` in an effect leaves the page on "Loading..."
    // forever when the read fails; loaders use useAsyncResource/StateView or
    // catch. A .then with a .catch after it is allowed.
    const chains = SHIPPED_UI.flatMap((f) =>
      [...code(read(f)).matchAll(/\b\w+\([^()]*\)\s*\.then\(\s*(?:set\w+|\(?[\w\s,[\]{}]*\)?\s*=>)[\s\S]{0,400}?\)\s*;/g)]
        .filter((m) => !/\.catch\(/.test(m[0]) && /\bset[A-Z]\w*\(|\.then\(\s*set\w+\)/.test(m[0]))
        .map((m) => `${f}: ${m[0].replace(/\s+/g, " ").slice(0, 90)}`)
    );
    expect(chains).toEqual([]);
  });

  it("EmptyState is rendered only by StateView (and shown in the development gallery)", () => {
    const importers = APPLICATION.filter((file) => /from\s+["']@\/components\/ui\/empty-state["']/.test(read(file)));
    expect(importers.sort()).toEqual(["app/dev/gallery/demos.tsx", "components/ui/state-view.tsx"]);
  });

  it("DataTable shows its error before its empty message", () => {
    const source = code(read("components/ui/data-table.tsx"));
    const errorRow = source.indexOf("Boolean(error) && data.length === 0");
    const emptyRow = source.indexOf("emptyMessage}");
    expect(errorRow).toBeGreaterThan(-1);
    expect(emptyRow).toBeGreaterThan(errorRow);
  });

  // ─── Errors are not toasts ─────────────────────────────────────────────

  it("nothing shows an error as a toast, and the toast API has no error method", () => {
    const calls = APPLICATION.filter((file) => /\btoast\s*\.\s*error\s*\(/.test(code(read(file))));
    expect(calls).toEqual([]);
    const api = /export interface ToastApi \{([\s\S]*?)\n\}/.exec(code(read("components/ui/toast.tsx")))![1];
    expect([...api.matchAll(/^\s*(\w+)\s*[:(]/gm)].map((m) => m[1]).sort()).toEqual(["dismiss", "info", "success"]);
  });

  // ─── Pending work is exposed; loading is not announced passively ───────

  it("a button whose label says it is working is aria-busy (auth forms outside M6 aside)", () => {
    const files = SHIPPED_UI.filter((f) => !f.startsWith("app/auth/"));
    const missing = files.flatMap((f) =>
      [...read(f).matchAll(/<(?:Button|button)\b((?:[^>{]|\{(?:[^{}]|\{[^{}]*\})*\})*)>\s*\{\s*[\w.!=\s"'|&]+?\s*\?\s*["'][^"']*(?:…|\.\.\.)["']/g)]
        .filter((m) => !/aria-busy/.test(m[1]))
        .map((m) => `${f}: ${m[0].replace(/\s+/g, " ").slice(0, 100)}`)
    );
    expect(missing).toEqual([]);
  });

  it("the portal shell marks <main> busy while a navigation is pending, and its marker is static and no live region", () => {
    const shell = code(read("components/portal/portal-shell.tsx"));
    expect(shell).toMatch(/<main\b[^>]*aria-busy=\{pendingHref \? true : undefined\}/);
    const marker = /<span\s+data-testid="nav-pending"[\s\S]*?<\/span>/.exec(shell)![0];
    expect(marker).not.toMatch(/role=|aria-live|motion-|animate-|transition/);
    expect(shell).toMatch(/const PENDING_MARKER_DELAY_MS = 150;/);
  });

  it("the data table's loading row is not a live region", () => {
    const source = code(read("components/ui/data-table.tsx"));
    const loadingRow = /Loading…/.exec(source);
    expect(loadingRow).not.toBeNull();
    expect(source.slice(Math.max(0, loadingRow!.index - 300), loadingRow!.index)).not.toMatch(/role="status"|aria-live/);
  });

  it("ConfirmationDialog: Cancel takes focus first, and Confirm is guarded and busy while pending", () => {
    const source = code(read("components/ui/confirmation-dialog.tsx"));
    expect(source).toMatch(/disabled=\{pending\}\s*onClick=\{requestClose\}\s*ref=\{\(el\) => el\?\.setAttribute\("autofocus", ""\)\}/);
    expect(source).toMatch(/if \(pending \|\| confirming\.current\) return;/);
    // Escape or the browser asking to close while the action runs: never cancels.
    expect(source).toMatch(/const requestClose = \(\) => \{\s*if \(!pending\) \{\s*onCancel\(\);\s*return;\s*\}/);
    expect(source).toMatch(/aria-busy=\{pending \|\| undefined\}/);
  });

  // ─── Motion ────────────────────────────────────────────────────────────

  it("a toast enters with motion-appear only, and the toast region never moves", () => {
    const source = code(read("components/ui/toast.tsx"));
    const motion = [...source.matchAll(/\b(?:motion-[\w-]+|animate-[\w-]+|transition(?:-[\w-]+)?)\b/g)].map((m) => m[0]);
    expect([...new Set(motion)].sort()).toEqual(["motion-appear", "motion-feedback"]);
    expect(source).toMatch(/className="motion-appear /);
  });
});
