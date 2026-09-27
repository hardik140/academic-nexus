import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { twMerge } from "tailwind-merge";
import { cn, NAMED_SPACING } from "@/lib/utils";

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
