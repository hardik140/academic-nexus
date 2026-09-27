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
 * The class rules cover the shared UI (components/ui, components/portal,
 * components/charts); page code joins the scope once M3 has cleaned it. The
 * Recharts rule covers every file in app/ and components/.
 *
 * Existing violations are listed in KNOWN_DEBT with their exact count and
 * the stage that removes them. A count must match exactly: one more fails
 * (new debt), one fewer fails too, so the entry is lowered or deleted in the
 * same change that fixes it and the allowance can never be reused. Never
 * raise a count to make a run pass.
 */

type Rule = "transition-all" | "shadow-transition" | "long-duration" | "keyframe-animation" | "chart-animation";

const MAX_DURATION_MS = 300;

const CLASS_RULE_SCOPE = ["components/ui", "components/portal", "components/charts"];
const CHART_RULE_SCOPE = ["app", "components"];

// M2 removed the stats-card, FormField, DataTable-search and nav-item debt.
const KNOWN_DEBT: Record<string, Partial<Record<Rule, { count: number; stage: string }>>> = {
  "components/ui/modal.tsx": {
    "keyframe-animation": { count: 2, stage: "M4 — replaced by the native Dialog with motion-dialog" },
  },
  "components/portal/portal-shell.tsx": {
    "transition-all": { count: 1, stage: "M5 — sidebar width animation / mobile drawer" },
  },
};

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
  for (const literal of source.matchAll(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g)) {
    for (const m of literal[0].matchAll(new RegExp(`${B}!?transition!?(?=[\\s"'\\x60]|$)`, "g"))) {
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
    expect(classFiles).toContain("components/portal/portal-shell.tsx");
    expect(classFiles).toContain("components/charts/placement-funnel-chart.tsx");
    expect(chartFiles).toContain("app/(portal)/director/forecast/page.tsx");
  });

  it("shared UI has no motion violations beyond the documented debt, and no debt left unclaimed", () => {
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
