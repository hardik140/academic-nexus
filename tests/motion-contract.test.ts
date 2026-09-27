import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Motion contract guard (Checkpoint 4, M1).
 *
 * Motion is CSS-first and goes through four semantic utilities in
 * app/globals.css (motion-feedback, motion-state, motion-dialog,
 * motion-drawer). This static scan stops the contract from eroding:
 *
 *   • transition-all — animates whatever changes, layout included; also its
 *     arbitrary spellings (transition-[all], transition-[width], …).
 *   • animating box-shadow (M2): transition-shadow, transition-[box-shadow],
 *     or the bare `transition` utility, whose default properties include it.
 *   • durations over 300ms (--duration-slow), as classes or inline styles.
 *   • animate-* other than animate-spin — decorative keyframe motion.
 *   • an animation library in package.json.
 *   • a Recharts series with animation switched on — charts never animate,
 *     and Recharts animates in JavaScript, beyond the CSS reduced-motion rule.
 *
 * The class rules cover every page (app/, since M3) and the shared UI
 * (components/ui, components/portal, components/charts). The Recharts rule
 * covers every file in app/ and components/.
 *
 * Existing violations are listed in KNOWN_DEBT with their exact count and
 * the stage that removes them. A count must match exactly: one more fails
 * (new debt), one fewer fails too, so the entry is lowered or deleted in the
 * same change that fixes it and the allowance can never be reused. Never
 * raise a count to make a run pass.
 */

type Rule = "transition-all" | "shadow-transition" | "long-duration" | "keyframe-animation" | "chart-animation";

const MAX_DURATION_MS = 300;

const CLASS_RULE_SCOPE = ["app", "components/ui", "components/portal", "components/charts"];
const CHART_RULE_SCOPE = ["app", "components"];

// M2 removed the stats-card, FormField, DataTable-search and nav-item debt;
// M4 the Modal's two keyframe animations; M5 the sidebar's width animation.
// No motion debt remains: anything found now is new.
const KNOWN_DEBT: Record<string, Partial<Record<Rule, { count: number; stage: string }>>> = {};

// ─── Rules ───────────────────────────────────────────────────────────────

// A class token boundary: start, whitespace, a quote or backtick, or a
// variant colon. Keeps `x-transition-all` or `reanimate-` from matching.
const B = String.raw`(?<=^|[\s"'\x60:{(])`;
const E = String.raw`(?![\w-])`;

// `all`, or a property that changes layout (Checkpoint 4 performance contract).
const LAYOUT_OR_ALL = /(^|[\s,_])(all|width|height|min-width|max-width|min-height|max-height|top|right|bottom|left|inset|margin[\w-]*|padding[\w-]*)($|[\s,_])/;

function toMs(value: string, unit: string): number {
  return Number(value) * (unit === "s" ? 1000 : 1);
}

