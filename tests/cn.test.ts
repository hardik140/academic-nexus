import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { twMerge } from "tailwind-merge";
import { cn, MOTION_UTILITIES, NAMED_EASE, NAMED_RADIUS, NAMED_SHADOW, NAMED_SPACING, NAMED_TEXT } from "@/lib/utils";

describe("cn(): named spacing tokens", () => {
  it("NAMED_SPACING is exactly the --spacing-<name> tokens defined in app/globals.css", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const defined = [...css.matchAll(/--spacing-([a-z0-9]+)\s*:/g)].map((m) => m[1]);
    expect([...new Set(defined)].sort()).toEqual([...NAMED_SPACING].sort());
  });

  it.each([
    ["p-md p-lg", "p-lg"],
    ["px-lg p-md", "p-md"],
    ["gap-sm gap-md", "gap-md"],
    ["gap-x-sm gap-md", "gap-md"],
    ["space-y-sm space-y-md", "space-y-md"],
    ["mt-lg m-md", "m-md"],
    ["-mt-sm mt-md", "mt-md"],
    ["px-sm px-[10px]", "px-[10px]"],
    ["py-[10px] py-md", "py-md"],
    ["p-2xl p-3xl", "p-3xl"],
    // Every directional and axis variant resolves against its own axis.
    ["px-md px-lg", "px-lg"],
    ["py-md py-lg", "py-lg"],
    ["pt-md pt-lg", "pt-lg"],
    ["pr-md pr-lg", "pr-lg"],
    ["pb-md pb-lg", "pb-lg"],
    ["pl-md pl-lg", "pl-lg"],
    ["ps-md ps-lg", "ps-lg"],
    ["pe-md pe-lg", "pe-lg"],
    ["mx-md mx-lg", "mx-lg"],
    ["my-md my-lg", "my-lg"],
    ["mb-md mb-lg", "mb-lg"],
    ["gap-x-sm gap-x-md", "gap-x-md"],
    ["gap-y-sm gap-y-md", "gap-y-md"],
    ["space-x-sm space-x-md", "space-x-md"],
    ["md:p-md md:p-lg", "md:p-lg"],
  ])("resolves the conflict %s → %s (last one wins)", (input, expected) => {
    expect(cn(input)).toBe(expected);
  });

  it("keeps non-conflicting spacing on different axes", () => {
    expect(cn("p-md px-lg")).toBe("p-md px-lg");
    expect(cn("m-md mt-lg")).toBe("m-md mt-lg");
    expect(cn("gap-xs px-md py-sm")).toBe("gap-xs px-md py-sm");
  });

  it("lets a caller's className override a component's base spacing", () => {
    expect(cn("inline-flex text-xs px-sm py-xs rounded-full", "px-md")).toBe("inline-flex text-xs py-xs rounded-full px-md");
  });
});

/** Names defined as --<namespace>-<name> in app/globals.css, excluding sub-properties (--text-x--line-height). */
function definedTokens(namespace: string): string[] {
  const css = readFileSync("app/globals.css", "utf8");
  const names = [...css.matchAll(new RegExp(`--${namespace}-([a-z0-9-]+)\s*:`, "g"))].map((m) => m[1]);
  return [...new Set(names.filter((n) => !n.includes("--")))].sort();
}

// Names tailwind-merge already understands: Tailwind's t-shirt sizes and its
// own easing names.
const TSHIRT = /^(d?xs|sm|md|lg|d?xl|full)$/;

describe("cn(): Stage 2 named tokens", () => {
  it("the named lists match the tokens app/globals.css defines", () => {
    expect(definedTokens("text")).toEqual([...NAMED_TEXT].sort());
    expect(definedTokens("radius").filter((n) => !TSHIRT.test(n))).toEqual([...NAMED_RADIUS].sort());
    expect(definedTokens("shadow").filter((n) => !TSHIRT.test(n))).toEqual([...NAMED_SHADOW].sort());
    expect(definedTokens("ease").filter((n) => !["in", "out", "in-out"].includes(n))).toEqual([...NAMED_EASE].sort());
  });

  it.each([
    // A type role is a font SIZE: it conflicts with other sizes, never with a colour.
    ["text-caption text-body", "text-body"],
    ["text-sm text-caption", "text-caption"],
    ["text-body-sm text-page-title", "text-page-title"],
    ["text-metric text-3xl", "text-3xl"],
    ["text-caption text-error", "text-caption text-error"],
    ["text-page-title text-on-surface", "text-page-title text-on-surface"],
    ["text-on-surface text-outline text-section", "text-outline text-section"],
    ["rounded-xl rounded-panel", "rounded-panel"],
    ["rounded-control rounded-full", "rounded-full"],
    ["rounded-dialog rounded-t-none", "rounded-dialog rounded-t-none"],
    ["shadow-sm shadow-menu", "shadow-menu"],
    ["shadow-menu shadow-dialog", "shadow-dialog"],
    ["shadow-panel shadow-secondary", "shadow-panel shadow-secondary"],
    ["ease-out ease-emphasized", "ease-emphasized"],
  ])("resolves %s → %s", (input, expected) => {
    expect(cn(input)).toBe(expected);
  });
});

