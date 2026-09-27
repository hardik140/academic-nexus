import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusBadge, statusTone } from "@/components/ui/modal";

// Foundation Stage 2: the colour tokens in app/globals.css carry WCAG 2.2 AA
// guarantees (4.5:1 for text, 3:1 for control boundaries, focus indicators
// and chart marks). These tests read the real stylesheet, so a later edit to
// a token that breaks a pairing fails here rather than in a browser audit.

const css = readFileSync("app/globals.css", "utf8");

// Only the default (light) token definitions, i.e. before the .dark block.
const lightTokens = css.slice(0, css.indexOf(".dark {"));

function token(name: string): string {
  const match = new RegExp(`--color-${name}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(lightTokens);
  if (!match) throw new Error(`--color-${name} is not defined as a #rrggbb value`);
  return match[1];
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The light surfaces text and controls actually sit on.
const SURFACES = ["surface-container-lowest", "surface", "surface-container-low"];

describe("design tokens: approved values", () => {
  it.each([
    ["secondary", "#0051d5"],
    ["on-surface", "#0b1c30"],
    ["on-surface-variant", "#45464d"],
    ["outline", "#64656d"],
    ["border-control", "#7a7b82"],
    ["success", "#047857"],
    ["warning", "#b45309"],
    ["info", "#1d4ed8"],
    ["error", "#ba1a1a"],
  ])("--color-%s is %s", (name, value) => {
    expect(token(name).toLowerCase()).toBe(value);
  });

  it("the unused primary* roles are gone, leaving one accent", () => {
    expect(lightTokens).not.toMatch(/--color-(on-)?primary/);
  });

  it.each([
    ["radius-control", "8px"],
    ["radius-panel", "12px"],
    ["radius-dialog", "16px"],
    ["radius-full", "9999px"],
    ["z-sticky", "10"],
    ["z-header", "20"],
    ["z-drawer-scrim", "40"],
    ["z-drawer", "50"],
  ])("--%s is %s", (name, value) => {
    expect(css).toMatch(new RegExp(`--${name}\\s*:\\s*${value}\\s*;`));
  });

  it.each(["duration-instant", "duration-fast", "duration-normal", "duration-slow", "ease-out", "ease-in-out", "ease-emphasized"])(
    "motion token --%s is defined",
    (name) => {
      expect(css).toMatch(new RegExp(`--${name}\\s*:`));
    },
  );

  it.each([
    ["caption", "0.75rem"],
    ["body-sm", "0.8125rem"],
    ["body", "0.875rem"],
    ["emphasis", "1rem"],
    ["section", "1.125rem"],
    ["page-title", "1.5rem"],
    ["metric", "1.875rem"],
  ])("type role --text-%s is %s", (name, value) => {
    expect(css).toMatch(new RegExp(`--text-${name}\\s*:\\s*${value}\\s*;`));
  });

  it("introduces no type role below 12px", () => {
    const sizes = [...css.matchAll(/--text-[a-z-]+?\s*:\s*([\d.]+)rem\s*;/g)].map((m) => Number(m[1]) * 16);
    expect(sizes.length).toBeGreaterThan(0);
    for (const px of sizes) expect(px).toBeGreaterThanOrEqual(12);
  });
});

describe("design tokens: text contrast ≥ 4.5:1", () => {
  it.each(["on-surface", "on-surface-variant", "outline", "secondary", "success", "warning", "info", "error", "neutral"])(
    "%s text on every light surface",
    (name) => {
      for (const surface of SURFACES) expect(contrast(token(name), token(surface))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(["success", "warning", "info", "error", "neutral"])("on-%s-container text on its container", (tone) => {
    expect(contrast(token(`on-${tone}-container`), token(`${tone}-container`))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["secondary", "success", "warning", "info", "error", "neutral"])("on-%s text on a solid %s fill", (tone) => {
    expect(contrast(token(`on-${tone}`), token(tone))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("design tokens: non-text contrast ≥ 3:1", () => {
  it("control borders against every light surface", () => {
    for (const surface of SURFACES) expect(contrast(token("border-control"), token(surface))).toBeGreaterThanOrEqual(3);
  });

  it("the focus ring against every light surface", () => {
    for (const surface of SURFACES) expect(contrast(token("focus-ring"), token(surface))).toBeGreaterThanOrEqual(3);
  });

  it.each([1, 2, 3, 4, 5, 6])("chart-%i against white", (n) => {
    expect(contrast(token(`chart-${n}`), "#ffffff")).toBeGreaterThanOrEqual(3);
  });
});

describe("design tokens: focus and reduced motion foundation", () => {
  it("draws a visible focus ring for :focus-visible", () => {
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*var\(--focus-ring-width\) solid var\(--color-focus-ring\);/);
  });

  it("zeroes the motion tokens and stops animation under prefers-reduced-motion", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const name of ["instant", "fast", "normal", "slow"]) expect(reduced).toMatch(new RegExp(`--duration-${name}:\\s*0ms`));
    expect(reduced).toMatch(/animation-duration:\s*0\.01ms !important/);
    expect(reduced).toMatch(/transition-duration:\s*0\.01ms !important/);
  });
});

describe("StatusBadge: academic-period lifecycle", () => {
  const render = (status: string) => renderToStaticMarkup(createElement(StatusBadge, { status }));

  it.each([
    ["planned", "info"],
    ["active", "success"],
    ["closed", "neutral"],
    ["reopened", "warning"],
  ])("%s renders as %s", (status, tone) => {
    expect(statusTone(status)).toBe(tone);
    expect(render(status)).toContain(`bg-${tone}-container text-on-${tone}-container`);
  });

  it("closed is never shown as an error, and carries a lock", () => {
    const html = render("closed");
    expect(html).not.toMatch(/error/);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"[^>]*data-icon="lock"/);
    expect(html).toContain(">closed</span>");
  });

  it("no other lifecycle state carries the lock", () => {
    for (const status of ["planned", "active", "reopened"]) expect(render(status)).not.toContain('data-icon="lock"');
  });

  it("always shows the status as words, not only a colour", () => {
    expect(render("info_requested")).toContain(">info requested</span>");
  });

  it("an unknown status — including an Object.prototype key — is neutral", () => {
    expect(statusTone("something_new")).toBe("neutral");
    expect(statusTone("constructor")).toBe("neutral");
  });
});