export function findViolations(source: string): Array<{ rule: Rule; match: string }> {
  const found: Array<{ rule: Rule; match: string }> = [];

  for (const m of source.matchAll(new RegExp(`${B}!?transition-all!?${E}`, "g"))) {
    found.push({ rule: "transition-all", match: m[0] });
  }
  // The same thing spelled as an arbitrary value — transition-[all] — or an
  // arbitrary transition of a layout property: counted with transition-all.
  for (const m of source.matchAll(new RegExp(`${B}!?transition-\\[([^\\]]+)\\]`, "g"))) {
    if (LAYOUT_OR_ALL.test(m[1])) found.push({ rule: "transition-all", match: m[0] });
  }
  for (const m of source.matchAll(/\btransitionProperty\s*:\s*["'`]([^"'`]*)["'`]/g)) {
    if (LAYOUT_OR_ALL.test(m[1])) found.push({ rule: "transition-all", match: m[0] });
  }

  // duration-700, duration-[700ms], duration-[0.7s]
  for (const m of source.matchAll(new RegExp(`${B}!?duration-(\\d+)!?${E}`, "g"))) {
    if (Number(m[1]) > MAX_DURATION_MS) found.push({ rule: "long-duration", match: m[0] });
  }
  for (const m of source.matchAll(new RegExp(`${B}!?duration-\\[(\\d*\\.?\\d+)(ms|s)\\]`, "g"))) {
    if (toMs(m[1], m[2]) > MAX_DURATION_MS) found.push({ rule: "long-duration", match: m[0] });
  }
  // Inline styles: transition / transitionDuration / animation / animationDuration.
  for (const m of source.matchAll(/\b(?:transition|animation)(?:Duration)?\s*:\s*["'`]([^"'`]*)["'`]/g)) {
    for (const t of m[1].matchAll(/(\d*\.?\d+)(ms|s)\b/g)) {
      if (toMs(t[1], t[2]) > MAX_DURATION_MS) found.push({ rule: "long-duration", match: m[0] });
    }
    if (/\ball\b/.test(m[1])) found.push({ rule: "transition-all", match: m[0] });
  }

  // Animating box-shadow (M2): transition-shadow, an arbitrary transition of
  // box-shadow, and the bare `transition` utility — whose default property
  // list includes box-shadow. Static shadow-* classes are fine; only the
  // animation of a shadow is not. The bare word is only looked for inside
  // string literals, so prose in comments or JSX text never matches.
  for (const m of source.matchAll(new RegExp(`${B}!?transition-shadow!?${E}`, "g"))) {
    found.push({ rule: "shadow-transition", match: m[0] });
  }
  for (const m of source.matchAll(new RegExp(`${B}!?transition-\\[([^\\]]+)\\]`, "g"))) {
    if (/(^|[\s,_])box-shadow($|[\s,_])/.test(m[1])) found.push({ rule: "shadow-transition", match: m[0] });
  }
  for (const m of source.matchAll(/\b(?:transition|transitionProperty)\s*:\s*["'`]([^"'`]*)["'`]/g)) {
    if (/(^|[\s,])box-shadow\b/.test(m[1])) found.push({ rule: "shadow-transition", match: m[0] });
  }
  // A template literal's ${…} expressions are code, not class text — a
  // variable named `transition` there is not the utility — so they are
  // dropped first, and the word must stand alone like a class would.
  for (const literal of source.matchAll(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g)) {
    const text = literal[0].replace(/\$\{[^}]*\}/g, " ");
    for (const m of text.matchAll(/(?<=^|[\s"'`:])!?transition!?(?=[\s"'`]|$)/g)) {
      found.push({ rule: "shadow-transition", match: m[0] });
    }
  }

  // animate-[…], animate-pulse, animate-fade-in … — everything but spin/none.
  for (const m of source.matchAll(new RegExp(`${B}!?animate-(?!(?:spin|none)${E})[\\w\\[(]`, "g"))) {
    found.push({ rule: "keyframe-animation", match: m[0] });
  }

  // Recharts: isAnimationActive must be absent (Recharts' reduced-motion-aware
  // default) or explicitly false. A bare prop, {true}, "auto" or a variable fails.
  for (const m of source.matchAll(/\bisAnimationActive\b(?!\s*=\s*\{\s*false\s*\}|\s*:\s*false\b)/g)) {
    found.push({ rule: "chart-animation", match: m[0] });
  }

  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|jsx?)$/.test(entry) ? [path.replace(/\\/g, "/")] : [];
  });
}

function countByRule(files: string[], rules: Rule[]): Record<string, Partial<Record<Rule, number>>> {
  const result: Record<string, Partial<Record<Rule, number>>> = {};
  for (const file of files) {
    for (const { rule } of findViolations(readFileSync(file, "utf8"))) {
      if (!rules.includes(rule)) continue;
      result[file] ??= {};
      result[file][rule] = (result[file][rule] ?? 0) + 1;
    }
  }
  return result;
}

// ─── The rules themselves (checked on controlled strings) ─────────────────

describe("motion guard: rule detection", () => {
  it.each([
    ['className="px-md transition-all"', "transition-all"],
    ["cn('flex', 'hover:transition-all')", "transition-all"],
    ["`transition-all ${x}`", "transition-all"],
    ['className="!transition-all"', "transition-all"],
    ["style={{ transition: 'all 150ms' }}", "transition-all"],
    ['className="transition-[all]"', "transition-all"],
    ['className="transition-[width]"', "transition-all"],
    ['className="transition-[opacity,max-height]"', "transition-all"],
    ['className="transition-[padding_150ms]"', "transition-all"],
    ["style={{ transitionProperty: 'height' }}", "transition-all"],
    ['className="transition-shadow"', "shadow-transition"],
    ['className="hover:shadow-md md:transition-shadow"', "shadow-transition"],
    ['className="transition-[box-shadow]"', "shadow-transition"],
    ['className="transition-[opacity,box-shadow]"', "shadow-transition"],
    ["style={{ transition: 'box-shadow 150ms' }}", "shadow-transition"],
    ["style={{ transitionProperty: 'box-shadow' }}", "shadow-transition"],
    ['className="rounded-lg transition hover:shadow-md"', "shadow-transition"],
    ["cn('transition', 'shadow-sm')", "shadow-transition"],
    ["className={`${base} transition hover:shadow-md`}", "shadow-transition"],
    ['className="duration-500"', "long-duration"],
    ['className="duration-700 ease-out"', "long-duration"],
    ['className="duration-[400ms]"', "long-duration"],
    ['className="duration-[0.35s]"', "long-duration"],
    ["style={{ transitionDuration: '500ms' }}", "long-duration"],
    ["style={{ animation: 'spin 1.5s linear' }}", "long-duration"],
    ['className="animate-[fade-in_0.3s_ease-out]"', "keyframe-animation"],
    ['className="animate-pulse"', "keyframe-animation"],
    ['className="md:animate-bounce"', "keyframe-animation"],
    ['className="animate-fade-in"', "keyframe-animation"],
    ['className="animate-(--my-animation)"', "keyframe-animation"],
    ["<Funnel isAnimationActive>", "chart-animation"],
    ["<Pie isAnimationActive={true} />", "chart-animation"],
    ['<Line isAnimationActive="auto" />', "chart-animation"],
    ["<Bar isAnimationActive={animate} />", "chart-animation"],
    ["const props = { isAnimationActive: true }", "chart-animation"],
  ])("flags %s as %s", (source, rule) => {
    expect(findViolations(source).map((v) => v.rule)).toContain(rule);
  });

  it.each([
    'className="transition-colors duration-200 ease-out"',
    'className="motion-feedback rounded-control"',
    'className="motion-state motion-dialog motion-drawer"',
    'className="duration-300"',
    'className="shadow-md hover:shadow-lg shadow-sm"',
    'className="transition-colors transition-opacity transition-transform transition-none"',
    "// a lifecycle transition from planned to active",
    "<p>The transition happens when the semester closes.</p>",
    "checkRateLimit(`${transition}:${table}:${userId}`, 30, 60);",
    "logAudit(`${transition === 'activate' ? 'Activated' : 'Closed'} ${name}`);",
    'className="transition-[opacity,transform] transition-[color]"',
    "style={{ transitionProperty: 'opacity, transform' }}",
    'className="duration-150 duration-[250ms] duration-[0.3s]"',
    'className="animate-spin"',
    'className="motion-safe:animate-spin animate-none"',
    "style={{ transitionDuration: '200ms' }}",
    "<Funnel dataKey=\"value\" isAnimationActive={false}>",
    "const props = { isAnimationActive: false }",
    "// the transition-allowance and reanimate-state helpers are unrelated",
    'const label = "Duration: 700 minutes"; const x = "animated-list";',
    "const timeoutMs = 3000; setTimeout(close, 1200);",
  ])("does not flag %s", (source) => {
    expect(findViolations(source)).toEqual([]);
  });
});

// ─── The repository ───────────────────────────────────────────────────────

describe("motion guard: repository", () => {
  const classRules: Rule[] = ["transition-all", "shadow-transition", "long-duration", "keyframe-animation"];
  const classFiles = CLASS_RULE_SCOPE.flatMap(sourceFiles);
  const chartFiles = CHART_RULE_SCOPE.flatMap(sourceFiles);

  it("scans the intended files", () => {
    expect(classFiles).toContain("components/ui/modal.tsx");
    expect(classFiles).toContain("components/ui/native-dialog.tsx");
    expect(classFiles).toContain("components/portal/portal-shell.tsx");
    expect(classFiles).toContain("components/charts/placement-funnel-chart.tsx");
    expect(classFiles).toContain("app/(portal)/admin/dashboard/page.tsx");
    expect(classFiles).toContain("app/loading.tsx");
    expect(classFiles).toContain("app/login/page.tsx");
    expect(chartFiles).toContain("app/(portal)/director/forecast/page.tsx");
  });

  it("pages and shared UI have no motion violations beyond the documented debt, and no debt left unclaimed", () => {
    const found = countByRule(classFiles, classRules);
    const expected: Record<string, Partial<Record<Rule, number>>> = {};
    for (const [file, rules] of Object.entries(KNOWN_DEBT)) {
      for (const [rule, debt] of Object.entries(rules)) {
        if (!classRules.includes(rule as Rule)) continue;
        expected[file] ??= {};
        expected[file][rule as Rule] = debt!.count;
      }
    }
    expect(found).toEqual(expected);
  });

  it("no Recharts series in app/ or components/ turns animation on", () => {
    expect(countByRule(chartFiles, ["chart-animation"])).toEqual({});
  });

  it("every series in the placement funnel chart has animation explicitly off", () => {
    const source = readFileSync("components/charts/placement-funnel-chart.tsx", "utf8");
    const series = [...source.matchAll(/<(Funnel|Pie|Bar|Line|Area|RadialBar|Scatter|Radar)\b[^>]*>/g)];
    expect(series.length).toBeGreaterThan(0);
    for (const [tag] of series) expect(tag).toMatch(/isAnimationActive=\{false\}/);
  });

  it("no animation library is a dependency", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const banned = ["framer-motion", "motion", "gsap", "react-spring", "@react-spring/web", "@formkit/auto-animate", "animejs", "popmotion"];
    expect(deps.filter((d) => banned.includes(d))).toEqual([]);
  });
});