describe("cn(): semantic motion utilities (Checkpoint 4, M1)", () => {
  it("MOTION_UTILITIES is exactly the motion-* utilities app/globals.css defines", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const defined = [...css.matchAll(/@utility\s+motion-([a-z]+)\s*\{/g)].map((m) => m[1]);
    expect(defined.sort()).toEqual([...MOTION_UTILITIES].sort());
  });

  it.each([
    // The semantic utility wins whichever side the raw class is on.
    ["motion-feedback transition-all", "motion-feedback"],
    ["transition-all motion-feedback", "motion-feedback"],
    ["motion-feedback duration-300", "motion-feedback"],
    ["duration-300 motion-feedback", "motion-feedback"],
    ["motion-state transition-colors", "motion-state"],
    ["motion-dialog duration-300", "motion-dialog"],
    ["motion-drawer duration-200", "motion-drawer"],
    ["motion-state ease-in", "motion-state"],
    ["motion-dialog ease-emphasized", "motion-dialog"],
    ["motion-feedback transition-discrete", "motion-feedback"],
    ["motion-feedback transition-[width]", "motion-feedback"],
    ["motion-feedback duration-[700ms]", "motion-feedback"],
    // Between two motion utilities the last one wins, as for any class group.
    ["motion-feedback motion-state", "motion-state"],
    ["motion-dialog motion-drawer", "motion-drawer"],
    // M2: the combinations the migrated primitives meet.
    ["motion-feedback transition-colors", "motion-feedback"],
    ["transition-colors motion-feedback", "motion-feedback"],
    ["motion-state ease-out", "motion-state"],
    ["motion-state duration-700", "motion-state"],
  ])("resolves %s → %s", (input, expected) => {
    expect(cn(input)).toBe(expected);
  });

  it("keeps a raw transition class under different variants", () => {
    expect(cn("motion-feedback md:transition-all")).toBe("motion-feedback md:transition-all");
    expect(cn("hover:motion-feedback duration-300")).toBe("hover:motion-feedback duration-300");
    expect(cn("hover:motion-feedback hover:duration-300")).toBe("hover:motion-feedback");
  });

  it("never drops a motion utility for unrelated classes", () => {
    expect(cn("inline-flex motion-feedback rounded-control px-md", "text-error")).toBe("inline-flex motion-feedback rounded-control px-md text-error");
    expect(cn("motion-state", "opacity-50", "delay-75")).toBe("motion-state opacity-50 delay-75");
    expect(cn("motion-feedback", "motion-safe:animate-spin")).toBe("motion-feedback motion-safe:animate-spin");
  });

  it("keeps the migrated primitives' motion utility when a caller adds raw transition classes", () => {
    const button = "inline-flex items-center justify-center gap-xs rounded-xl font-semibold motion-feedback disabled:opacity-50 disabled:cursor-not-allowed";
    expect(cn(button, "bg-secondary text-on-secondary", "transition-all duration-300")).toBe(
      "inline-flex items-center justify-center gap-xs rounded-xl font-semibold motion-feedback disabled:opacity-50 disabled:cursor-not-allowed bg-secondary text-on-secondary",
    );
    const badge = "inline-flex items-center gap-xs text-xs font-semibold px-sm py-xs rounded-full capitalize motion-state";
    expect(cn(badge, "bg-success-container text-on-success-container", "shrink-0")).toBe(`${badge} bg-success-container text-on-success-container shrink-0`);
    expect(cn(badge, "transition-colors")).toBe(badge);
  });

  it("lets a caller's className replace a component's motion utility", () => {
    expect(cn("inline-flex motion-feedback", "motion-state")).toBe("inline-flex motion-state");
  });

  it("changes nothing when no motion utility is present", () => {
    expect(cn("transition-colors duration-200 ease-out")).toBe("transition-colors duration-200 ease-out");
    expect(cn("")).toBe("");
  });
});

describe("cn(): everything else merges exactly as stock tailwind-merge", () => {
  it.each([
    "text-sm text-on-surface",
    "text-xs text-outline",
    "border border-outline-variant",
    "rounded-xl rounded-full",
    "shadow-sm shadow-md",
    "bg-secondary bg-success/10",
    "max-w-md max-w-[32rem]",
    "w-md w-full",
    "text-xs text-[11px]",
    "hover:bg-surface-container-high hover:bg-surface-container-low",
    "font-semibold font-bold",
    "inset-x-md left-sm",
  ])("%s", (input) => {
    expect(cn(input)).toBe(twMerge(input));
  });
});

describe("cn(): today's component class combinations are unchanged", () => {
  // The real class strings the shared components pass to cn() (Stage 1 audit:
  // 72 combinations, 0 differences). A representative sample is pinned here.
  it.each([
    [
      "inline-flex items-center justify-center gap-xs rounded-xl font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
      "bg-secondary text-on-secondary hover:bg-secondary-container shadow-md",
      "px-md py-sm text-sm",
      "w-full justify-center",
    ],
    ["inline-flex text-xs font-semibold px-sm py-xs rounded-full capitalize", "bg-success/10 text-success", "shrink-0"],
    ["flex items-center gap-sm px-md py-[10px] rounded-xl text-sm font-medium transition-all", "bg-secondary text-on-secondary shadow-md"],
    ["text-left px-lg py-sm font-semibold text-xs uppercase tracking-wider", "cursor-pointer select-none hover:text-on-surface"],
    ["px-lg py-md"],
    ["bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:shadow-md transition-all duration-200"],
  ])("%s", (...parts) => {
    expect(cn(...parts)).toBe(twMerge(parts.join(" ")));
  });
});
