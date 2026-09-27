import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Feedback contract guard (M6.1). A static scan that keeps the feedback
 * foundation's rules from eroding as pages start to use it:
 *
 *   • feedback never dismisses itself: no timer in any feedback component;
 *   • an empty state only ever follows a successful load: EmptyState is
 *     rendered by StateView (which cannot choose it for a failure — see
 *     selectView in tests/feedback-components.test.ts), never directly by a
 *     page, which could show it after a failed load;
 *   • no error message reaches the screen: the error state components print
 *     none, only a classified kind and a digest;
 *   • errors are not toasts: nothing calls toast.error (M6 decision 3).
 *
 * Markup and state selection are unit-tested in
 * tests/feedback-components.test.ts; browser behaviour in e2e/feedback.spec.ts.
 */

const FEEDBACK_COMPONENTS = [
  "components/ui/alert.tsx",
  "components/ui/loading-state.tsx",
  "components/ui/empty-state.tsx",
  "components/ui/error-state.tsx",
  "components/ui/state-view.tsx",
];

const read = (file: string) => readFileSync(file, "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|jsx?)$/.test(entry) ? [path.replace(/\\/g, "/")] : [];
  });
}

const APPLICATION = ["app", "components", "hooks", "lib"].flatMap(sourceFiles);

// Comments explain the rules in prose ("never dismisses itself", "toast.error"),
// so the rules look at code only.
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("feedback contract", () => {
  it("scans the intended files", () => {
    for (const file of FEEDBACK_COMPONENTS) expect(APPLICATION).toContain(file);
    expect(APPLICATION).toContain("app/dev/gallery/demos.tsx");
  });

  it("no feedback component sets a timer: nothing dismisses itself", () => {
    for (const file of FEEDBACK_COMPONENTS) {
      expect(code(read(file)), file).not.toMatch(/\b(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback)\s*\(/);
    }
  });

  it("EmptyState is rendered only by StateView (and shown in the development gallery)", () => {
    const importers = APPLICATION.filter((file) => /from\s+["']@\/components\/ui\/empty-state["']/.test(read(file)));
    expect(importers.sort()).toEqual(["app/dev/gallery/demos.tsx", "components/ui/state-view.tsx"]);
  });

  it("the error state components print no error message", () => {
    for (const file of ["components/ui/error-state.tsx", "components/ui/state-view.tsx"]) {
      expect(code(read(file)), file).not.toMatch(/\.message\b|\.stack\b|String\(\s*(?:state\.)?error|JSON\.stringify/);
    }
  });

  it("an error Alert is role=alert and every other tone role=status", () => {
    expect(code(read("components/ui/alert.tsx"))).toContain('role={tone === "error" ? "alert" : "status"}');
  });

  it("nothing shows an error as a toast", () => {
    const calls = APPLICATION.filter((file) => /\btoast\s*\.\s*error\s*\(/.test(code(read(file))));
    expect(calls).toEqual([]);
  });
});