// ─── M3: page motion cleanup ──────────────────────────────────────────────

describe("motion guard: M3 page contract", () => {
  const read = (file: string) => readFileSync(file, "utf8");
  const pages = sourceFiles("app");

  it("no page fades in: route changes do not animate", () => {
    const withFade = pages.filter((f) => /animate-\[fade-in|(?<![\w-])animate-fade-in(?![\w-])/.test(read(f)));
    expect(withFade).toEqual([]);
  });

  it("no page progress bar transitions its width", () => {
    for (const file of [
      "app/(portal)/director/analytics/page.tsx",
      "app/(portal)/director/goals/page.tsx",
      "app/(portal)/finance/reports/page.tsx",
      "app/(portal)/placement-cell/reports/page.tsx",
      "app/(portal)/student/attendance/page.tsx",
      "app/(portal)/student/insights/insights-client.tsx",
    ]) {
      const bars = read(file).split(/\r?\n/).filter((line) => /h-full[^"`]*rounded-full|rounded-full[^"`]*h-full/.test(line));
      expect(bars.length, file).toBeGreaterThan(0);
      for (const bar of bars) expect(bar, file).not.toMatch(/transition|duration-|motion-|animate-/);
    }
  });

  it("non-interactive page cards have no hover shadow and no transition", () => {
    for (const file of [
      "app/(portal)/admin/dashboard/page.tsx",
      "app/(portal)/hod/faculty/page.tsx",
      "app/(portal)/student/courses/page.tsx",
      "app/(portal)/teacher/courses/page.tsx",
    ]) {
      expect(read(file), file).not.toMatch(/hover:shadow|transition-shadow|transition-all/);
    }
  });

  it("interactive page cards keep a hover shadow, but it is not animated", () => {
    for (const [file, element] of [
      ["app/(portal)/director/departments/page.tsx", "<button"],
      ["app/(portal)/teacher/dashboard/dashboard-client.tsx", "<Link"],
    ]) {
      const source = read(file);
      const line = source.split(/\r?\n/).find((l) => l.includes("hover:shadow-md"));
      expect(line, file).toBeDefined();
      expect(line, file).not.toMatch(/transition|duration-|motion-/);
      expect(source, file).toContain(element);
    }
  });

  it("the route loading screen is static: nothing pulses or spins", () => {
    const loading = read("app/loading.tsx");
    expect(loading).not.toMatch(/animate-|transition|motion-/);
    expect(loading).toContain("Loading Academic Nexus...");
  });

  it("the dead --animate-* tokens and their orphaned keyframes are gone", () => {
    const css = read("app/globals.css");
    expect(css).not.toMatch(/--animate-/);
    expect(css).not.toMatch(/@keyframes\s+slide-in-right/);
  });

  it("every remaining @keyframes is used by something", () => {
    const css = read("app/globals.css");
    const names = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    const code = [...pages, ...CLASS_RULE_SCOPE.slice(1).flatMap(sourceFiles)].map(read).join("\n");
    for (const name of names) {
      expect(code.includes(`animate-[${name}_`) || new RegExp(`animation(?:-name)?:[^;]*\b${name}\b`).test(css), name).toBe(true);
    }
  });
});

// ─── M4: the Modal on a native <dialog> ───────────────────────────────────

describe("motion guard: M4 native Dialog", () => {
  const source = readFileSync("components/ui/modal.tsx", "utf8");
  const modal = source.slice(source.indexOf("export function Modal("), source.indexOf("// ─── Button Component"));

  // Since M5 the native <dialog> behaviour lives in NativeDialog, shared with the portal's drawer.
  const nativeDialog = readFileSync("components/ui/native-dialog.tsx", "utf8");

  it("the Modal is a native <dialog> (NativeDialog), opened with showModal() and closed with close()", () => {
    expect(modal).toMatch(/<NativeDialog\b/);
    expect(nativeDialog).toMatch(/<dialog\b/);
    expect(nativeDialog).toContain(".showModal()");
    expect(nativeDialog).toContain(".close()");
  });

  it("its motion is the motion-dialog utility, not re-timed or re-animated locally", () => {
    expect(modal).toMatch(/["\s]motion-dialog[\s"]/);
    expect(modal).not.toMatch(/animate-|transition-|duration-|delay-|ease-(?:in|out|linear|\[)/);
  });

  it("no simulated overlay: no fixed layer, z-index, backdrop element, role, aria-modal, focus trap or global key listener", () => {
    for (const source of [modal, nativeDialog]) {
      expect(source).not.toMatch(/\bfixed\b|inset-0|\bz-(?:\d|\[)|role="dialog"|aria-modal|Close dialog|addEventListener\(\s*["']keydown|\.focus\(/);
    }
    expect(modal).toContain("backdrop:");
  });

  it("the Close button uses motion-feedback", () => {
    const close = /<button[^>]*aria-label="Close"[^>]*>/.exec(modal)?.[0] ?? "";
    expect(close).toContain("motion-feedback");
    expect(close).toContain('type="button"');
  });

  it("the Modal's fade-in and slide-up keyframes are gone", () => {
    expect(readFileSync("app/globals.css", "utf8")).not.toMatch(/@keyframes\s+(?:fade-in|slide-up)\b/);
  });
});

// ─── M5: the portal shell's sidebar and drawer ───────────────────────────

describe("motion guard: M5 sidebar and drawer", () => {
  const shell = readFileSync("components/portal/portal-shell.tsx", "utf8");
  const aside = /<aside\b[\s\S]*?>/.exec(shell)?.[0] ?? "";
  const drawer = /<NativeDialog\b[\s\S]*?>/.exec(shell)?.[0] ?? "";

  it("the desktop sidebar changes width at once: no transition, duration or animation of any kind", () => {
    expect(aside).toContain('"w-64"');
    expect(aside).toContain('"w-[72px]"');
    expect(aside).not.toMatch(/transition|duration-|animate-|motion-|ease-|delay-/);
  });

  it("the mobile drawer is the shared NativeDialog carrying motion-drawer, with no local timing", () => {
    expect(shell).toContain('from "@/components/ui/native-dialog"');
    expect(drawer).toMatch(/["\s]motion-drawer[\s"]/);
    expect(drawer).not.toMatch(/transition|duration-|animate-|ease-|delay-/);
  });

  it("no simulated drawer: no fixed layer, z-index, translate, manual inert, focus trap or global Escape listener", () => {
    expect(shell).not.toMatch(/\bfixed\b|inset-0|\bz-(?:\d|\[)|translate-x|\binert\b|aria-modal|role="dialog"|addEventListener\(\s*["']keydown|\.focus\(/);
  });
});
